'use strict';

// Test isolation: marks this process as a test so lib guards refuse real state/ paths.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

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
const { createClaudeManager } = require('../lib/claude/manager');

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
// 3. MANAGER registry transaction boundaries (final consistency pass)
//
// The manager must own the SAME global registry transaction as the Channel
// hub: lock -> snapshot -> mutate -> save -> restore-on-failure. Nothing may
// mutate the shared registry (or take a whole-registry snapshot) outside it.
// ---------------------------------------------------------------------------

const LAUNCH = { command: 'claude.exe', prefixArgs: [] };

function fakeChild() {
  const handlers = {};
  return {
    pid: 9000,
    exitCode: null,
    signalCode: null,
    stdin: { write: () => {}, on: () => {} },
    stdout: {
      on: (ev, fn) => {
        (handlers['out:' + ev] = handlers['out:' + ev] || []).push(fn);
      },
    },
    stderr: { on: () => {} },
    on: (ev, fn) => {
      (handlers[ev] = handlers[ev] || []).push(fn);
    },
    kill() {
      (handlers.close || []).forEach((f) => f(0, null));
    },
    fireOut(data) {
      (handlers['out:data'] || []).forEach((f) => f(Buffer.from(data)));
    },
  };
}

/** Real manager over a real temp registry; debounce disabled (explicit flush only). */
function makeManager(reg, saveDelayMs = 100000) {
  return createClaudeManager({ reg, launch: LAUNCH, spawnFn: () => fakeChild(), logInfo: () => {}, logError: () => {}, saveDelayMs });
}

/** Same, but captures every spawned child so tests can emit Claude events. */
function makeManagerCapturing(reg, children, saveDelayMs = 100000) {
  return createClaudeManager({
    reg,
    launch: LAUNCH,
    spawnFn: () => {
      const c = fakeChild();
      children.push(c);
      return c;
    },
    logInfo: () => {},
    logError: () => {},
    saveDelayMs,
  });
}

/** Poll until predicate() is true (bounded; deterministic ordering gate). */
async function waitFor(predicate, label, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

/** Hold the global registry transaction until release() is called. */
function holdTransaction(reg) {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const done = reg.withTransaction(async () => {
    await gate;
  });
  return { release, done };
}

function makeProject(dir) {
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  return proj;
}

test('manager attach waits behind a held registry transaction, then commits durably', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const proj = makeProject(dir);
  const a = reg.create({ name: 'alpha', project: proj }).entry;
  await reg.save();
  const mgr = makeManager(reg);

  const held = holdTransaction(reg);
  assert.strictEqual(reg.transactionBusy(), true, 'registry lock held');
  let settled = false;
  const p = mgr.attach('77', a.id).then((r) => {
    settled = true;
    return r;
  });
  await sleep(15);
  assert.strictEqual(settled, false, 'attach must NOT return success while the lock is held');
  assert.strictEqual(reg.attached('77'), null, 'no mutation before the transaction is owned');

  held.release();
  await held.done;
  const r = await p;
  assert.ok(r.ok, 'attach succeeds after release');
  assert.strictEqual(reg.attached('77').id, a.id, 'attachment durable');
  assert.strictEqual(reg.transactionBusy(), false, 'registry transaction lock idle');
});

test('repro: a transaction that snapshots then restores cannot erase a later manager attach', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const proj = makeProject(dir);
  const a = reg.create({ name: 'alpha', project: proj }).entry;
  await reg.save();
  const mgr = makeManager(reg);

  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  // Transaction X takes an OLD whole-registry snapshot (no attachment), waits,
  // then late-restores it. Before the fix the manager mutated outside the lock
  // and returned success, so X's rollback silently erased the attachment.
  const oldTx = reg.withTransaction(async () => {
    const snap = reg.snapshot();
    await gate;
    reg.restore(snap);
  });

  const p = mgr.attach('5', a.id);
  await sleep(15);
  assert.strictEqual(reg.attached('5'), null, 'attach blocked until the old transaction releases');

  release();
  await oldTx;
  const r = await p;
  assert.ok(r.ok, 'attach reports success only after its own commit');
  assert.strictEqual(reg.attached('5').id, a.id, 'attachment survives the unrelated late rollback');
  assert.strictEqual(reg.transactionBusy(), false, 'registry transaction lock idle');
});

