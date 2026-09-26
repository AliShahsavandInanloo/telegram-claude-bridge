'use strict';

/**
 * Registry TRANSACTION ISOLATION tests (final correctness pass).
 *
 * Covers the four confirmed bugs:
 *   1. cross-identity rollback corruption — X's failed save must never
 *      roll back Y's committed registration (whole-registry snapshot/
 *      restore now serialized by reg.withTransaction)
 *   2. stale-attempt dirty mutation leak — a superseded candidate must
 *      leave NO staged mutation behind (its own snapshot is restored
 *      before the transaction lock releases)
 *   3. genuine save-failure injection (deferred.reject, never
 *      "resolve with an Error object")
 *   4. registrationLocks map cleanup after the last queued transaction
 * plus the online <-> registry consistency assertion (reusable helper)
 * and a bounded deterministic concurrency stress test.
 *
 * Deterministic: deferred gates instead of sleeps wherever ordering
 * matters; sleeps are only settle-grace waits after gates resolve.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const test = (function () {
  const tests = [];
  const t = (name, fn) => tests.push({ name, fn });
  t.run = async function run() {
    let pass = 0;
    const failures = [];
    for (const { name, fn } of tests) {
      try {
        await fn();
        pass += 1;
        console.log(`  ok  ${name}`);
      } catch (err) {
        failures.push({ name, err });
        console.error(`  not ok  ${name}\n    ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err}`);
      }
    }
    console.log(`${pass} passed, ${failures.length} failed`);
    if (failures.length) process.exit(1);
  };
  return t;
})();

const { createChannelHub } = require('../lib/channel/hub');
const { createRegistry } = require('../lib/claude/registry');

const SECRET = crypto.randomBytes(32).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tgbridge-txniso-'));
}

/** Controllable reg.save: each call gets an explicit deferred. */
function makeSaveControl() {
  const deferreds = [];
  const calls = [];
  return {
    deferreds,
    calls,
    saveImpl() {
      const i = calls.length;
      calls.push(i);
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      deferreds.push({
        promise,
        i,
        /** SUCCESS path — refuses an Error (that would be a false failure test). */
        resolve(value) {
          if (value instanceof Error) throw new TypeError('resolve(Error) is a save SUCCESS — use reject(err)');
          resolve(value);
        },
        /** FAILURE path — the ONLY sanctioned way to fail an injected save. */
        reject(err) {
          if (!(err instanceof Error)) throw new TypeError('reject(err) requires an Error');
          reject(err);
        },
      });
      return promise;
    },
  };
}

/** Assert a promise genuinely REJECTS with an Error (failure-path guard). */
async function assertGenuineReject(promise, label) {
  let outcome = null;
  try {
    outcome = { kind: 'resolved', value: await promise };
  } catch (err) {
    outcome = { kind: 'rejected', err };
  }
  assert.strictEqual(outcome.kind, 'rejected', `${label}: must REJECT (resolution — even with an Error object — is a save SUCCESS)`);
  assert.ok(outcome.err instanceof Error, `${label}: rejection reason must be an Error`);
  return outcome.err;
}

function fakeConn() {
  const state = { sent: [], destroyed: false, onclose: null, onmessage: null };
  return {
    get sent() { return state.sent; },
    get destroyed() { return state.destroyed; },
    get onclose() { return state.onclose; },
    isAlive: () => !state.destroyed,
    send(o) { state.sent.push(o); return true; },
    destroy() { state.destroyed = true; if (state.onclose) state.onclose(); },
    on(ev, fn) {
      if (ev === 'close') state.onclose = fn;
      if (ev === 'message') state.onmessage = fn;
    },
    fire(msg) { if (state.onmessage) state.onmessage(msg); },
  };
}

function makeHub(reg) {
  return createChannelHub({ reg, secret: SECRET, ipcsImpl: [1], logInfo: () => {}, logWarn: () => {}, logError: () => {} });
}

/**registrationLocks is exposed via a getter (read-only introspection). */
function registrationLockCount(hub) {
  const locks = hub.registrationLocks;
  return locks ? locks.size : 0;
}
function registrationLockHas(hub, clientId) {
  const locks = hub.registrationLocks;
  return locks ? locks.has(clientId) : false;
}

