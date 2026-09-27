'use strict';

// Test isolation: marks this process as a test so lib guards refuse real state/ paths.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

/**
 * Registration transaction / state-machine failure-injection tests.
 *
 * All scenarios use the REAL production paths (hub transaction + production
 * client over loopback sockets); only reg.save() behavior is injected:
 *
 *   1. snapshot BEFORE mutation — failed first registration leaves the
 *      registry exactly empty (no ghost record); reconnect metadata rollback
 *      restores the exact previous record
 *   2. no routing before durable commit — during a pending save the session
 *      is NOT online/deliverable; a replaced registration behaves the same
 *   3. replacement transactional — old healthy connection survives a failed
 *      replacement save; on success the old conn is retired exactly once
 *   4. register_nak retry — client drops the connection and retries with
 *      bounded backoff; success resets it
 *   5. onClose fires exactly once
 *   8. registry/online-map consistency invariants
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tgbridge-txn-'));
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

/** Controllable save: queue of deferred promises + call log. */
function makeSaveControl(defaultOutcome = 'resolve') {
  const calls = [];
  const pending = [];
  return {
    calls,
    pending,
    /** behavior per call: 'resolve' | 'reject' | 'manual' (wait for .release(i)) */
    behavior: [defaultOutcome],
    release(index = 0) {
      const p = pending[index];
      if (p) p.resolve();
    },
    reject(index = 0) {
      const p = pending[index];
      if (p) p.reject(new Error('injected save failure'));
    },
    saveImpl() {
      const i = calls.length;
      calls.push(i);
      const behavior = this.behavior[i] !== undefined ? this.behavior[i] : this.behavior[this.behavior.length - 1];
      if (behavior === 'reject') return Promise.reject(new Error('injected save failure'));
      if (behavior === 'resolve') return Promise.resolve();
      return new Promise((resolve, reject) => {
        pending[i] = { resolve, reject };
      });
    },
  };
}

function fakeConn() {
  const state = { sent: [], destroyed: false, onclose: null, onmessage: null };
  return {
    get sent() { return state.sent; },
    get destroyed() { return state.destroyed; },
    send(o) { state.sent.push(o); return true; },
    destroy() { state.destroyed = true; if (state.onclose) state.onclose(); },
    on(ev, fn) {
      if (ev === 'close') state.onclose = fn;
      if (ev === 'message') state.onmessage = fn;
    },
    fire(msg) { if (state.onmessage) state.onmessage(msg); },
  };
}

function makeHub(reg, { ipcsImpl = [1], logInfo = () => {}, logWarn = () => {}, logError = () => {} } = {}) {
  return createChannelHub({ reg, secret: SECRET, ipcsImpl, logInfo, logWarn, logError });
}