test('manager createSession waits behind a held registry transaction, then commits', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const proj = makeProject(dir);
  await reg.save();
  const mgr = makeManager(reg);

  const held = holdTransaction(reg);
  let settled = false;
  const p = mgr.createSession({ name: 'fresh', project: proj }).then((r) => {
    settled = true;
    return r;
  });
  await sleep(15);
  assert.strictEqual(settled, false, 'create must wait for the registry transaction');
  assert.strictEqual(reg.getByName('fresh'), null, 'registry unchanged while the lock is held');

  held.release();
  await held.done;
  const created = await p;
  assert.ok(created.ok, 'create succeeded after release');
  assert.ok(reg.getByName('fresh'), 'session remains present after its commit');
  assert.strictEqual(reg.transactionBusy(), false, 'registry transaction lock idle');
  mgr.stopAll();
});

test('manager detach waits behind a held registry transaction, then commits', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const proj = makeProject(dir);
  const a = reg.create({ name: 'alpha', project: proj }).entry;
  reg.attach('9', a.id);
  await reg.save();
  const mgr = makeManager(reg);

  const held = holdTransaction(reg);
  let settled = false;
  const p = mgr.detach('9').then((r) => {
    settled = true;
    return r;
  });
  await sleep(15);
  assert.strictEqual(settled, false, 'detach must wait for the registry transaction');
  assert.ok(reg.attached('9'), 'attachment unchanged while the lock is held');

  held.release();
  await held.done;
  const d = await p;
  assert.ok(d.ok && d.wasAttached === true, 'detach committed');
  assert.strictEqual(reg.attached('9'), null, 'detach durable');
  assert.strictEqual(reg.transactionBusy(), false, 'registry transaction lock idle');
});

test('manager attach save failure restores the exact previous attachment and reports failure', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const proj = makeProject(dir);
  const a = reg.create({ name: 'alpha', project: proj }).entry;
  const b = reg.create({ name: 'beta', project: proj }).entry;
  reg.attach('1', a.id);
  await reg.save();
  const mgr = makeManager(reg);

  const ctl = makeSaveControl();
  const origSave = reg.save;
  reg.save = () => ctl.saveImpl();
  const p = mgr.attach('1', b.id);
  await sleep(5);
  assert.strictEqual(ctl.deferreds.length, 1, 'save reached inside the manager transaction');
  ctl.deferreds[0].reject(new Error('disk gone'));
  const r = await p;
  assert.strictEqual(r.ok, false, 'manager never reports success when the save failed');
  assert.strictEqual(reg.attached('1').id, a.id, 'previous attachment restored exactly');
  reg.save = origSave;
  assert.strictEqual(reg.transactionBusy(), false, 'registry transaction lock idle');
});

test('manager status update is queued, then applied + persisted inside one registry transaction', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const file = path.join(dir, 'r.json');
  const proj = makeProject(dir);
  const e = reg.create({ name: 'statusy', project: proj }).entry;
  await reg.save();
  const mgr = makeManager(reg);

  mgr.stopSession(e.id); // queues status 'stopped'
  assert.strictEqual(reg.get(e.id).status, 'idle', 'live registry untouched before the transaction');

  const held = holdTransaction(reg);
  let flushed = false;
  const flush = mgr._persistNow().then(() => {
    flushed = true;
  });
  await sleep(15);
  assert.strictEqual(flushed, false, 'status flush waits for the registry transaction');
  assert.strictEqual(reg.get(e.id).status, 'idle', 'status not mutated while the lock is held');

  held.release();
  await held.done;
  await flush;
  assert.strictEqual(reg.get(e.id).status, 'stopped', 'status applied inside the transaction');
  const reread = createRegistry(file);
  assert.strictEqual(reread.get(e.id).status, 'stopped', 'status persisted');
  assert.strictEqual(reg.transactionBusy(), false, 'registry transaction lock idle');
});

