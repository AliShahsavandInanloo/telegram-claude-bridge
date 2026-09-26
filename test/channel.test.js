'use strict';

/**
 * Tests for the Claude Code Channel integration: IPC auth/framing, hub
 * registration & reconcile, Telegram->channel routing isolation, reply/file
 * tool gating, the queued-task result fix, and registry rollback ordering.
 * Everything runs over injected IPC — no real sockets, no real Claude.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { attachFraming, createIpcServer, createIpcClient, MAX_FRAME_BYTES } = require('../lib/channel/ipc');
const { createChannelHub } = require('../lib/channel/hub');
const { createRegistry } = require('../lib/claude/registry');
const { createManagedSession } = require('../lib/claude/session');
const { createClaudeManager } = require('../lib/claude/manager');
const net = require('net');

let passed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok  ${name}`);
    })
    .catch((err) => {
      failures.push({ name, err });
      console.error(`FAIL  ${name}\n      ${err && err.message}`);
    });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tgbridge-chan-'));
}

const SECRET = crypto.randomBytes(32).toString('hex');

/** Fake bidirectional conn implementing the framing API surface the hub uses. */
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

/** Simulate the hub's onConnection contract via an injected IPC impl. */
function makeHub(reg, { secret = SECRET } = {}) {
  const connections = [];
  const hub = createChannelHub({
    reg,
    secret,
    ipcsImpl: connections, // any truthy non-null switches to test mode
    logInfo: () => {},
    logWarn: () => {},
  });
  return { hub, connections };
}

function registerConn(hub, reg, { clientId, project, projectName, claudeSessionId, connectedSpy }) {
  const conn = fakeConn();
  if (connectedSpy) connectedSpy.push(conn);
  hub.onConnection({ conn, hello: { clientId, secret: SECRET } });
  conn.fire({ type: 'register', registration: { project, projectName, channelName: 'telegram-bridge', claudeSessionId, pid: 1234, protocol: 1 } });
  // Registration persistence is now async (transactional save with fsync);
  // wait until the ack/nak actually arrives before assertions run.
  return new Promise((resolve) => {
    const started = Date.now();
    (function poll() {
      if (conn.sent.some((m) => m.type === 'register_ack' || m.type === 'register_nak') || Date.now() - started > 2000) {
        resolve(conn);
        return;
      }
      setTimeout(poll, 5);
    })();
  });
}

// ---------------------------------------------------------------------------