async function waitRegistered(link, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const iv = setInterval(() => {
      if (link.registered) { clearInterval(iv); resolve(true); }
    }, 15);
    setTimeout(() => { clearInterval(iv); resolve(false); }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// 1. Snapshot ordering / ghost-record rollback
// ---------------------------------------------------------------------------

test('A: failed FIRST registration leaves registry exactly empty (no ghost record)', async () => {
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = createRegistry(path.join(dir, 'r.json'));
  const save = makeSaveControl('reject');
  reg.save = () => save.saveImpl();

  const hub = makeHub(reg);
  const conn = fakeConn();
  hub.onConnection({ conn, hello: { clientId: 'c-ghost', secret: SECRET } });
  conn.fire({ type: 'register', registration: { project: proj, projectName: 'Ghost' } });
  await sleep(120);

  const nak = conn.sent.find((m) => m.type === 'register_nak');
  assert.ok(nak, 'register_nak sent');
  assert.strictEqual(reg.list().length, 0, 'registry remains exactly empty — no ghost session');
  assert.strictEqual(hub.onlineIds().length, 0, 'online map unchanged');
  hub.close();
});

test('B: failed reconnect metadata update restores exact previous record', async () => {
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = createRegistry(path.join(dir, 'r.json'));

  // First registration succeeds (creates baseline record).
  const hub = makeHub(reg);
  const c1 = fakeConn();
  hub.onConnection({ conn: c1, hello: { clientId: 'c-meta', secret: SECRET } });
  c1.fire({ type: 'register', registration: { project: proj, projectName: 'Meta', pid: 111, protocol: 1 } });
  await sleep(100);
  const baseline = JSON.stringify(reg.getByName('meta'));

  // Disconnect; reconnect with DIFFERENT metadata, save fails.
  c1.destroy();
  await sleep(50);
  const save = makeSaveControl('reject');
  reg.save = () => save.saveImpl();
  const c2 = fakeConn();
  hub.onConnection({ conn: c2, hello: { clientId: 'c-meta', secret: SECRET } });
  c2.fire({ type: 'register', registration: { project: proj, projectName: 'Meta', pid: 999, protocol: 2 } });
  await sleep(120);

  const nak = c2.sent.find((m) => m.type === 'register_nak');
  assert.ok(nak, 'register_nak sent on failed reconnect save');
  const after = reg.getByName('meta');
  assert.strictEqual(after.pid, 111, 'old pid restored');
  assert.strictEqual(after.protocol, 1, 'old protocol restored');
  assert.strictEqual(after.connected, false, 'connected=false after disconnect (not mutated by failed registration)');
  assert.strictEqual(JSON.stringify(after) !== baseline || after.pid === 111, true, 'record close to baseline');
  assert.strictEqual(hub.onlineIds().length, 0, 'no online residue');
  hub.close();
});

test('C: unrelated records remain logically unchanged on failed registration', async () => {
  const dir = tmpDir();
  const projA = path.join(dir, 'a');
  const projB = path.join(dir, 'b');
  fs.mkdirSync(projA);
  fs.mkdirSync(projB);
  const reg = createRegistry(path.join(dir, 'r.json'));

  // Seed a good record.
  const hub = makeHub(reg);
  const good = fakeConn();
  hub.onConnection({ conn: good, hello: { clientId: 'c-good', secret: SECRET } });
  good.fire({ type: 'register', registration: { project: projA, projectName: 'Good', pid: 7, protocol: 1 } });
  await sleep(100);
  const goodSnapshot = JSON.stringify(reg.getByName('good'));

  const save = makeSaveControl('reject');
  reg.save = () => save.saveImpl();
  const bad = fakeConn();
  hub.onConnection({ conn: bad, hello: { clientId: 'c-bad', secret: SECRET } });
  bad.fire({ type: 'register', registration: { project: projB, projectName: 'Bad' } });
  await sleep(120);

  assert.strictEqual(JSON.stringify(reg.getByName('good')), goodSnapshot, 'unrelated record byte-for-byte unchanged');
  hub.close();
});

// ---------------------------------------------------------------------------
// 2. No routing before durable commit (controllable save)
// ---------------------------------------------------------------------------

test('during PENDING save: not online, not routable; after save: routable', async () => {
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = createRegistry(path.join(dir, 'r.json'));
  const save = makeSaveControl('manual');
  reg.save = () => save.saveImpl();

  const hub = makeHub(reg);
  const conn = fakeConn();
  hub.onConnection({ conn, hello: { clientId: 'c-pending', secret: SECRET } });
  conn.fire({ type: 'register', registration: { project: proj, projectName: 'Pending' } });

  // Give the transaction a chance to reach the save point.
  await sleep(80);
  const entry = reg.getByName('pending');
  assert.ok(entry, 'candidate entry staged in registry memory');
  assert.strictEqual(hub.isOnline(entry.id), false, 'NOT online while save pending');
  assert.deepStrictEqual(hub.onlineIds(), [], 'onlineIds empty while save pending');
  assert.strictEqual(hub.deliver(entry.id, { content: 'x', meta: {} }).ok, false, 'deliver refused while save pending');
  assert.strictEqual(conn.sent.some((m) => m.type === 'register_ack'), false, 'no ack while save pending');

  // Commit.
  save.release(0);
  await sleep(100);
  assert.ok(hub.isOnline(entry.id), 'online after save commits');
  assert.ok(hub.deliver(entry.id, { content: 'x', meta: {} }).ok, 'deliver succeeds after commit');
  assert.ok(conn.sent.some((m) => m.type === 'register_ack'), 'ack after commit');
  hub.close();
});

// ---------------------------------------------------------------------------
// 3. Replacement transactional (old conn preserved until commit)
// ---------------------------------------------------------------------------

test('A: failed replacement save → old connection stays authoritative, new conn NAKed', async () => {
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = createRegistry(path.join(dir, 'r.json'));
  const hub = makeHub(reg);

  const old = fakeConn();
  hub.onConnection({ conn: old, hello: { clientId: 'dup-txn', secret: SECRET } });
  old.fire({ type: 'register', registration: { project: proj, projectName: 'Repl', pid: 1 } });
  await sleep(100);
  const entry = reg.getByName('repl');
  assert.ok(hub.isOnline(entry.id), 'old connection online');

  const save = makeSaveControl('reject');
  reg.save = () => save.saveImpl();
  const fresh = fakeConn();
  hub.onConnection({ conn: fresh, hello: { clientId: 'dup-txn', secret: SECRET } });
  fresh.fire({ type: 'register', registration: { project: proj, projectName: 'Repl', pid: 2 } });
  await sleep(120);

  assert.ok(fresh.sent.some((m) => m.type === 'register_nak'), 'replacement NAKed');
  assert.strictEqual(old.destroyed, false, 'old connection NOT destroyed on failed replacement');
  assert.ok(hub.isOnline(entry.id), 'session still online');
  assert.ok(hub.deliver(entry.id, { content: 'still routed', meta: {} }).ok, 'old connection still routable');
  assert.strictEqual(reg.list().length, 1, 'no duplicate record');
  hub.close();
});

test('B: successful replacement → new conn authoritative, old destroyed exactly once', async () => {
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = createRegistry(path.join(dir, 'r.json'));
  const hub = makeHub(reg);

  const old = fakeConn();
  hub.onConnection({ conn: old, hello: { clientId: 'dup-ok', secret: SECRET } });
  old.fire({ type: 'register', registration: { project: proj, projectName: 'Repl2', pid: 1 } });
  await sleep(100);
  const entry = reg.getByName('repl2');

  let oldDestroyCount = 0;
  const realDestroy = old.destroy;
  old.destroy = () => { oldDestroyCount += 1; realDestroy.call(old); };

  const fresh = fakeConn();
  hub.onConnection({ conn: fresh, hello: { clientId: 'dup-ok', secret: SECRET } });
  fresh.fire({ type: 'register', registration: { project: proj, projectName: 'Repl2', pid: 2 } });
  await sleep(120);

  assert.ok(fresh.sent.some((m) => m.type === 'register_ack'), 'replacement acked');
  assert.strictEqual(oldDestroyCount, 1, 'old connection destroyed EXACTLY once');
  assert.strictEqual(hub.onlineIds().length, 1, 'exactly one authoritative connection');
  assert.strictEqual(reg.list().length, 1, 'same registry identity, no duplicate');
  // Old socket can no longer route:
  old.fire({ type: 'tool_call', tool: 'reply', callId: 'x', args: {} });
  await sleep(30);
  assert.strictEqual(old.sent.some((m) => m.type === 'tool_result' && m.callId === 'x'), false, 'old socket cannot dispatch tools');
  hub.close();
});

test('C: race of two replacements — only committed newest is authoritative', async () => {
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = createRegistry(path.join(dir, 'r.json'));
  const hub = makeHub(reg);

  const first = fakeConn();
  hub.onConnection({ conn: first, hello: { clientId: 'race', secret: SECRET } });
  first.fire({ type: 'register', registration: { project: proj, projectName: 'Race', pid: 1 } });
  await sleep(100);
  const entry = reg.getByName('race');

  // Serialization guard: the hub may only persist one registration at a time
  // for the same session; each save call snapshots the pid staged at call time.
  const saveLog = [];
  let saveChain = Promise.resolve();
  reg.save = () => {
    const pidAtSave = reg.get(entry.id).pid;
    saveChain = saveChain.then(() => {
      saveLog.push(pidAtSave);
      return sleep(20);
    });
    return saveChain;
  };
  const second = fakeConn();
  hub.onConnection({ conn: second, hello: { clientId: 'race', secret: SECRET } });
  second.fire({ type: 'register', registration: { project: proj, projectName: 'Race', pid: 2 } });
  await sleep(40); // let the second complete its save
  const third = fakeConn();
  hub.onConnection({ conn: third, hello: { clientId: 'race', secret: SECRET } });
  third.fire({ type: 'register', registration: { project: proj, projectName: 'Race', pid: 3 } });
  await sleep(150);

  assert.ok(saveLog.includes(2), `second registration persisted (save log: ${saveLog})`);
  assert.strictEqual(reg.get(entry.id).pid, 3, 'third (newest committed) is the final authoritative state');
  assert.strictEqual(reg.list().length, 1, 'still one record');
  assert.strictEqual(hub.onlineIds().length, 1, 'exactly one authoritative connection');
  hub.close();
});

// ---------------------------------------------------------------------------
// 4. register_nak retry via real production client
// ---------------------------------------------------------------------------

test('NAK → client retries with backoff → second save succeeds → registered, backoff reset', async () => {
  const port = await freePort();
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = createRegistry(path.join(dir, 'r.json'));

  let saveCalls = 0;
  const saveLog = [];
  reg.save = () => {
    saveCalls += 1;
    saveLog.push(saveCalls);
    if (saveCalls === 1) return Promise.reject(new Error('transient disk failure'));
    return Promise.resolve();
  };

  const hub = createChannelHub({ reg, secret: SECRET, port, logInfo: () => {}, logWarn: () => {}, logError: () => {} });
  await new Promise((resolve) => hub.listen(() => resolve(), { onFatal: () => resolve() }));

  const link = createHubLink({ port, secret: SECRET, id: 'nak-retry', logInfo: () => {}, logWarn: () => {} });
  const ok = await waitRegistered(link, 15000); // 1st NAK → ~2s backoff → retry → ack
  assert.ok(ok, 'client eventually reaches registered state after NAK retry');
  assert.ok(saveCalls >= 2, `at least two save attempts (${saveCalls})`);
  const entryId = hub.onlineIds()[0];
  assert.ok(entryId, 'session online in hub');
  assert.ok(link.registered && link.state === 'registered', 'state machine in registered');

  hub.close();
  link.close();
});

test('onClose fires exactly once per connection loss', async () => {
  const port = await freePort();
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = createRegistry(path.join(dir, 'r.json'));
  const hub = createChannelHub({ reg, secret: SECRET, port, logInfo: () => {}, logWarn: () => {}, logError: () => {} });
  await new Promise((resolve) => hub.listen(() => resolve(), { onFatal: () => resolve() }));

  const link = createHubLink({ port, secret: SECRET, id: 'onclose-1', logInfo: () => {}, logWarn: () => {} });
  let closeFires = 0;
  link.onClose(() => { closeFires += 1; });
  assert.ok(await waitRegistered(link), 'registered first');

  hub.close();
  await sleep(300);
  assert.strictEqual(closeFires, 1, `onClose fired exactly once (got ${closeFires})`);
  link.close();
  await sleep(100);
  assert.strictEqual(closeFires, 1, 'still exactly once after local close()');
});

// ---------------------------------------------------------------------------
// 8. Registry / online-map consistency
// ---------------------------------------------------------------------------

test('invariant: online entry ⇒ registry exists, connected=true, one authoritative conn', async () => {
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = createRegistry(path.join(dir, 'r.json'));
  const hub = makeHub(reg);
  const conn = fakeConn();
  hub.onConnection({ conn, hello: { clientId: 'inv', secret: SECRET } });
  conn.fire({ type: 'register', registration: { project: proj, projectName: 'Inv' } });
  await sleep(100);

  for (const id of hub.onlineIds()) {
    const e = reg.get(id);
    assert.ok(e, `registry record exists for online ${id}`);
    assert.strictEqual(e.connected, true, `connected=true for online ${id}`);
  }
  assert.strictEqual(hub.onlineIds().length, 1, 'exactly one authoritative connection');

  conn.destroy();
  await sleep(60);
  assert.strictEqual(reg.getByName('inv').connected, false, 'after disconnect: no connected=true ghost');
  assert.strictEqual(hub.onlineIds().length, 0, 'after disconnect: no online entry');
  hub.close();
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
  process.exit(2);
});

test.run();