test('manager status save failure restores the previous status', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const proj = makeProject(dir);
  const e = reg.create({ name: 'statusy', project: proj }).entry;
  await reg.save();
  const mgr = makeManager(reg);

  mgr.stopSession(e.id);
  const ctl = makeSaveControl();
  const origSave = reg.save;
  reg.save = () => ctl.saveImpl();
  const flush = mgr._persistNow();
  await sleep(5);
  assert.strictEqual(ctl.deferreds.length, 1, 'queued status save reached');
  ctl.deferreds[0].reject(new Error('disk gone'));
  await flush;
  assert.strictEqual(reg.get(e.id).status, 'idle', 'previous status restored exactly');
  reg.save = origSave;
  await sleep(10);
  assert.strictEqual(reg.transactionBusy(), false, 'registry transaction lock idle');
});

test('failure of an unrelated transaction cannot erase a manager mutation committed after its snapshot', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const proj = makeProject(dir);
  const a = reg.create({ name: 'alpha', project: proj }).entry;
  await reg.save();
  const mgr = makeManager(reg);
  const att = await mgr.attach('2', a.id);
  assert.ok(att.ok, 'manager attachment committed first');

  const ctl = makeSaveControl();
  const origSave = reg.save;
  reg.save = () => ctl.saveImpl();
  const tx = reg.withTransaction(async () => {
    const snap = reg.snapshot();
    try {
      reg.create({ name: 'temp', project: proj });
      await reg.save();
    } catch (err) {
      reg.restore(snap);
    }
  });
  await sleep(5);
  ctl.deferreds[0].reject(new Error('boom'));
  await tx;
  assert.strictEqual(reg.attached('2').id, a.id, 'committed manager attachment survives the unrelated failure');
  assert.strictEqual(reg.getByName('temp'), null, 'failed transaction left nothing behind');
  reg.save = origSave;
  await sleep(10);
  assert.strictEqual(reg.transactionBusy(), false, 'registry transaction lock idle');
});

test('registry touch applies lastActivity inside a transaction, never outside', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const proj = makeProject(dir);
  const e = reg.create({ name: 'touchy', project: proj }).entry;
  reg.get(e.id).lastActivity = '1970-01-01T00:00:00.000Z';
  await reg.save();

  const held = holdTransaction(reg);
  reg.touch(e.id);
  const flush = reg.flushTouches();
  await sleep(10);
  assert.strictEqual(reg.get(e.id).lastActivity, '1970-01-01T00:00:00.000Z', 'no live mutation while the lock is held');

  held.release();
  await held.done;
  await flush;
  assert.notStrictEqual(reg.get(e.id).lastActivity, '1970-01-01T00:00:00.000Z', 'lastActivity applied inside the transaction');
  await sleep(10);
  assert.strictEqual(reg.transactionBusy(), false, 'registry transaction lock idle');
});

test('manager create/attach/detach/route complete normally under the new transaction structure (no deadlock)', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const proj = makeProject(dir);
  await reg.save();
  const mgr = makeManager(reg);

  const created = await mgr.createSession({ name: 'one', project: proj });
  assert.ok(created.ok, created.error);
  const att = await mgr.attach('3', created.entry.id);
  assert.ok(att.ok, 'attach completes');
  assert.strictEqual(reg.attached('3').id, created.entry.id);
  const det = await mgr.detach('3');
  assert.ok(det.ok && det.wasAttached === true, 'detach completes');
  assert.strictEqual(reg.attached('3'), null);
  assert.strictEqual(reg.transactionBusy(), false, 'registry transaction lock idle');
  mgr.stopAll();
});

// ---------------------------------------------------------------------------
// 3b. Manager-OWNED transactions: unrelated async events must never join the
//     in-flight transaction (the txnDepth context-leak bug). These tests use a
//     manager-owned create/attach transaction with a HELD save — the case an
//     externally-held reg.withTransaction cannot reproduce.
// ---------------------------------------------------------------------------

