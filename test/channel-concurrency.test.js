'use strict';

/**
 * Registration-concurrency correctness tests:
 *   1. dead candidate commit (candidate closes while save pending)
 *   2. generation tokens (superseded attempt cannot commit/ack)
 *   3. concurrent B/C replacement race (only one authoritative)
 *   4. old healthy connection preserved until the winner commits
 *   7. onClose fires once per connection lifecycle (3 cycles = 3 callbacks)
 *   8. persisted clientId identity (same project, two sessions, restart,
 *      rename, legacy migration)
 *   13. stale late-close event cannot tear down the authoritative session
 *   10. stale snapshot restore cannot overwrite a newer committed state
 *
 * Uses real loopback sockets + the real production client/hub wherever the
 * race requires it; reg.save is the only injected seam.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
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
const { createHubLink } = require('../lib/channel/claude-channel');
const { createRegistry } = require('../lib/claude/registry');

const SECRET = crypto.randomBytes(32).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tgbridge-race-'));
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function fakeConn() {
  const state = { sent: [], destroyed: false, onclose: null, onmessage: null };
  const conn = {
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
  return conn;
}

function makeHub(reg, extra = {}) {
  return createChannelHub({
    reg, secret: SECRET, ipcsImpl: [1],
    logInfo: () => {}, logWarn: () => {}, logError: () => {},
    ...extra,
  });
}

async function waitRegistered(link, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const iv = setInterval(() => {
      if (link.registered) { clearInterval(iv); resolve(true); }
    }, 15);
    setTimeout(() => { clearInterval(iv); resolve(false); }, timeoutMs);
  });
}

/**
 * Explicit deferred — the ONLY sanctioned way to gate/complete injected
 * reg.save promises in this file. Guards against the "resolve with an Error
 * object" mistake: deferred.resolve(err) throws instead of resolving.
 */
function makeDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return {
    promise,
    resolve(value) {
      if (value instanceof Error) throw new TypeError('deferred.resolve(Error) — use deferred.reject(err) to inject a save FAILURE');
      resolve(value);
    },
    reject(err) {
      if (!(err instanceof Error)) throw new TypeError('deferred.reject(err) requires an Error');
      reject(err);
    },
    /** Raw settle (success) for gates that only ever succeed. */
    settle: resolve,
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
  assert.strictEqual(outcome.kind, 'rejected', `${label}: promise must REJECT (a resolution — even with an Error object — is a save SUCCESS and does not exercise the failure path)`);
  assert.ok(outcome.err instanceof Error, `${label}: rejection reason must be an Error`);
  return outcome.err;
}

// ---------------------------------------------------------------------------
// 1. Dead candidate commit
// ---------------------------------------------------------------------------

test('dead candidate: candidate closes while save pending → commit aborted, old conn preserved', async () => {
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = createRegistry(path.join(dir, 'r.json'));
  const hub = makeHub(reg);

  // A registers healthy.
  const a = fakeConn();
  hub.onConnection({ conn: a, hello: { clientId: 'dead-txn', secret: SECRET } });
  a.fire({ type: 'register', registration: { project: proj, projectName: 'Race', pid: 1 } });
  await sleep(80);
  const entry = reg.getByName('race');
  assert.ok(hub.isOnline(entry.id), 'A online');

  // B replacement with a save we hold open.
  const saveCalls = [];
  let releaseSave = null;
  reg.save = () => {
    saveCalls.push(true);
    return new Promise((resolve) => { releaseSave = resolve; });
  };
  const b = fakeConn();
  hub.onConnection({ conn: b, hello: { clientId: 'dead-txn', secret: SECRET } });
  b.fire({ type: 'register', registration: { project: proj, projectName: 'Race', pid: 2 } });
  await sleep(80);
  assert.ok(saveCalls.length >= 1, 'B reached save');
  // NOTE: while B's save is pending, the registry memory shows B's STAGED pid
  // (mutation-before-persist is the transactional design). What matters: no
  // COMMIT happened — hub.isOnline/deliver still route through A, and after
  // the abort the registry is restored to A's state.
  assert.ok(hub.deliver(entry.id, { content: 'x', meta: {} }).ok, 'routing still via A while B pending');

  // B DIES while save pending.
  b.destroy();
  await sleep(30);
  releaseSave(); // B's save succeeds AFTER death
  await sleep(80);

  assert.ok(b.sent.some((m) => m.type === 'register_nak'), 'dead candidate got register_nak, not ack');
  assert.strictEqual(b.sent.some((m) => m.type === 'register_ack'), false, 'dead candidate NEVER acked');
  assert.strictEqual(reg.get(entry.id).pid, 1, 'registry rolled back — still A’s committed state');
  assert.ok(hub.isOnline(entry.id), 'session still online via A');
  assert.ok(hub.deliver(entry.id, { content: 'x', meta: {} }).ok, 'delivery still works via A');
  assert.strictEqual(a.destroyed, false, 'A never destroyed');
  hub.close();
});