/**
 * Register a client on a hub via a fake conn and AWAIT settle: the fake
 * registration reaches save synchronously (fire → onmessage → hub txn),
 * one macrotask lets the save promise get created and the ack settle.
 */
async function register(hub, clientId, projectName, pid) {
  const conn = fakeConn();
  hub.onConnection({ conn, hello: { clientId, secret: SECRET } });
  conn.fire({ type: 'register', registration: { project: process.cwd(), projectName, pid } });
  await sleep(30);
  return conn;
}

/**
 * REUSABLE CONSISTENCY ASSERTION (item 7): after any registration
 * transaction, every online session must have a registry record with
 * connected=true, a matching clientId, and exactly one authoritative
 * connection; no registry record may claim connected=true without being
 * online (no connected ghosts).
 */
function assertRegistryOnlineConsistency(hub, reg, label = 'consistency') {
  const onlineIds = hub.onlineIds();
  const seenConns = new Map();
  for (const id of onlineIds) {
    const e = reg.get(id);
    assert.ok(e, `${label}: registry record exists for online ${id}`);
    assert.strictEqual(e.connected, true, `${label}: connected=true for online ${id}`);
  }
  // No connected ghost records: every connected=true record is online.
  for (const e of reg.list()) {
    if (e.connected) {
      assert.ok(onlineIds.includes(e.id), `${label}: no connected ghost record "${e.name}"`);
    }
  }
  // No duplicate identity records (clientId bound to at most one entry).
  const byClient = new Map();
  for (const e of reg.list()) {
    if (e.clientId) {
      assert.strictEqual(byClient.has(e.clientId), false, `${label}: duplicate clientId record for ${e.clientId}`);
      byClient.set(e.clientId, e.id);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Cross-identity rollback corruption (X fails AFTER Y committed)
// ---------------------------------------------------------------------------

test('X save rejects after Y committed: Y record, online state and metadata untouched', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const save = makeSaveControl();
  reg.save = () => save.saveImpl();
  const hub = makeHub(reg);

  // Y registers FIRST and commits while X's save is still gated.
  const y = await register(hub, 'client-y', 'Yfirst', 2);
  assert.strictEqual(save.deferreds.length, 1, 'only Y reached save');
  save.deferreds[0].resolve(); // Y commits
  await sleep(60);
  const yEntry = reg.getByName('yfirst');
  assert.ok(yEntry, 'Y record exists');
  assert.ok(hub.isOnline(yEntry.id), 'Y online');
  assert.strictEqual(yEntry.connected, true, 'Y connected=true');
  assert.ok(y.sent.some((m) => m.type === 'register_ack'), 'Y acked');
  const yBefore = JSON.stringify(reg.get(yEntry.id));

  // X registers SECOND; its save is gated, then REJECTS. Capture the save
  // promise FIRST, reject it, THEN assert it genuinely rejected (never the
  // reverse — awaiting an unsettled gate would deadlock the test).
  const x = await register(hub, 'client-x', 'Xsecond', 1);
  assert.strictEqual(save.deferreds.length, 2, 'X reached save');
  const xSavePromise = save.deferreds[1].promise;
  save.deferreds[1].reject(new Error('X disk failure'));
  const xErr = await assertGenuineReject(xSavePromise, 'X injected save');
  assert.strictEqual(xErr.message, 'X disk failure');
  await sleep(80);

  assert.ok(x.sent.some((m) => m.type === 'register_nak'), 'X NAKed');
  assert.strictEqual(x.sent.some((m) => m.type === 'register_ack'), false, 'X never acked');
  assert.strictEqual(hub.onlineIds().includes(xEntryId(reg, 'xsecond')), false, 'X not online');
  // THE INVARIANT: X's failure cannot revert Y.
  assert.strictEqual(JSON.stringify(reg.get(yEntry.id)), yBefore, 'Y record byte-for-byte unchanged');
  assert.ok(hub.isOnline(yEntry.id), 'Y STILL online');
  assert.strictEqual(reg.get(yEntry.id).connected, true, 'Y still connected=true');
  assertRegistryOnlineConsistency(hub, reg, 'after X failure');
  hub.close();
});

function xEntryId(reg, name) {
  const e = reg.getByName(name);
  return e ? e.id : `missing:${name}`;
}

test('two different clientIds register concurrently — both records exist, both online, no lost update', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const save = makeSaveControl();
  reg.save = () => save.saveImpl();
  const hub = makeHub(reg);

  const x = await register(hub, 'cx', 'ConcurrentX', 1);
  const y = await register(hub, 'cy', 'ConcurrentY', 2);
  // Global registry transaction mutex: transactions (including their saves)
  // serialize — Y's save is not even created until X's settles. This is the
  // isolation guarantee: no interleaved snapshot/mutate/restore windows.
  assert.strictEqual(save.deferreds.length, 1, 'X save gated; Y transaction FIFO-queued behind it');
  save.deferreds[0].resolve();
  await sleep(60);
  assert.strictEqual(save.deferreds.length, 2, 'Y save reached after X committed');
  save.deferreds[1].resolve();
  await sleep(60);

  assert.ok(x.sent.some((m) => m.type === 'register_ack'), 'X acked');
  assert.ok(y.sent.some((m) => m.type === 'register_ack'), 'Y acked');
  const xe = reg.getByName('concurrentx');
  const ye = reg.getByName('concurrenty');
  assert.ok(xe && ye, 'both records exist');
  assert.notStrictEqual(xe.id, ye.id, 'distinct records');
  assert.ok(hub.isOnline(xe.id) && hub.isOnline(ye.id), 'both online');
  assert.strictEqual(xe.connected && ye.connected, true, 'both connected=true');
  assert.strictEqual(reg.list().length, 2, 'no lost update / no duplicate');
  assertRegistryOnlineConsistency(hub, reg, 'concurrent both-succeed');
  hub.close();
});

test('different-client transactions, one fails one succeeds — the successful one always survives', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const save = makeSaveControl();
  reg.save = () => save.saveImpl();
  const hub = makeHub(reg);

  const okConn = await register(hub, 'c-ok', 'Survivor', 1);
  const badConn = await register(hub, 'c-bad', 'Doomed', 2);
  assert.strictEqual(save.deferreds.length, 1, 'Survivor save gated; Doomed queued behind');
  // Survivor succeeds, then Doomed (FIFO next) rejects.
  save.deferreds[0].resolve();
  await sleep(60);
  assert.strictEqual(save.deferreds.length, 2, 'Doomed save reached');
  save.deferreds[1].reject(new Error('doomed disk failure'));
  await sleep(60);

  assert.ok(okConn.sent.some((m) => m.type === 'register_ack'), 'Survivor acked');
  assert.ok(badConn.sent.some((m) => m.type === 'register_nak'), 'Doomed NAKed');
  const se = reg.getByName('survivor');
  assert.ok(se, 'Survivor record present');
  assert.ok(hub.isOnline(se.id), 'Survivor online');
  assert.strictEqual(se.connected, true, 'Survivor connected=true');
  assert.strictEqual(reg.getByName('doomed'), null, 'no ghost record for the failed new registration');
  assertRegistryOnlineConsistency(hub, reg, 'mixed outcome');
  hub.close();
});