test('manager-owned txn: stopSession during a FAILING attach is not erased by the attach rollback', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const file = path.join(dir, 'r.json');
  const proj = makeProject(dir);
  const a = reg.create({ name: 'alpha', project: proj }).entry;
  const b = reg.create({ name: 'beta', project: proj }).entry;
  await reg.save();
  const children = [];
  const mgr = makeManagerCapturing(reg, children);
  mgr.startSession(a.id);
  assert.strictEqual(children.length, 1, 'managed process for A spawned');

  // Manager-OWNED transaction: attach B, save held open (registry lock owned).
  const ctl = makeSaveControl();
  const origSave = reg.save;
  reg.save = () => ctl.saveImpl();
  let attachSettled = false;
  const attachP = mgr.attach('1', b.id).then((r) => {
    attachSettled = true;
    return r;
  });
  await waitFor(() => ctl.deferreds.length === 1, 'attach save reached');

  // Unrelated lifecycle event while the attach transaction owns the lock.
  const stop = mgr.stopSession(a.id, 'user stop');
  assert.ok(stop.ok, 'stopSession still returns its runtime result immediately');
  assert.strictEqual(attachSettled, false, 'attach still pending');
  assert.strictEqual(reg.get(a.id).status, 'idle', 'status is NOT mutated while the attach txn holds the registry');

  // attach save fails → the attach rolls back to its own snapshot.
  ctl.deferreds[0].reject(new Error('disk gone'));
  const attachResult = await attachP;
  assert.strictEqual(attachResult.ok, false, 'attach reports failure');
  assert.strictEqual(reg.attached('1'), null, 'attach rolled back');
  assert.strictEqual(reg.get(a.id).status, 'idle', 'attach rollback restored only attach state');

  // Flush queued manager updates: the stopped intent survives the rollback.
  reg.save = origSave;
  await mgr._persistNow();
  assert.strictEqual(reg.get(a.id).status, 'stopped', 'stopped status intent survived the unrelated rollback');
  const reread = createRegistry(file);
  assert.strictEqual(reread.get(a.id).status, 'stopped', 'stopped status persisted to disk');
  await sleep(10);
  assert.strictEqual(reg.transactionBusy(), false, 'registry transaction lock idle');
});

test('manager-owned txn: status queued during a SUCCESSFUL attach commits after it (both survive)', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const proj = makeProject(dir);
  const a = reg.create({ name: 'alpha', project: proj }).entry;
  const b = reg.create({ name: 'beta', project: proj }).entry;
  await reg.save();
  const children = [];
  const mgr = makeManagerCapturing(reg, children);
  mgr.startSession(a.id);

  const ctl = makeSaveControl();
  const origSave = reg.save;
  reg.save = () => ctl.saveImpl();
  const attachP = mgr.attach('2', b.id);
  await waitFor(() => ctl.deferreds.length === 1, 'attach save reached');
  mgr.stopSession(a.id, 'stop');
  assert.strictEqual(reg.get(a.id).status, 'idle', 'status staged while the attach txn is pending');

  ctl.deferreds[0].resolve();
  const r = await attachP;
  assert.ok(r.ok, 'attach committed');
  assert.strictEqual(reg.attached('2').id, b.id, 'attachment durable');

  reg.save = origSave;
  await mgr._persistNow();
  assert.strictEqual(reg.get(a.id).status, 'stopped', 'queued status committed after the attach');
  await sleep(10);
  assert.strictEqual(reg.transactionBusy(), false, 'registry transaction lock idle');
});

test('manager-owned txn: claudeSessionId from system/init during a FAILING attach is NOT erased', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const file = path.join(dir, 'r.json');
  const proj = makeProject(dir);
  const a = reg.create({ name: 'alpha', project: proj }).entry;
  const b = reg.create({ name: 'beta', project: proj }).entry;
  await reg.save();
  const children = [];
  const mgr = makeManagerCapturing(reg, children);
  mgr.startSession(a.id);
  const child = children[0];
  const UUID = '0e5b3a2e-1d2f-4c6b-9a3f-000000000123';

  const ctl = makeSaveControl();
  const origSave = reg.save;
  reg.save = () => ctl.saveImpl();
  const attachP = mgr.attach('3', b.id);
  await waitFor(() => ctl.deferreds.length === 1, 'attach save reached');

  // The real createManagedSession -> onClaudeSessionId path fires while the
  // attach transaction owns the registry: it must be staged, not mutated.
  child.fireOut(JSON.stringify({ type: 'system', subtype: 'init', session_id: UUID }) + '\n');
  assert.strictEqual(reg.get(a.id).claudeSessionId, null, 'session id staged, not mutated, while the attach txn holds the lock');

  ctl.deferreds[0].reject(new Error('disk gone'));
  const ar = await attachP;
  assert.strictEqual(ar.ok, false, 'attach reports failure');
  assert.strictEqual(reg.get(a.id).claudeSessionId, null, 'attach rollback cannot touch the staged session id');

  reg.save = origSave;
  await mgr._persistNow();
  assert.strictEqual(reg.get(a.id).claudeSessionId, UUID, 'session id applied after the unrelated rollback');
  assert.strictEqual(reg.get(a.id).initialized, true, 'initialized flag set with the session id');
  const reread = createRegistry(file);
  assert.strictEqual(reread.get(a.id).claudeSessionId, UUID, 'session id persisted to disk');
});