// ---------------------------------------------------------------------------
// 2+3. Generation tokens / concurrent B/C race
// ---------------------------------------------------------------------------

test('concurrent B/C: only the winning generation commits; loser NAKed and closed', async () => {
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = createRegistry(path.join(dir, 'r.json'));
  const hub = makeHub(reg);

  const a = fakeConn();
  hub.onConnection({ conn: a, hello: { clientId: 'gen-race', secret: SECRET } });
  a.fire({ type: 'register', registration: { project: proj, projectName: 'Race', pid: 1 } });
  await sleep(80);
  const entry = reg.getByName('race');

  // Serialize through a save gate so B and C overlap.
  const pending = [];
  reg.save = () => new Promise((resolve) => pending.push(resolve));

  const b = fakeConn();
  hub.onConnection({ conn: b, hello: { clientId: 'gen-race', secret: SECRET } });
  b.fire({ type: 'register', registration: { project: proj, projectName: 'Race', pid: 2 } });
  const c = fakeConn();
  hub.onConnection({ conn: c, hello: { clientId: 'gen-race', secret: SECRET } });
  c.fire({ type: 'register', registration: { project: proj, projectName: 'Race', pid: 3 } });
  await sleep(80);

  // C is serialized BEHIND B by the per-identity lock: only B's save is
  // pending while C waits for the lock.
  assert.strictEqual(pending.length, 1, `C serialized behind B (pending: ${pending.length})`);

  // Release B's save: B is superseded by C's newer generation → cannot commit.
  // NOTE: C's transaction staged pid=3 in registry memory (inside the same
  // per-identity lock) BEFORE B's abort ran, so at this instant the registry
  // shows C's staged state — the invariant that matters is B's NAK + no ACK,
  // and C's eventual authoritative commit below.
  pending[0]();
  await sleep(80);
  const bNak = b.sent.find((m) => m.type === 'register_nak');
  assert.ok(bNak, 'B (stale generation) NAKed');
  assert.strictEqual(b.sent.some((m) => m.type === 'register_ack'), false, 'B never acked');

  // Release C's save (now queued behind the lock): C is current → commits.
  // (C's save resolves immediately via the real registry path — wait for it.)
  await sleep(150); // allow C's transaction to run its save+commit
  assert.ok(c.sent.some((m) => m.type === 'register_ack'), 'C acked');
  await sleep(80);
  assert.ok(c.sent.some((m) => m.type === 'register_ack'), 'C acked');
  assert.strictEqual(reg.get(entry.id).pid, 3, 'C’s metadata committed');
  assert.strictEqual(a.destroyed, true, 'A retired exactly when C committed');
  assert.strictEqual(hub.onlineIds().length, 1, 'exactly one authoritative connection');
  assert.strictEqual(reg.list().length, 1, 'no duplicate record');
  hub.close();
});