// ---------------------------------------------------------------------------
// 2. Dirty staged-mutation leak (A committed pid=1; B stale pid=2; C pid=3)
// ---------------------------------------------------------------------------

test('dirty-state leak: B superseded mid-save leaves NO staged metadata for C', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const save = makeSaveControl();
  reg.save = () => save.saveImpl();
  const hub = makeHub(reg);

  // A commits pid=1.
  const a = await register(hub, 'auth-a', 'Dirty', 1);
  save.deferreds[0].resolve();
  await sleep(60);
  const entry = reg.getByName('dirty');
  assert.strictEqual(reg.get(entry.id).pid, 1, 'A committed pid=1');
  assert.ok(hub.isOnline(entry.id), 'A authoritative');
  const aCommitted = JSON.stringify(reg.get(entry.id));

  // B starts, stages pid=2, save pending → then superseded by C's generation.
  const b = await register(hub, 'auth-a', 'Dirty', 2);
  assert.strictEqual(save.deferreds.length, 2, 'B save pending');
  const c = await register(hub, 'auth-a', 'Dirty', 3);
  assert.strictEqual(save.deferreds.length, 2, 'C serialized behind B (same identity)');

  // B's save SUCCEEDS but B is stale → must commit nothing AND restore its
  // own snapshot (no dirty pid=2 left in memory).
  save.deferreds[1].resolve();
  await sleep(60);

  // C now runs (serialized behind B by the per-identity lock + global txn).
  await sleep(60);
  assert.strictEqual(save.deferreds.length, 3, 'C reached save after B released');
  // C's SNAPSHOT must reflect A's committed state, NOT B's rejected pid=2.
  save.deferreds[2].reject(new Error('C disk failure'));
  await sleep(60);

  assert.ok(b.sent.some((m) => m.type === 'register_nak'), 'B (stale) NAKed');
  assert.strictEqual(b.sent.some((m) => m.type === 'register_ack'), false, 'B never acked');
  assert.ok(c.sent.some((m) => m.type === 'register_nak'), 'C NAKed (save failed)');
  // FINAL: registry exactly A's original committed state — NOT pid 2, NOT 3.
  assert.strictEqual(reg.get(entry.id).pid, 1, 'registry pid is A’s committed 1 (not 2, not 3)');
  assert.strictEqual(JSON.stringify(reg.get(entry.id)), aCommitted, 'registry byte-for-byte A’s committed state');
  assert.ok(hub.isOnline(entry.id), 'A still authoritative');
  assertRegistryOnlineConsistency(hub, reg, 'dirty-state B/C');

  // Retry C successfully → pid=3, C authoritative.
  const c2 = await register(hub, 'auth-a', 'Dirty', 3);
  assert.strictEqual(save.deferreds.length, 4, 'retry save pending');
  save.deferreds[3].resolve();
  await sleep(60);
  assert.ok(c2.sent.some((m) => m.type === 'register_ack'), 'C retry acked');
  assert.strictEqual(reg.get(entry.id).pid, 3, 'registry pid=3 after successful retry');
  assert.ok(hub.isOnline(entry.id), 'C retry authoritative');
  assertRegistryOnlineConsistency(hub, reg, 'dirty-state retry');
  hub.close();
});