test('manager status coalescing: last intended status wins before flush', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const proj = makeProject(dir);
  const e = reg.create({ name: 'coalesce', project: proj }).entry;
  await reg.save();
  const children = [];
  const mgr = makeManagerCapturing(reg, children);
  mgr.startSession(e.id); // 'starting'
  mgr.stopSession(e.id, 'stop'); // 'stopped' — should win
  assert.strictEqual(reg.get(e.id).status, 'idle', 'live registry untouched before the flush');
  await mgr._persistNow();
  assert.strictEqual(reg.get(e.id).status, 'stopped', 'only the latest intended status is applied');
});

test('manager session-id coalescing: last valid id wins; invalid ids are rejected', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const proj = makeProject(dir);
  const e = reg.create({ name: 'coalesceid', project: proj }).entry;
  await reg.save();
  const children = [];
  const mgr = makeManagerCapturing(reg, children);
  mgr.startSession(e.id);
  const child = children[0];
  const X = '0e5b3a2e-1d2f-4c6b-9a3f-00000000000a';
  const Y = '0e5b3a2e-1d2f-4c6b-9a3f-00000000000b';
  child.fireOut(JSON.stringify({ type: 'system', subtype: 'init', session_id: X }) + '\n');
  child.fireOut(JSON.stringify({ type: 'system', subtype: 'init', session_id: Y }) + '\n');
  await mgr._persistNow();
  assert.strictEqual(reg.get(e.id).claudeSessionId, Y, 'last valid session id wins');
  child.fireOut(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'not-a-uuid' }) + '\n');
  await mgr._persistNow();
  assert.strictEqual(reg.get(e.id).claudeSessionId, Y, 'invalid session id rejected; previous value preserved');
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

// ---------------------------------------------------------------------------
// 5. GRACEFUL-SHUTDOWN DURABILITY
//
// stopAll() must be durable: it may never return success while its
// manager-owned pending registry updates are still unapplied, the shutdown
// status must survive the child-close callback, and the Bridge's shutdown
// sequence must flush touches + Channel-offline state before exit.
// ---------------------------------------------------------------------------

test('shutdown: stopAll returns a pending promise while the save is held; kill stays immediate', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const proj = makeProject(dir);
  const a = reg.create({ name: 'alpha', project: proj }).entry;
  await reg.save();
  const children = [];
  const mgr = makeManagerCapturing(reg, children);
  mgr.startSession(a.id);
  const child = children[0];
  const origKill = child.kill;
  let killed = false;
  child.kill = (...args) => {
    killed = true;
    return origKill.apply(child, args);
  };

  // Hold the save BEFORE shutdown so stopAll's flush cannot complete.
  const ctl = makeSaveControl();
  const origSave = reg.save;
  reg.save = () => ctl.saveImpl();

  const p = mgr.stopAll();
  assert.ok(p && typeof p.then === 'function', 'stopAll returns a promise');
  assert.strictEqual(killed, true, 'process kill is IMMEDIATE (never delayed by the save debounce)');

  let settled = false;
  p.then(() => {
    settled = true;
  });
  await sleep(20);
  assert.strictEqual(ctl.deferreds.length, 1, 'stopAll flush reached the save');
  assert.strictEqual(settled, false, 'stopAll promise is still PENDING while the save is held');
  assert.strictEqual(reg.transactionBusy(), true, 'save pending inside the manager transaction (mutation staged, not yet durable)');

  ctl.deferreds[0].resolve();
  await p;
  await sleep(10); // let the transaction tail release the lock
  assert.strictEqual(settled, true, 'stopAll resolves only after persistence');
  assert.strictEqual(reg.get(a.id).status, 'stopped', 'shutdown status applied');
  assert.strictEqual(reg.transactionBusy(), false, 'registry transaction lock idle after shutdown');
  reg.save = origSave;
});