test('stale loser cannot dispatch tool_call or use delivery id', async () => {
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = createRegistry(path.join(dir, 'r.json'));
  const hub = makeHub(reg);
  const toolCalls = [];
  hub.onChannelTool(async (entry, tool, args) => { toolCalls.push({ name: entry.name }); return { sent: true }; });

  const a = fakeConn();
  hub.onConnection({ conn: a, hello: { clientId: 'loser', secret: SECRET } });
  a.fire({ type: 'register', registration: { project: proj, projectName: 'Loser', pid: 1 } });
  await sleep(80);
  const entry = reg.getByName('loser');

  const pending = [];
  reg.save = () => new Promise((resolve) => pending.push(resolve));
  const b = fakeConn();
  hub.onConnection({ conn: b, hello: { clientId: 'loser', secret: SECRET } });
  b.fire({ type: 'register', registration: { project: proj, projectName: 'Loser', pid: 2 } });
  const c = fakeConn();
  hub.onConnection({ conn: c, hello: { clientId: 'loser', secret: SECRET } });
  c.fire({ type: 'register', registration: { project: proj, projectName: 'Loser', pid: 3 } });
  await sleep(80);
  pending[0](); // B → stale (C is serialized behind B)
  await sleep(120); // B aborts, then C's transaction runs its own save
  if (pending[1]) pending[1](); // resolve C's save if it gates
  await sleep(120);

  // Stale B tries a tool call: must be refused (connection destroyed → hub
  // won't route from it; even a forged frame cannot map to a session).
  b.fire({ type: 'tool_call', tool: 'reply', callId: 'x1', args: { delivery_id: 'anything', text: 'hi' } });
  await sleep(30);
  assert.strictEqual(toolCalls.length, 0, 'stale loser dispatched nothing');

  // C dispatches normally.
  c.fire({ type: 'tool_call', tool: 'reply', callId: 'x2', args: { delivery_id: 'anything', text: 'hi' } });
  await sleep(30);
  assert.strictEqual(toolCalls.length, 1, 'authoritative C dispatches');
  hub.close();
});

// ---------------------------------------------------------------------------
// 4. Old connection preserved through failed candidates
// ---------------------------------------------------------------------------

test('all replacement candidates fail → A remains authoritative throughout', async () => {
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = createRegistry(path.join(dir, 'r.json'));
  const hub = makeHub(reg);

  const a = fakeConn();
  hub.onConnection({ conn: a, hello: { clientId: 'keep-a', secret: SECRET } });
  a.fire({ type: 'register', registration: { project: proj, projectName: 'Keeper', pid: 1 } });
  await sleep(80);
  const entry = reg.getByName('keeper');

  reg.save = () => Promise.reject(new Error('disk gone'));
  const b = fakeConn();
  hub.onConnection({ conn: b, hello: { clientId: 'keep-a', secret: SECRET } });
  b.fire({ type: 'register', registration: { project: proj, projectName: 'Keeper', pid: 2 } });
  await sleep(80);
  const c = fakeConn();
  hub.onConnection({ conn: c, hello: { clientId: 'keep-a', secret: SECRET } });
  c.fire({ type: 'register', registration: { project: proj, projectName: 'Keeper', pid: 3 } });
  await sleep(120);

  assert.strictEqual(a.destroyed, false, 'A never destroyed');
  assert.ok(hub.isOnline(entry.id), 'A still online');
  assert.ok(hub.deliver(entry.id, { content: 'x', meta: {} }).ok, 'A still routable');
  assert.strictEqual(reg.get(entry.id).pid, 1, 'registry still A’s committed state');
  assert.ok(b.sent.some((m) => m.type === 'register_nak') && c.sent.some((m) => m.type === 'register_nak'), 'both candidates NAKed');
  hub.close();
});

// ---------------------------------------------------------------------------
// 7. onClose per connection lifecycle
// ---------------------------------------------------------------------------

test('onClose fires once per connection loss across 3 reconnect cycles', async () => {
  const port = await freePort();
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = createRegistry(path.join(dir, 'r.json'));

  const saveGate = { release: null };
  reg.save = () => new Promise((resolve) => { saveGate.release = resolve; });

  const hub = createChannelHub({ reg, secret: SECRET, port, logInfo: () => {}, logWarn: () => {}, logError: () => {} });
  await new Promise((resolve) => hub.listen(() => resolve(), { onFatal: () => resolve() }));

  const link = createHubLink({ port, secret: SECRET, id: 'cycles', logInfo: () => {}, logWarn: () => {} });
  let closeFires = 0;
  link.onClose(() => { closeFires += 1; });

  let acks = 0;
  // Cycle helper: register (gate the save), disconnect, count.
  async function cycle(n) {
    saveGate.release = (saveGate.release || null);
    const p = waitRegistered(link, 6000);
    // The hub will call save; release whatever the current gate is.
    const iv = setInterval(() => { if (saveGate.release) { const r = saveGate.release; saveGate.release = null; r(); } }, 20);
    const ok = await p;
    clearInterval(iv);
    assert.ok(ok, `cycle ${n}: registered`);
    acks += 1;
    // Kill the hub; client notices (one onClose); restart for the next cycle.
    hub.close();
    await sleep(250);
    await new Promise((resolve) => hub.listen(() => resolve(), { onFatal: () => resolve() }));
    await sleep(2500); // reconnect backoff
  }
  await cycle(1);
  await cycle(2);
  await cycle(3);

  assert.strictEqual(closeFires, 3, `onClose fired once per loss across 3 cycles (got ${closeFires})`);
  hub.close();
  link.close();
});