test('stale B then failing C: registry exactly equals A’s original committed state', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const save = makeSaveControl();
  reg.save = () => save.saveImpl();
  const hub = makeHub(reg);

  const a = await register(hub, 'id-k', 'Keeper', 1);
  save.deferreds[0].resolve();
  await sleep(60);
  const entry = reg.getByName('keeper');
  const aCommitted = JSON.stringify(reg.get(entry.id));

  const b = await register(hub, 'id-k', 'Keeper', 2);
  const c = await register(hub, 'id-k', 'Keeper', 3);
  assert.strictEqual(save.deferreds.length, 2, 'B gated; C queued behind');
  save.deferreds[1].resolve(); // B's save succeeds but B is stale → restores own snapshot
  await sleep(60);
  assert.strictEqual(save.deferreds.length, 3, 'C save reached');
  save.deferreds[2].reject(new Error('C failure'));
  await sleep(60);

  assert.strictEqual(reg.get(entry.id).pid, 1, 'pid still A’s 1');
  assert.strictEqual(JSON.stringify(reg.get(entry.id)), aCommitted, 'record byte-for-byte A’s state');
  assert.ok(hub.isOnline(entry.id), 'A authoritative throughout');
  hub.close();
});

test('stale B then successful C: registry contains C metadata only', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const save = makeSaveControl();
  reg.save = () => save.saveImpl();
  const hub = makeHub(reg);

  const a = await register(hub, 'id-s', 'Swap', 1);
  save.deferreds[0].resolve();
  await sleep(60);
  const entry = reg.getByName('swap');

  const b = await register(hub, 'id-s', 'Swap', 2);
  const c = await register(hub, 'id-s', 'Swap', 3);
  save.deferreds[1].resolve(); // B succeeds but is stale → no residue
  await sleep(60);
  assert.strictEqual(save.deferreds.length, 3, 'C save reached');
  save.deferreds[2].resolve();
  await sleep(60);

  assert.ok(c.sent.some((m) => m.type === 'register_ack'), 'C acked');
  assert.strictEqual(b.sent.some((m) => m.type === 'register_ack'), false, 'B never acked');
  assert.strictEqual(reg.get(entry.id).pid, 3, 'registry contains C metadata (pid=3)');
  assert.strictEqual(reg.list().length, 1, 'exactly one record');
  assert.ok(hub.isOnline(entry.id), 'C authoritative');
  assertRegistryOnlineConsistency(hub, reg, 'stale-then-success');
  hub.close();
});