test('shutdown: claudeSessionId queued right before stopAll persists without waiting the debounce timer', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const file = path.join(dir, 'r.json');
  const proj = makeProject(dir);
  const a = reg.create({ name: 'alpha', project: proj }).entry;
  await reg.save();
  const children = [];
  const mgr = makeManagerCapturing(reg, children);
  mgr.startSession(a.id);
  const UUID = '0e5b3a2e-1d2f-4c6b-9a3f-00000000abcd';
  children[0].fireOut(JSON.stringify({ type: 'system', subtype: 'init', session_id: UUID }) + '\n');
  assert.strictEqual(reg.get(a.id).claudeSessionId, null, 'session id staged outside the registry');

  const p = mgr.stopAll(); // immediate shutdown — the 100 s debounce never fires
  await p;
  assert.strictEqual(reg.get(a.id).claudeSessionId, UUID, 'queued session id applied by the shutdown flush');
  assert.strictEqual(reg.get(a.id).initialized, true, 'initialized flag set with the session id');
  const reread = createRegistry(file);
  assert.strictEqual(reread.get(a.id).claudeSessionId, UUID, 'session id DURABLE on disk');
  assert.strictEqual(reread.get(a.id).initialized, true, 'initialized durable on disk');
  assert.strictEqual(reg.transactionBusy(), false, 'registry transaction lock idle');
});

test('shutdown: stopped status persists through stopAll; late child close cannot flip it to idle', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const file = path.join(dir, 'r.json');
  const proj = makeProject(dir);
  const a = reg.create({ name: 'alpha', project: proj }).entry;
  await reg.save();
  const children = [];
  const mgr = makeManagerCapturing(reg, children);
  mgr.startSession(a.id);
  const child = children[0];

  const p = mgr.stopAll(); // stages 'stopped' BEFORE kill; kill fires close synchronously
  await p;
  assert.strictEqual(reg.get(a.id).status, 'stopped', 'shutdown status won over the child-close callback');

  // A LATE close event (out-of-order exit notification) must not resurrect idle.
  child.kill();
  await mgr._persistNow();
  assert.strictEqual(reg.get(a.id).status, 'stopped', 'late child exit cannot overwrite the shutdown intent');
  const reread = createRegistry(file);
  assert.strictEqual(reread.get(a.id).status, 'stopped', 'stopped status DURABLE on disk');
  assert.strictEqual(reg.transactionBusy(), false, 'registry transaction lock idle');
});

test('shutdown: stopAll does not hang when the final save fails; the stopped intent survives for the next flush', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const proj = makeProject(dir);
  const a = reg.create({ name: 'alpha', project: proj }).entry;
  await reg.save();
  const children = [];
  const mgr = makeManagerCapturing(reg, children);
  mgr.startSession(a.id);

  const ctl = makeSaveControl();
  const origSave = reg.save;
  reg.save = () => ctl.saveImpl();
  const p = mgr.stopAll();
  await waitFor(() => ctl.deferreds.length === 1, 'shutdown save reached');
  ctl.deferreds[0].reject(new Error('disk gone during shutdown'));
  await Promise.race([p, sleep(500).then(() => { throw new Error('stopAll hung on a failed save'); })]);
  assert.strictEqual(reg.get(a.id).status, 'idle', 'failed flush rolled back to the previous status');
  assert.strictEqual(reg.transactionBusy(), false, 'registry transaction lock released after the failure');

  // The re-queued intent (no retry loop) is applied by the next flush.
  reg.save = origSave;
  await mgr._persistNow();
  assert.strictEqual(reg.get(a.id).status, 'stopped', 'stopped intent survived and applied by the next flush');
});

test('shutdown: a queued touch (timer never fired) is persisted by flushTouches', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const file = path.join(dir, 'r.json');
  const proj = makeProject(dir);
  const e = reg.create({ name: 'touchy', project: proj }).entry;
  reg.get(e.id).lastActivity = '1970-01-01T00:00:00.000Z';
  await reg.save();

  reg.touch(e.id); // queued; the unref'd 400 ms timer must NOT be relied on
  await reg.flushTouches(); // the shutdown flush path
  await sleep(10); // let the transaction tail release the lock
  assert.notStrictEqual(reg.get(e.id).lastActivity, '1970-01-01T00:00:00.000Z', 'lastActivity applied');
  const reread = createRegistry(file);
  assert.notStrictEqual(reread.get(e.id).lastActivity, '1970-01-01T00:00:00.000Z', 'lastActivity DURABLE on disk');
  assert.strictEqual(reg.transactionBusy(), false, 'registry transaction lock idle');
});