// ---------------------------------------------------------------------------
// 8. Persisted clientId identity
// ---------------------------------------------------------------------------

test('two clientIds on the SAME project → two distinct records, each rebinds by clientId', async () => {
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = createRegistry(path.join(dir, 'r.json'));
  const hub = makeHub(reg);

  const c1 = fakeConn();
  hub.onConnection({ conn: c1, hello: { clientId: 'alpha', secret: SECRET } });
  c1.fire({ type: 'register', registration: { project: proj, projectName: 'Proj', pid: 1 } });
  await sleep(120);
  const c2 = fakeConn();
  hub.onConnection({ conn: c2, hello: { clientId: 'beta', secret: SECRET } });
  c2.fire({ type: 'register', registration: { project: proj, projectName: 'Proj-2', pid: 2 } });
  await sleep(120);

  assert.strictEqual(reg.list().length, 2, 'two distinct sessions for one project');
  const alpha = reg.getByClientId('alpha');
  const beta = reg.getByClientId('beta');
  assert.ok(alpha && beta, 'both clientIds persisted on their records');
  assert.notStrictEqual(alpha.id, beta.id, 'distinct registry identities');

  // Reconnect: each binds to its OWN record by clientId (name differs, project same).
  c1.destroy();
  c2.destroy();
  await sleep(80);
  const c1b = fakeConn();
  hub.onConnection({ conn: c1b, hello: { clientId: 'alpha', secret: SECRET } });
  c1b.fire({ type: 'register', registration: { project: proj, projectName: 'Proj', pid: 1 } });
  await sleep(120);
  assert.strictEqual(reg.getByClientId('alpha').id, alpha.id, 'alpha rebinds to its own record');
  assert.strictEqual(reg.list().length, 2, 'no duplicates');
  hub.close();
});

test('legacy record without clientId: first registration backfills safely (no crash, no dup)', async () => {
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = createRegistry(path.join(dir, 'r.json'));
  // Seed a legacy channel record (no clientId field).
  const created = reg.create({ name: 'Legacy', project: proj, owner: null });
  assert.ok(created.ok);
  const legacyId = created.entry.id;

  const hub = makeHub(reg);
  const conn = fakeConn();
  hub.onConnection({ conn, hello: { clientId: 'legacy-client', secret: SECRET } });
  conn.fire({ type: 'register', registration: { project: proj, projectName: 'Legacy', pid: 9 } });
  await sleep(80);

  assert.strictEqual(reg.list().length, 1, 'no duplicate created');
  const e = reg.get(legacyId);
  assert.strictEqual(e.clientId, 'legacy-client', 'clientId backfilled');
  assert.strictEqual(e.connected, true, 'record went online');
  hub.close();
});

test('renamed display name, same clientId → same record updated, not duplicated', async () => {
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = createRegistry(path.join(dir, 'r.json'));
  const hub = makeHub(reg);

  const c1 = fakeConn();
  hub.onConnection({ conn: c1, hello: { clientId: 'stable-id', secret: SECRET } });
  c1.fire({ type: 'register', registration: { project: proj, projectName: 'Original', pid: 1 } });
  await sleep(120);
  const first = reg.getByClientId('stable-id');

  // "Renamed project directory" — same clientId, different projectName/project.
  const proj2 = path.join(dir, 'proj-renamed');
  fs.mkdirSync(proj2);
  const c2 = fakeConn();
  hub.onConnection({ conn: c2, hello: { clientId: 'stable-id', secret: SECRET } });
  c2.fire({ type: 'register', registration: { project: proj2, projectName: 'Renamed', pid: 2 } });
  await sleep(120);

  assert.strictEqual(reg.getByClientId('stable-id').id, first.id, 'same record updated');
  assert.strictEqual(reg.list().length, 1, 'no duplicate');
  assert.strictEqual(reg.get(first.id).pid, 2, 'metadata updated on the same record');
  hub.close();
});