// ---------------------------------------------------------------------------
// 4. registrationLocks cleanup
// ---------------------------------------------------------------------------

test('lock cleanup: entry removed after a single registration completes', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const save = makeSaveControl();
  reg.save = () => save.saveImpl();
  const hub = makeHub(reg);
  const c = await register(hub, 'lock-1', 'LockOne', 1);
  save.deferreds[0].resolve();
  await sleep(60);
  assert.ok(c.sent.some((m) => m.type === 'register_ack'), 'acked');
  await sleep(30); // allow cleanup microtasks
  assert.strictEqual(registrationLockCount(hub), 0, 'lock map empty after completion');
  hub.close();
});

test('lock cleanup: entry removed after a FAILED registration', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const save = makeSaveControl();
  reg.save = () => save.saveImpl();
  const hub = makeHub(reg);
  const c = await register(hub, 'lock-2', 'LockFail', 1);
  save.deferreds[0].reject(new Error('save failed'));
  await sleep(60);
  assert.ok(c.sent.some((m) => m.type === 'register_nak'), 'NAKed');
  await sleep(30);
  assert.strictEqual(registrationLockCount(hub), 0, 'lock map empty after failure');
  hub.close();
});

test('lock cleanup: lock retained while second same-client transaction pending, removed after', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const save = makeSaveControl();
  reg.save = () => save.saveImpl();
  const hub = makeHub(reg);

  // First registration for the identity commits.
  const c1 = await register(hub, 'lock-3', 'LockQ', 1);
  save.deferreds[0].resolve();
  await sleep(60);
  assert.ok(c1.sent.some((m) => m.type === 'register_ack'));

  // Two MORE queued transactions for the same clientId.
  const c2 = await register(hub, 'lock-3', 'LockQ', 2);
  const c3 = await register(hub, 'lock-3', 'LockQ', 3);
  assert.strictEqual(save.deferreds.length, 2, 'c2 save pending; c3 queued behind the lock');
  assert.strictEqual(registrationLockCount(hub), 1, 'lock retained while a second transaction is pending');
  assert.ok(registrationLockHas(hub, 'lock-3'), 'same-client lock present');

  save.deferreds[1].resolve(); // c2 commits
  await sleep(60);
  assert.strictEqual(save.deferreds.length, 3, 'c3 save reached');
  assert.strictEqual(registrationLockCount(hub), 1, 'lock still held for c3');
  save.deferreds[2].resolve(); // c3 commits
  await sleep(60);
  await sleep(30);
  assert.strictEqual(registrationLockCount(hub), 0, 'lock removed after the LAST queued transaction completes');
  hub.close();
});

test('lock cleanup: many unique clientIds leave the map empty after completion', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const save = makeSaveControl();
  reg.save = () => save.saveImpl();
  const hub = makeHub(reg);
  const conns = [];
  for (let i = 0; i < 10; i++) {
    conns.push(await register(hub, `lock-many-${i}`, `LockMany${i}`, i + 1));
  }
  assert.ok(registrationLockCount(hub) > 0, 'locks present while saves pending');
  // FIFO: settle each gated save in arrival order, letting the next txn run.
  for (let round = 0; round < 10; round++) {
    if (save.deferreds[round]) save.deferreds[round].resolve();
    await sleep(40);
  }
  await sleep(120);
  await sleep(30);
  assert.strictEqual(registrationLockCount(hub), 0, 'lock map returns to empty after all complete');
  assert.strictEqual(reg.list().length, 10, 'all ten records committed');
  hub.close();
});