(async () => {
  // ---------------- IPC: framing + auth (real sockets, loopback) ------------

  await test('ipc: framed JSON round-trip over loopback TCP', async () => {
    let serverSide = null;
    const raw = net.createServer((s) => {
      serverSide = attachFraming(s);
      serverSide.on('message', (m) => serverSide.send({ type: 'echo_ok', got: m.v }));
    });
    await new Promise((res) => raw.listen(0, '127.0.0.1', res));
    const port = raw.address().port;
    let clientSide = null;
    const got = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      clientSide = attachFraming(s);
      clientSide.on('message', (m) => resolve(m));
      clientSide.on('close', () => resolve(null));
      s.on('connect', () => clientSide.send({ v: 42 }));
    });
    // Close BOTH ends: raw.close() only stops listening; leaving the
    // established connection open kept a Socket handle alive and prevented
    // the process from exiting when the runner finished.
    try { clientSide.close(); } catch { /* ignore */ }
    try { if (serverSide) serverSide.close(); } catch { /* ignore */ }
    raw.close();
    assert.ok(got && got.type === 'echo_ok' && got.got === 42, 'framed JSON round-trip works');
  });

  await test('ipc: wrong secret is rejected', async () => {
    const server = createIpcServer({ port: 0, secret: SECRET, logWarn: () => {} });
    const addr = await new Promise((res) => server.listen(res));
    const result = await new Promise((resolve) => {
      const s = net.connect(addr.port, '127.0.0.1');
      const f = attachFraming(s);
      f.on('message', (m) => {
        if (m.type === 'hello_ok') resolve('accepted');
      });
      f.on('close', () => resolve('rejected'));
      s.on('connect', () => f.send({ type: 'hello', secret: 'x'.repeat(64), clientId: 'evil' }));
      setTimeout(() => resolve('timeout'), 3000);
    });
    server.close();
    assert.strictEqual(result, 'rejected', 'unauthenticated client destroyed');
  });

  await test('ipc: non-loopback binding is refused (server listens on 127.0.0.1 only)', async () => {
    const server = createIpcServer({ port: 0, secret: SECRET });
    const addr = await new Promise((res) => server.listen(res));
    assert.strictEqual(addr.host, '127.0.0.1', 'never 0.0.0.0');
    server.close();
  });

  // ---------------- Channel registration & identity --------------------------

  await test('hub: valid registration creates a channel registry entry', async () => {
    const dir = tmpDir();
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(proj);
    const reg = createRegistry(path.join(dir, 'r.json'));
    const { hub } = makeHub(reg);
    const conn = await registerConn(hub, reg, { clientId: 'c-1', project: proj, projectName: 'NDS', claudeSessionId: '0e5b3a2e-1d2f-4c6b-9a3f-0000000000a1' });
    const ack = conn.sent.find((m) => m.type === 'register_ack');
    assert.ok(ack, 'register_ack sent');
    const entry = reg.getByName('nds');
    assert.ok(entry, 'registry entry created');
    assert.strictEqual(entry.transport, 'channel');
    assert.strictEqual(entry.connected, true);
    assert.strictEqual(entry.claudeSessionId, '0e5b3a2e-1d2f-4c6b-9a3f-0000000000a1');
    assert.strictEqual(entry.pid, 1234);
    assert.ok(hub.isOnline(entry.id));
  });

  await test('hub: registration without project is NAKed', () => {
    const dir = tmpDir();
    const reg = createRegistry(path.join(dir, 'r.json'));
    const { hub } = makeHub(reg);
    const conn = fakeConn();
    hub.onConnection({ conn, hello: { clientId: 'c-x', secret: SECRET } });
    conn.fire({ type: 'register', registration: {} });
    assert.ok(conn.sent.some((m) => m.type === 'register_nak'), 'register_nak sent');
  });

  await test('hub: reconnect with same clientId rebinds (no duplicate records)', async () => {
    const dir = tmpDir();
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(proj);
    const reg = createRegistry(path.join(dir, 'r.json'));
    const { hub } = makeHub(reg);
    const c1 = await registerConn(hub, reg, { clientId: 'same', project: proj, projectName: 'NDS' });
    const entry1 = reg.getByName('nds');
    // simulate disconnect
    c1.destroy(); // fires the hub's close listener
    assert.strictEqual(reg.getByName('nds').connected, false, 'offline after disconnect');
    // reconnect with the SAME clientId
    const c2 = await registerConn(hub, reg, { clientId: 'same', project: proj, projectName: 'NDS' });
    const entry2 = reg.getByName('nds');
    assert.strictEqual(entry2.id, entry1.id, 'same registry entry reused');
    assert.strictEqual(entry2.connected, true);
    assert.strictEqual(reg.list().length, 1, 'no duplicate records');
    assert.ok(hub.isOnline(entry2.id));
  });

  await test('hub: disconnect marks offline, attachment survives but inactive', async () => {
    const dir = tmpDir();
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(proj);
    const reg = createRegistry(path.join(dir, 'r.json'));
    const { hub } = makeHub(reg);
    const conn = await registerConn(hub, reg, { clientId: 'c-9', project: proj, projectName: 'NDS' });
    const entry = reg.getByName('nds');
    reg.attach('555', entry.id);
    conn.destroy(); // fires the hub's close listener
    assert.strictEqual(reg.get(entry.id).connected, false);
    assert.strictEqual(reg.attached('555').id, entry.id, 'attachment mapping persists');
    assert.strictEqual(hub.deliver(entry.id, { content: 'x', meta: {} }).error, 'session_offline', 'delivery refused while offline');
  });

  await test('hub: two projects = two independent online sessions', async () => {
    const dir = tmpDir();
    const pA = path.join(dir, 'a');
    const pB = path.join(dir, 'b');
    fs.mkdirSync(pA);
    fs.mkdirSync(pB);
    const reg = createRegistry(path.join(dir, 'r.json'));
    const { hub } = makeHub(reg);
    await registerConn(hub, reg, { clientId: 'nds-1', project: pA, projectName: 'NDS' });
    await registerConn(hub, reg, { clientId: 'omni-1', project: pB, projectName: 'OmniRoute' });
    assert.strictEqual(reg.list().length, 2);
    const nds = reg.getByName('nds');
    const omni = reg.getByName('omniroute');
    assert.ok(hub.isOnline(nds.id) && hub.isOnline(omni.id));
  });

  // ---------------- Routing isolation ----------------------------------------

  await test('routing: message goes ONLY to the selected session', async () => {
    const dir = tmpDir();
    const pA = path.join(dir, 'a');
    const pB = path.join(dir, 'b');
    fs.mkdirSync(pA);
    fs.mkdirSync(pB);
    const reg = createRegistry(path.join(dir, 'r.json'));
    const { hub } = makeHub(reg);
    const cNds = await registerConn(hub, reg, { clientId: 'nds', project: pA, projectName: 'NDS' });
    const cOmni = await registerConn(hub, reg, { clientId: 'omni', project: pB, projectName: 'OmniRoute' });
    const nds = reg.getByName('nds');
    const omni = reg.getByName('omniroute');
    reg.attach('111', nds.id); // chat A -> NDS
    reg.attach('222', omni.id); // chat B -> OmniRoute

    // deliver to chat A's session; OmniRoute's conn must see nothing
    const r = hub.deliver(nds.id, { content: 'review node detection', meta: { chat_id: '111' } });
    assert.ok(r.ok);
    const deliveredNds = cNds.sent.find((m) => m.type === 'deliver');
    assert.ok(deliveredNds && deliveredNds.content === 'review node detection');
    assert.strictEqual(cOmni.sent.filter((m) => m.type === 'deliver').length, 0, 'wrong session received nothing');
    assert.strictEqual(deliveredNds.meta.chat_id, '111', 'chat_id rides in meta');
  });

  await test('routing: /switch changes the destination session', async () => {
    const dir = tmpDir();
    const pA = path.join(dir, 'a');
    const pB = path.join(dir, 'b');
    fs.mkdirSync(pA);
    fs.mkdirSync(pB);
    const reg = createRegistry(path.join(dir, 'r.json'));
    const { hub } = makeHub(reg);
    const cNds = await registerConn(hub, reg, { clientId: 'nds', project: pA, projectName: 'NDS' });
    const cOmni = await registerConn(hub, reg, { clientId: 'omni', project: pB, projectName: 'OmniRoute' });
    const nds = reg.getByName('nds');
    const omni = reg.getByName('omniroute');
    reg.attach('111', nds.id);
    reg.detach('111');
    reg.attach('111', omni.id); // /switch OmniRoute
    hub.deliver(omni.id, { content: 'now talk here', meta: { chat_id: '111' } });
    assert.ok(cOmni.sent.some((m) => m.type === 'deliver' && m.content === 'now talk here'));
    assert.strictEqual(cNds.sent.filter((m) => m.type === 'deliver').length, 0);
  });

  // ---------------- Reply / file tool gating ---------------------------------

  await test('channel tools: reply only to a chat the session is attached to', async () => {
    const dir = tmpDir();
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(proj);
    const reg = createRegistry(path.join(dir, 'r.json'));
    const { hub } = makeHub(reg);
    const first = await registerConn(hub, reg, { clientId: 'nds', project: proj, projectName: 'NDS' });
    const nds = reg.getByName('nds');
    const sentToTelegram = [];
    // The tool path runs on the hub's message routing for the authoritative
    // connection; use the registered one directly.
    const conn = first;
    // Simulate the Bridge-side tool handler (same logic as bridge.js):
    hub.onChannelTool(async (entry, tool, args) => {
      if (tool === 'reply') {
        const attached = reg.attached(String(args.chat_id));
        if (!attached || attached.id !== entry.id) throw new Error('session is not attached to that chat');
        sentToTelegram.push({ chatId: args.chat_id, text: args.text });
        return { sent: true };
      }
      throw new Error(`unknown tool: ${tool}`);
    });
    reg.attach('999', nds.id);
    // invoke the tool path via the hub's message routing
    conn.fire({ type: 'tool_call', tool: 'reply', callId: 't1', args: { chat_id: '999', text: 'hi from claude' } });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(sentToTelegram, [{ chatId: '999', text: 'hi from claude' }]);
    const okResult = conn.sent.find((m) => m.type === 'tool_result' && m.callId === 't1');
    assert.ok(okResult && okResult.result && okResult.result.sent);
  });

  await test('channel tools: reply to an unrelated chat is rejected', async () => {
    const dir = tmpDir();
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(proj);
    const reg = createRegistry(path.join(dir, 'r.json'));
    const { hub } = makeHub(reg);
    const conn = await registerConn(hub, reg, { clientId: 'nds', project: proj, projectName: 'NDS' });
    const nds = reg.getByName('nds');
    const sentToTelegram = [];
    hub.onChannelTool(async (entry, tool, args) => {
      if (tool === 'reply') {
        const attached = reg.attached(String(args.chat_id));
        if (!attached || attached.id !== entry.id) throw new Error('session is not attached to that chat');
        sentToTelegram.push(args);
        return { sent: true };
      }
      throw new Error(`unknown tool: ${tool}`);
    });
    reg.attach('777', nds.id);
    conn.fire({ type: 'tool_call', tool: 'reply', callId: 't2', args: { chat_id: '31337', text: 'injection' } });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(sentToTelegram.length, 0, 'unmapped chat never receives a message');
    const errResult = conn.sent.find((m) => m.type === 'tool_result' && m.callId === 't2');
    assert.ok(errResult && /not attached/.test(errResult.error));
  });

  // ---------------- Fix 3: queued task final result --------------------------

  await test('queue fix: second queued task resolves with ITS OWN final result', async () => {
    const dir = tmpDir();
    const child = (() => {
      const handlers = {};
      return {
        pid: 1, exitCode: null, signalCode: null,
        stdin: { write: (d) => (handlers.stdin = (handlers.stdin || []).concat(d)), on: () => {} },
        stdout: { on: (ev, fn) => { handlers['out:' + ev] = fn; } },
        stderr: { on: () => {} },
        on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
        kill() {},
        fireOut(line) { handlers['out:data'](Buffer.from(line)); },
        handlers,
      };
    })();
    const entry = { id: 'x', name: 'n', project: dir, claudeSessionId: null, initialized: false, status: 'idle', pid: null };
    const ms = createManagedSession(entry, { command: 'claude.exe', prefixArgs: [] }, { spawnFn: () => child });
    ms.start();
    const pA = ms.submitTask('task A');
    const pB = ms.submitTask('task B'); // queued behind A
    // A completes:
    child.fireOut(JSON.stringify({ type: 'result', subtype: 'success', result: 'A done' }) + '\n');
    const rA = await pA;
    assert.strictEqual(rA.summary, 'A done');
    // B now runs; its result must resolve pB:
    child.fireOut(JSON.stringify({ type: 'result', subtype: 'success', result: 'B done' }) + '\n');
    const rB = await pB;
    assert.strictEqual(rB.summary, 'B done', 'queued caller receives its own final result (was previously lost)');
    assert.strictEqual(rB.queued, undefined);
  });

  await test('queue fix: kill fails queued waiters instead of hanging them', async () => {
    const dir = tmpDir();
    const child = (() => {
      const handlers = {};
      return {
        pid: 1, exitCode: null, signalCode: null,
        stdin: { write: () => {}, on: () => {} },
        stdout: { on: (ev, fn) => { handlers['out:data'] = fn; } },
        stderr: { on: () => {} },
        on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
        kill() {},
        handlers,
      };
    })();
    const entry = { id: 'x', name: 'n', project: dir, claudeSessionId: null, initialized: false, status: 'idle', pid: null };
    const ms = createManagedSession(entry, { command: 'claude.exe', prefixArgs: [] }, { spawnFn: () => child });
    ms.start();
    const pA = ms.submitTask('A');
    const pB = ms.submitTask('B');
    ms.kill('stopped');
    const rB = await Promise.race([pB, new Promise((r) => setTimeout(() => r('HUNG'), 500))]);
    assert.notStrictEqual(rB, 'HUNG', 'queued waiter must not hang after kill');
    assert.strictEqual(rB.ok, false);
    assert.ok(/cancelled before start/.test(rB.summary));
  });

  // ---------------- Fix 4: rollback snapshot ordering ------------------------

  await test('rollback: failed save after /attach restores PRE-mutation attachments', async () => {
    const dir = tmpDir();
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(proj);
    const reg = createRegistry(path.join(dir, 'r.json'));
    const a = reg.create({ name: 'alpha', project: proj }).entry;
    const b = reg.create({ name: 'beta', project: proj }).entry;
    reg.attach('1', a.id);
    // simulate the manager's correct order: snapshot BEFORE attach mutation
    let fail = true;
    const origSave = reg.save;
    reg.save = () => (fail ? Promise.reject(new Error('disk gone')) : origSave.call(reg));
    const snap = reg.snapshot(); // 1. pre-mutation
    const r = reg.attach('1', b.id); // 2. mutate
    assert.ok(r.ok);
    await reg.save().catch(() => {}); // 3. fails
    reg.restore(snap); // 4. rollback
    assert.strictEqual(reg.attached('1').id, a.id, 'attachment rolled back to pre-mutation state');
    // and the same through the manager:
    const mgr = createClaudeManager({ reg, launch: { command: 'x', prefixArgs: [] }, spawnFn: () => ({ pid: 1, exitCode: null, on: () => {}, stdin: { write: () => {}, on: () => {} }, stdout: { on: () => {} }, stderr: { on: () => {} }, kill() {} }), saveDelayMs: 5 });
    fail = true;
    await mgr.attach('1', b.id); // withPersist: snapshot->mutate->save-fail->restore
    await new Promise((r2) => setTimeout(r2, 30));
    assert.strictEqual(reg.attached('1').id, a.id, 'manager withPersist restores exactly the previous state');
    reg.save = origSave;
    mgr.stopAll();
  });

  await test('rollback: failed save after create removes the new session, keeps the old', async () => {
    const dir = tmpDir();
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(proj);
    const reg = createRegistry(path.join(dir, 'r.json'));
    const a = reg.create({ name: 'keep', project: proj }).entry;
    let fail = true;
    const origSave = reg.save;
    reg.save = () => (fail ? Promise.reject(new Error('disk gone')) : origSave.call(reg));
    const mgr = createClaudeManager({
      reg,
      launch: { command: 'x', prefixArgs: [] },
      spawnFn: () => ({ pid: 1, exitCode: null, on: () => {}, stdin: { write: () => {}, on: () => {} }, stdout: { on: () => {} }, stderr: { on: () => {} }, kill() {} }),
      saveDelayMs: 5,
    });
    const created = mgr.createSession({ name: 'fresh', project: proj });
    assert.ok(created.ok, 'mutation applied');
    await new Promise((r) => setTimeout(r, 30)); // wait for the failed persist + rollback
    assert.ok(reg.getByName('keep'), 'pre-existing session survives');
    assert.strictEqual(reg.getByName('fresh'), null, 'new session rolled back on failed save');
    reg.save = origSave;
    mgr.stopAll();
  });

  // ---------------- Persistence: channel fields survive restart --------------

  await test('persistence: channel identity + attachments round-trip', async () => {
    const dir = tmpDir();
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(proj);
    const file = path.join(dir, 'r.json');
    const reg = createRegistry(file);
    const e = reg.create({ name: 'work', project: proj }).entry;
    reg.applyChannelIdentity(e.id, { channelName: 'telegram-bridge', claudeSessionId: '0e5b3a2e-1d2f-4c6b-9a3f-0000000000cc', pid: 4321, claudeVersion: '2.1.267' });
    reg.attach('31', e.id);
    await reg.save();
    const reg2 = createRegistry(file);
    const e2 = reg2.getByName('work');
    assert.strictEqual(e2.transport, 'channel');
    assert.strictEqual(e2.channelName, 'telegram-bridge');
    assert.strictEqual(e2.claudeVersion, '2.1.267');
    assert.strictEqual(e2.connected, false, 'connected is runtime-only, persisted false');
    assert.strictEqual(reg2.attached('31').id, e2.id);
  });

  // ---------------------------------------------------------------------------

  const summary = failures.length
    ? `\n${passed} passed, ${failures.length} FAILED`
    : `\nAll ${passed} channel tests passed.`;
  console.log(summary);
  if (failures.length) process.exit(1);
})().catch((err) => {
  console.error('channel runner crashed:', err);
  process.exit(1);
});