// ---------------------------------------------------------------------------
// 13. Stale late-close cannot tear down the new authoritative session
// ---------------------------------------------------------------------------

test('late close from a replaced connection does not mark the new session offline', async () => {
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = createRegistry(path.join(dir, 'r.json'));
  const hub = makeHub(reg);

  const a = fakeConn();
  hub.onConnection({ conn: a, hello: { clientId: 'late-close', secret: SECRET } });
  a.fire({ type: 'register', registration: { project: proj, projectName: 'Late', pid: 1 } });
  await sleep(120);
  const entry = reg.getByName('late');

  // C replaces A. A's destroy() synchronously fires its close handler, but we
  // then SIMULATE a LATE close event (double-fire, like a delayed socket close).
  const c = fakeConn();
  hub.onConnection({ conn: c, hello: { clientId: 'late-close', secret: SECRET } });
  c.fire({ type: 'register', registration: { project: proj, projectName: 'Late', pid: 2 } });
  await sleep(120);
  assert.ok(hub.isOnline(entry.id), 'C authoritative');

  // A emits a late close event AFTER C committed. We must invoke A's close
  // handler directly (the hub registered it via conn.on('close')).
  const aCloseHandler = a.onclose;
  assert.ok(typeof aCloseHandler === 'function', 'A has a hub close handler');
  aCloseHandler();
  await sleep(40);
  assert.ok(hub.isOnline(entry.id), 'C STILL online after A’s late close');

  // C's own close DOES take the session offline.
  const cCloseHandler = c.onclose;
  assert.ok(typeof cCloseHandler === 'function', 'C has a hub close handler');
  cCloseHandler();
  await sleep(40);
  assert.strictEqual(hub.isOnline(entry.id), false, 'authoritative close works normally');
  hub.close();
});

// ---------------------------------------------------------------------------
// 10. Stale snapshot restore cannot overwrite a newer committed state
// ---------------------------------------------------------------------------

test('failed stale attempt does not roll back a newer transaction’s committed state (REAL rejection)', async () => {
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = createRegistry(path.join(dir, 'r.json'));
  const hub = makeHub(reg);

  const a = fakeConn();
  hub.onConnection({ conn: a, hello: { clientId: 'rb-safe', secret: SECRET } });
  a.fire({ type: 'register', registration: { project: proj, projectName: 'Rb', pid: 1 } });
  await sleep(80);
  const entry = reg.getByName('rb');

  // Explicit deferreds: B's save is gated then REJECTED (never "resolved with
  // an Error", which would be a SUCCESSFUL save and a false failure test).
  const saveGates = [];
  reg.save = () => {
    const d = makeDeferred();
    saveGates.push(d);
    return d.promise;
  };
  const b = fakeConn();
  hub.onConnection({ conn: b, hello: { clientId: 'rb-safe', secret: SECRET } });
  b.fire({ type: 'register', registration: { project: proj, projectName: 'Rb', pid: 2 } });
  await sleep(60);
  assert.strictEqual(saveGates.length, 1, 'B save pending (gated)');

  // C supersedes B and COMMITS (pid 3). C is serialized behind B's per-identity
  // lock — and C's whole-registry transaction is serialized behind B's by the
  // global registry transaction mutex.
  const c = fakeConn();
  hub.onConnection({ conn: c, hello: { clientId: 'rb-safe', secret: SECRET } });
  c.fire({ type: 'register', registration: { project: proj, projectName: 'Rb', pid: 3 } });
  await sleep(60);
  assert.strictEqual(saveGates.length, 1, 'C serialized behind B (still 1 gated save)');

  // B's save REJECTS (genuine failure path), then C's transaction runs.
  saveGates[0].reject(new Error('B disk failure'));
  await sleep(120);
  if (saveGates[1]) saveGates[1].settle(); // C's save succeeds
  await sleep(120);
  assert.strictEqual(reg.get(entry.id).pid, 3, 'C’s committed state WINS');
  assert.strictEqual(reg.list().length, 1, 'one record');
  hub.close();
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
  process.exit(2);
});

test.run();