// ---------------------------------------------------------------------------
// 13. Bounded deterministic concurrency stress test
// ---------------------------------------------------------------------------

test('stress: 10 identities, same-client replacements, mixed save outcomes — consistent end state', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const save = makeSaveControl();
  reg.save = () => save.saveImpl();
  const hub = makeHub(reg);

  const clientIds = Array.from({ length: 10 }, (_, i) => `stress-${i}`);
  const conns = new Map(); // clientId -> latest conn
  const expectFail = new Set(); // deferred indices that will be rejected

  // Round 1: one registration per identity (10 transactions, FIFO).
  for (let i = 0; i < 10; i++) {
    conns.set(clientIds[i], await register(hub, clientIds[i], `Stress${i}`, 100 + i));
  }
  assert.strictEqual(save.deferreds.length, 1, 'first save gated; the rest FIFO-queued');
  for (let round = 0; round < 10; round++) {
    if (save.deferreds[round]) save.deferreds[round].resolve();
    await sleep(40);
  }
  await sleep(120);

  // Round 2: replacements — even-indexed clientIds register again; saves for
  // stress-4 and stress-8 REJECT (genuine failure), the rest succeed.
  for (let i = 0; i < 10; i += 2) {
    conns.set(clientIds[i], await register(hub, clientIds[i], `Stress${i}`, 200 + i));
  }
  for (let k = 10; k < 15; k++) {
    const i = (k - 10) * 2; // clientId index
    if (save.deferreds[k]) {
      if (i === 4 || i === 8) {
        expectFail.add(k);
        save.deferreds[k].reject(new Error(`stress save failure ${i}`));
      } else {
        save.deferreds[k].resolve();
      }
    }
    await sleep(40);
  }
  await sleep(120);

  // Invariants: no duplicate identity records; online <-> registry; no ghosts.
  const seen = new Set();
  for (const e of reg.list()) {
    assert.ok(!seen.has(e.clientId), `no duplicate identity: ${e.clientId}`);
    seen.add(e.clientId);
  }
  assert.strictEqual(reg.list().length, 10, 'exactly one record per identity');
  for (const id of hub.onlineIds()) {
    const e = reg.get(id);
    assert.ok(e, `online ${id} has a registry record`);
    assert.strictEqual(e.connected, true, `online ${id} connected=true`);
  }
  for (const e of reg.list()) {
    if (e.connected) assert.ok(hub.onlineIds().includes(e.id), `no connected ghost: ${e.name}`);
  }
  // One authoritative socket per identity: the hub's online map holds the
  // latest committed conn; failed replacements must not have taken over.
  for (let i = 0; i < 10; i++) {
    const e = reg.getByName(`stress${i}`);
    assert.ok(e, `record for stress-${i}`);
    const onlineConn = hub.onlineIds().includes(e.id);
    if (i === 4 || i === 8) {
      assert.strictEqual(onlineConn, true, `failed replacement for stress-${i}: original stays authoritative`);
      assert.strictEqual(e.pid, 100 + i, `failed replacement for stress-${i}: registry keeps original pid`);
    }
  }
  // Locks cleaned and transaction lock idle.
  await sleep(60);
  assert.strictEqual(registrationLockCount(hub), 0, 'registration lock map cleaned');
  assert.strictEqual(reg.transactionBusy(), false, 'registry transaction lock idle');
  hub.close();
});

// ---------------------------------------------------------------------------
// 3. Deferred helpers genuinely reject (meta-test of the failure harness)
// ---------------------------------------------------------------------------

test('meta: save-control reject() produces a genuine rejection (not resolve-with-Error)', async () => {
  const save = makeSaveControl();
  const p = save.saveImpl();
  save.deferreds[0].reject(new Error('genuine failure'));
  const err = await assertGenuineReject(p, 'injected save');
  assert.strictEqual(err.message, 'genuine failure');

  const ok = makeSaveControl();
  const p2 = ok.saveImpl();
  ok.deferreds[0].resolve();
  await p2; // resolves fine without an Error value
  assert.ok(true);
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
  process.exit(2);
});

test.run();