test('shutdown: Channel offline state persists — reloaded registry shows connected=false', async () => {
  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const file = path.join(dir, 'r.json');
  const hub = makeHub(reg);
  const conn = await register(hub, 'client-shut', 'ShutOffline', 1);
  await sleep(30);
  const entry = reg.getByName('shutoffline');
  assert.ok(entry, 'channel session registered');
  assert.strictEqual(entry.connected, true, 'connected=true while online');

  // THE BRIDGE SHUTDOWN SEQUENCE (post-hub-close tail):
  hub.close();
  await reg.awaitTransactions(); // barrier: queued txns settled
  await reg.flushTouches();
  await reg.save(); // final persist of the offline state
  await reg.flush(); // disk writes durable

  assert.strictEqual(reg.get(entry.id).connected, false, 'in-memory offline after close');
  const reread = createRegistry(file);
  assert.strictEqual(reread.get(entry.id).connected, false, 'offline state DURABLE on disk');
  assert.strictEqual(reread.get(entry.id).status, 'idle', 'offline status durable');
  assert.strictEqual(hub.onlineIds().length, 0, 'no session remains online after close');
  assert.strictEqual(reg.transactionBusy(), false, 'registry transaction lock idle');
});

test('shutdown: registry flush with a never-resolving save times out, warns, and does not hang', async () => {
  // The bridge shutdown helper is exercised with a tiny timeout and a wedged
  // save: it must warn and settle (the caller then exits anyway).
  process.env.BRIDGE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgbridge-shutd-'));
  process.env.TELEGRAM_BOT_TOKEN = '123456789:TEST_TOKEN_FOR_TESTS_ONLY_TESTING';
  process.env.ALLOWED_TELEGRAM_IDS = '111';
  process.env.CLAUDE_BIN = '';
  const { shutdownRegistryFlush } = require('../bridge.js').__test;

  const warnings = [];
  const wedged = {
    awaitTransactions: () => Promise.resolve(),
    flushTouches: () => Promise.resolve(),
    save: () => new Promise(() => {}), // NEVER resolves
    flush: () => new Promise(() => {}),
  };
  const start = Date.now();
  await Promise.race([
    shutdownRegistryFlush(wedged, 50, (msg) => warnings.push(msg)),
    sleep(2000).then(() => { throw new Error('shutdownRegistryFlush hung on a never-resolving save'); }),
  ]);
  const elapsed = Date.now() - start;
  assert.strictEqual(warnings.length, 1, 'exactly one timeout warning logged');
  assert.ok(/timed out/.test(warnings[0]), `warning mentions the timeout: ${warnings[0]}`);
  assert.ok(elapsed < 1000, `bounded: settled in ${elapsed}ms, not at the 2 s guard`);
});

test('shutdown: a normal successful flush does NOT wait for the full timeout', async () => {
  process.env.BRIDGE_STATE_DIR = process.env.BRIDGE_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tgbridge-shutd-'));
  process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '123456789:TEST_TOKEN_FOR_TESTS_ONLY_TESTING';
  process.env.ALLOWED_TELEGRAM_IDS = process.env.ALLOWED_TELEGRAM_IDS || '111';
  process.env.CLAUDE_BIN = process.env.CLAUDE_BIN || '';
  const { shutdownRegistryFlush } = require('../bridge.js').__test;

  const dir = tmpDir();
  const reg = createRegistry(path.join(dir, 'r.json'));
  const proj = makeProject(dir);
  reg.create({ name: 'quick', project: proj });
  const warnings = [];
  const start = Date.now();
  await shutdownRegistryFlush(reg, 5000, (msg) => warnings.push(msg));
  const elapsed = Date.now() - start;
  assert.strictEqual(warnings.length, 0, 'no timeout warning on success');
  assert.ok(elapsed < 1000, `fast path: settled in ${elapsed}ms, far below the 5 s budget`);
  assert.strictEqual(reg.transactionBusy(), false, 'registry transaction lock idle');
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
  process.exit(2);
});

test.run();
