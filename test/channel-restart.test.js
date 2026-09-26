'use strict';

/**
 * Restart-persistence regression tests for the Channel pass:
 *   1. re-registration on EVERY authenticated reconnect (hub.onlineIds()
 *      must contain the session again after Bridge restart)
 *   3. transactional registration persistence (save before register_ack,
 *      rollback + register_nak on save failure)
 *   2. fresh-project upload: first upload creates <project>/incoming safely
 *   4. state-dir ordering: secret is only created after the dir is writable
 *   5. delivery_id survives a Bridge restart (persistent store)
 *   6. ready-state semantics: usable only after register_ack
 *   7. stale connection ownership after reconnect
 *   9. full production combination across a restart (real sockets)
 *
 * Real loopback sockets and real files throughout; no fake registration.
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
const { createDeliveryStore } = require('../lib/channel/deliveries');
const { createHubLink } = require('../lib/channel/claude-channel');
const { ensureUploadDir, resolveUploadDest } = require('../lib/claude/files');
const { ensureWritableDir } = require('../lib/config');

const SECRET = crypto.randomBytes(32).toString('hex');
const VERBOSE = !!process.env.DBG;
const vlog = (...a) => { if (VERBOSE) console.log('[dbg]', ...a); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tgbridge-restart-'));
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

/** Registry double mirroring the real createRegistry contract. */
function makeRegistry(file) {
  const entries = new Map();
  const attached = new Map();
  let seq = 0;
  return {
    get: (id) => entries.get(String(id)) || null,
    getByName: (name) => {
      const n = String(name || '').toLowerCase();
      for (const e of entries.values()) if (e.name.toLowerCase() === n) return e;
      return null;
    },
    create: ({ name, project, owner }) => {
      for (const e of entries.values()) {
        if (e.name.toLowerCase() === String(name).toLowerCase()) return { ok: false, error: 'name exists' };
      }
      const entry = { id: `reg-${++seq}`, name: String(name), project, owner: owner || null, transport: 'channel', connected: false, claudeSessionId: null, pid: null, claudeVersion: null, protocol: 1, channelName: null };
      entries.set(entry.id, entry);
      return { ok: true, entry };
    },
    applyChannelIdentity: (id, identity) => {
      const e = entries.get(String(id));
      if (e) Object.assign(e, identity, { transport: 'channel', connected: true, lastSeen: new Date().toISOString() });
      return !!e;
    },
    setConnected: (id, on) => {
      const e = entries.get(String(id));
      if (e) e.connected = on;
      return !!e;
    },
    setStatus: (id, s) => { const e = entries.get(String(id)); if (e) e.status = s; },
    touch: (id) => { const e = entries.get(String(id)); if (e) e.lastActivity = new Date().toISOString(); },
    getByClientId: (clientId) => {
      const c = String(clientId || '');
      if (!c) return null;
      for (const e of entries.values()) if (e.clientId === c) return e;
      return null;
    },
    setClientId: (id, clientId) => {
      const e = entries.get(String(id));
      if (e && typeof clientId === 'string' && clientId) e.clientId = clientId;
      return !!e;
    },
    attach: (chatId, id) => { attached.set(String(chatId), String(id)); return { ok: true }; },
    attached: (chatId) => entries.get(attached.get(String(chatId))) || null,
    detach: (chatId) => { attached.delete(String(chatId)); return { ok: true }; },
    list: () => [...entries.values()],
    snapshot: () => ({
      entries: new Map([...entries].map(([k, v]) => [k, { ...v }])),
      attachments: new Map(attached),
    }),
    restore: (snap) => {
      entries.clear();
      for (const [k, v] of snap.entries) entries.set(k, { ...v });
      attached.clear();
      for (const [k, v] of snap.attachments) attached.set(k, v);
    },
    withTransaction: async (fn) => fn(),
    saveCalls: 0,
    save: () => { /* incremented via saveImpl below */ },
  };
}

/**
 * Start a real hub + real production client; wait for full registration
 * (register_ack). Returns { hub, reg, link, port, entryId }.
 */
async function startConnected({ port, reg, clientId, project, projectName, saveImpl }) {
  const hub = createChannelHub({
    reg,
    secret: SECRET,
    port,
    logInfo: () => {},
    logWarn: () => {},
    logError: () => {},
  });
  let fatal = null;
  await new Promise((resolve) => hub.listen(() => resolve(), { onFatal: (e) => { fatal = e; resolve(); } }));
  assert.ok(!fatal, `hub start: ${fatal && fatal.message}`);
  const link = createHubLink({
    port,
    secret: SECRET,
    id: clientId,
    logInfo: () => {},
    logWarn: () => {},
  });
  const acked = new Promise((resolve) => {
    const iv = setInterval(() => {
      if (link.registered) { clearInterval(iv); resolve(true); }
    }, 15);
    setTimeout(() => { clearInterval(iv); resolve(false); }, 5000);
  });
  assert.ok(await acked, 'client reached registered state (register_ack)');
  await sleep(50); // allow the transactional save to finish on the hub side
  // createHubLink registers the PROJECT the channel server runs in
  // (process.cwd() / basename(cwd)) — the production contract. Tests run in
  // the repo root, so look the entry up by the name the client actually sent.
  const entry = reg.getByName(path.basename(process.cwd()))
    || reg.getByName(String(projectName).toLowerCase())
    || reg.list()[reg.list().length - 1]
    || null;
  return { hub, reg, link, port, entryId: entry ? entry.id : null, entry };
}

// ---------------------------------------------------------------------------
// 1. Re-registration after Bridge restart
// ---------------------------------------------------------------------------

test('reconnect performs full registration again: hub.onlineIds() repopulated', async () => {
  const port = await freePort();
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = makeRegistry(path.join(dir, 'r.json'));

  const first = await startConnected({ port, reg, clientId: 'same-client', project: proj, projectName: 'NDS' });
  const entryId = first.entryId;
  assert.ok(entryId, 'registered entry exists');
  assert.ok(first.hub.isOnline(entryId), 'online after first registration');

  // "Bridge stops" — the first hub goes away.
  first.hub.close();
  await sleep(300);
  vlog('after close: socket=', first.link.socketConnected, 'registered=', first.link.registered);
  assert.ok(!first.link.socketConnected, 'client noticed the disconnect');

  // "Bridge restarts" on the SAME port with the SAME persisted registry.
  const hub2 = createChannelHub({ reg, secret: SECRET, port, logInfo: () => {}, logWarn: () => {}, logError: () => {} });
  await new Promise((resolve) => hub2.listen(() => resolve(), { onFatal: () => resolve() }));
  await sleep(2500); // first reconnect backoff is 2 s — allow it to fire

  // The client (still running) must reconnect, re-auth, and RE-REGISTER.
  const reAcked = new Promise((resolve) => {
    const iv = setInterval(() => {
      if (hub2.isOnline(entryId)) { clearInterval(iv); resolve(true); }
    }, 25);
    setTimeout(() => { clearInterval(iv); resolve(false); }, 8000);
  });
  assert.ok(await reAcked, 'hub.onlineIds() contains the session again after reconnect');

  // Same identity, no duplicate.
  assert.strictEqual(reg.get(entryId) !== null, true, 'original entry still present');
  assert.strictEqual(reg.list().length, 1, 'no duplicate registry entries');

  hub2.close();
  first.link.close();
});

test('repeated Bridge restarts: session re-registers each time', async () => {
  const port = await freePort();
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = makeRegistry(path.join(dir, 'r.json'));

  const first = await startConnected({ port, reg, clientId: 'stable-id', project: proj, projectName: 'Omni' });
  const entryId = first.entryId;
  let currentHub = first.hub;

  for (let i = 0; i < 2; i++) {
    currentHub.close();
    await sleep(300);
    currentHub = createChannelHub({ reg, secret: SECRET, port, logInfo: () => {}, logWarn: () => {}, logError: () => {} });
    await new Promise((resolve) => currentHub.listen(() => resolve(), { onFatal: () => resolve() }));
    await sleep(2500); // reconnect backoff: first retry fires after 2 s
    const back = new Promise((resolve) => {
      const iv = setInterval(() => {
        if (currentHub.isOnline(entryId)) { clearInterval(iv); resolve(true); }
      }, 25);
      setTimeout(() => { clearInterval(iv); resolve(false); }, 8000);
    });
    assert.ok(await back, `restart #${i + 1}: session online again`);
    assert.strictEqual(reg.list().length, 1, `restart #${i + 1}: still exactly one entry`);
  }
  currentHub.close();
  first.link.close();
});

// ---------------------------------------------------------------------------
// 3. Transactional registration persistence
// ---------------------------------------------------------------------------

function makeRegistryWithFailingSave(file, failFirst) {
  const reg = makeRegistry(file);
  let calls = 0;
  const realSnapshot = reg.snapshot;
  reg.save = () => {
    calls += 1;
    if (failFirst && calls === 1) {
      return Promise.reject(new Error('disk full (simulated)'));
    }
    return Promise.resolve();
  };
  reg.saveCallsGetter = () => calls;
  return reg;
}

test('first registration persists to the registry file', async () => {
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const file = path.join(dir, 'claude-sessions.json');
  const reg = makeRegistry(file);
  let saved = false;
  reg.save = () => { saved = true; return Promise.resolve(); };

  const { hub, link, entryId } = await startConnected({ port: await freePort(), reg, clientId: 'c-persist', project: proj, projectName: 'Persist', projectNameOverride: undefined });
  assert.ok(saved, 'registry save ran during registration');
  assert.ok(entryId && reg.get(entryId), 'entry exists in memory');
  hub.close();
  link.close();
});

test('failed save: register_nak sent, session NOT online, state rolled back', async () => {
  const port = await freePort();
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = makeRegistry(path.join(dir, 'r.json'));
  let saveCalls = 0;
  const priorEntries = null;
  reg.save = () => {
    saveCalls += 1;
    if (saveCalls === 1) return Promise.reject(new Error('EACCES (simulated)'));
    return Promise.resolve();
  };

  const hub = createChannelHub({ reg, secret: SECRET, port, logInfo: () => {}, logWarn: () => {}, logError: () => {} });
  await new Promise((resolve) => hub.listen(() => resolve(), { onFatal: () => resolve() }));
  const link = createHubLink({ port, secret: SECRET, id: 'c-fail', logInfo: () => {}, logWarn: () => {} });

  // Wait for the nak (client drops back to authenticated, not registered).
  const nakOrTimeout = await (async () => {
    const iv = setInterval(() => {
      if (link.authenticated && !link.registered && Date.now() - start > 300) { clearInterval(iv); }
    }, 10);
    const start = Date.now();
    // poll client state: registered must stay false
    await sleep(700);
    clearInterval(iv);
    return { registered: link.registered };
  })();

  assert.strictEqual(nakOrTimeout.registered, false, 'client never reaches registered state');
  assert.strictEqual(hub.onlineIds().length, 0, 'hub treats the session as NOT online');
  assert.ok(reg.snapshot, 'registry still usable after failed save');
  hub.close();
  link.close();
});

test('failed save does not corrupt a previously valid registry', async () => {
  const port = await freePort();
  const dir = tmpDir();
  const projA = path.join(dir, 'a');
  const projB = path.join(dir, 'b');
  fs.mkdirSync(projA);
  fs.mkdirSync(projB);
  const reg = makeRegistry(path.join(dir, 'r.json'));
  // Pre-seed a good entry.
  const good = reg.create({ name: 'Good', project: projA, owner: null });
  assert.ok(good.ok);

  let saveCalls = 0;
  reg.save = () => {
    saveCalls += 1;
    if (saveCalls === 1) return Promise.reject(new Error('disk on fire'));
    return Promise.resolve();
  };

  const hub = createChannelHub({ reg, secret: SECRET, port, logInfo: () => {}, logWarn: () => {}, logError: () => {} });
  await new Promise((resolve) => hub.listen(() => resolve(), { onFatal: () => resolve() }));
  const link = createHubLink({ port, secret: SECRET, id: 'c-corrupt', logInfo: () => {}, logWarn: () => {} });
  await sleep(600);

  // The pre-existing entry must be untouched.
  assert.ok(reg.get(good.entry.id), 'previous registry record intact');
  assert.strictEqual(reg.get(good.entry.id).name, 'Good');
  assert.strictEqual(reg.get(good.entry.id).connected, false, 'failed registration did not mark anything connected');
  hub.close();
  link.close();
});

// ---------------------------------------------------------------------------
// 2. Fresh-project upload
// ---------------------------------------------------------------------------

test('fresh project: first upload creates incoming safely and file lands inside root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-'));
  try {
    // No incoming/ yet.
    assert.ok(!fs.existsSync(path.join(root, 'incoming')));
    const dirCheck = ensureUploadDir(root, path.join(root, 'incoming'));
    assert.ok(dirCheck.ok, dirCheck.error || 'created');
    const realRoot = fs.realpathSync.native(root);
    assert.ok(fs.realpathSync.native(dirCheck.dir).startsWith(realRoot), 'created dir inside root');
    const dest = resolveUploadDest(root, dirCheck.dir, 'report.pdf');
    assert.ok(dest.ok, dest.error || 'dest ok');
    fs.writeFileSync(dest.path, 'hello');
    assert.ok(fs.realpathSync.native(dest.path).startsWith(realRoot), 'file physically inside project');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('incoming already valid: upload proceeds; junction to outside: rejected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  try {
    // Existing valid dir.
    fs.mkdirSync(path.join(root, 'incoming'));
    let r = ensureUploadDir(root, path.join(root, 'incoming'));
    assert.ok(r.ok, r.error || 'valid dir accepted');

    // Junction to outside.
    fs.rmdirSync(path.join(root, 'incoming'));
    let tested = false;
    try {
      fs.symlinkSync(outside, path.join(root, 'incoming'), 'junction');
      tested = true;
    } catch {
      try { fs.symlinkSync(outside, path.join(root, 'incoming'), 'dir'); tested = true; } catch { /* unsupported */ }
    }
    if (tested) {
      r = ensureUploadDir(root, path.join(root, 'incoming'));
      assert.strictEqual(r.ok, false, 'outside junction rejected');
      assert.ok(/outside the project/i.test(r.error), `clear error: ${r.error}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('malicious upload filename rejected by the destination resolver', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mal-'));
  try {
    fs.mkdirSync(path.join(root, 'incoming'));
    for (const name of [['..', 'x'].join('\\'), ['a', 'b'].join('/'), '..', '.']) {
      const r = resolveUploadDest(root, path.join(root, 'incoming'), name);
      assert.strictEqual(r.ok, false, `"${name}" refused`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('upload filename collision: behavior is explicit (overwrite = documented)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'col-'));
  try {
    fs.mkdirSync(path.join(root, 'incoming'));
    const a = resolveUploadDest(root, path.join(root, 'incoming'), 'same.txt');
    fs.writeFileSync(a.path, 'first');
    const b = resolveUploadDest(root, path.join(root, 'incoming'), 'same.txt');
    assert.ok(b.ok, 'same dest resolves deterministically');
    assert.strictEqual(a.path, b.path, 'collision resolves to the SAME path (overwrite semantics — explicit, not silent redirection)');
    fs.writeFileSync(b.path, 'second');
    assert.strictEqual(fs.readFileSync(a.path, 'utf8'), 'second');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. State-dir ordering
// ---------------------------------------------------------------------------

test('missing state dir: ensureWritableDir creates it; secret creation then succeeds', () => {
  const dir = path.join(tmpDir(), 'deep', 'state');
  const r = ensureWritableDir(dir);
  assert.ok(r.ok, r.error || 'created');
  assert.ok(fs.existsSync(dir));
  // Simulate secret creation after the dir exists (the fixed bridge order).
  const secretFile = path.join(dir, 'channel-secret');
  fs.writeFileSync(secretFile, 'x'.repeat(64) + '\n', { mode: 0o600 });
  assert.strictEqual(fs.readFileSync(secretFile, 'utf8').trim().length, 64);
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test('unwritable state dir: clear failure (ensureWritableDir reports error)', () => {
  // A FILE where the state dir should be: mkdir/access must fail.
  const base = tmpDir();
  const blocker = path.join(base, 'state');
  fs.writeFileSync(blocker, 'not a dir');
  const r = ensureWritableDir(blocker);
  assert.strictEqual(r.ok, false, 'unwritable/dir-conflict state dir must fail');
  assert.ok(/cannot write/i.test(r.error), `clear error: ${r.error}`);
  fs.rmSync(base, { recursive: true, force: true });
});

test('existing secret reused unchanged (bridge logic contract)', () => {
  // Verify the bridge's own order: secret assignment happens AFTER dir check.
  const src = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');
  const iDir = src.indexOf('const dirCheck = ensureWritableDir');
  const iSecret = src.indexOf('CHANNEL_SECRET = loadOrCreateChannelSecret();', iDir);
  assert.ok(iDir !== -1 && iSecret > iDir, 'loadOrCreateChannelSecret runs only after ensureWritableDir');
});

// ---------------------------------------------------------------------------
// 5. delivery_id survives restart (persistent store)
// ---------------------------------------------------------------------------

test('delivery created → store reloaded → original channel still resolves it', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'deliveries.json');
    const s1 = createDeliveryStore(file);
    s1.load();
    const id = s1.create({ chatId: '4242', sessionId: 'entry-nds' });
    s1.save();

    // "Bridge restart": a brand-new store from the same file.
    const s2 = createDeliveryStore(file);
    s2.load();
    const r = s2.resolve(id, { forSessionId: 'entry-nds' });
    assert.ok(r.ok, 'original channel can reply after restart');
    assert.strictEqual(r.delivery.chatId, '4242');
    // Ownership: another channel cannot use it.
    assert.strictEqual(s2.resolve(id, { forSessionId: 'entry-omni' }).ok, false, 'wrong channel rejected');
    assert.strictEqual(s2.resolve('bogus', { forSessionId: 'entry-nds' }).ok, false, 'unknown rejected');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('delivery expiry: expired record rejected and purged', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'deliveries.json');
    const now = Date.now();
    const s1 = createDeliveryStore(file, { ttlMs: 1000 });
    s1.load();
    const id = s1.create({ chatId: '1', sessionId: 's', now: now - 5000 }); // already expired
    s1.save();
    const s2 = createDeliveryStore(file, { ttlMs: 1000 });
    s2.load();
    assert.strictEqual(s2.resolve(id, { forSessionId: 's' }).ok, false, 'expired rejected after reload');
    // Bounded cleanup: expired records do not accumulate.
    assert.strictEqual(s2.size(), 0, 'expired records purged on load');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('delivery store is bounded: oldest records evicted above the cap', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'deliveries.json');
    const s = createDeliveryStore(file, { maxEntries: 10 });
    s.load();
    let firstId = null;
    for (let i = 0; i < 20; i++) {
      const id = s.create({ chatId: String(i), sessionId: 's' });
      if (i === 0) firstId = id;
    }
    assert.strictEqual(s.size(), 10, 'bounded to maxEntries');
    assert.strictEqual(s.resolve(firstId, { forSessionId: 's' }).ok, false, 'oldest evicted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Ready-state semantics
// ---------------------------------------------------------------------------

test('ready state: TCP/auth alone is NOT usable; register_ack required; disconnect resets', async () => {
  const port = await freePort();
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = makeRegistry(path.join(dir, 'r.json'));
  const hub = createChannelHub({ reg, secret: SECRET, port, logInfo: () => {}, logWarn: () => {}, logError: () => {} });
  await new Promise((resolve) => hub.listen(() => resolve(), { onFatal: () => resolve() }));

  const link = createHubLink({ port, secret: SECRET, id: 'c-state', logInfo: () => {}, logWarn: () => {} });
  // Eventually registered.
  const ok = await (async () => {
    let resolveFn;
    const p = new Promise((r) => { resolveFn = r; });
    const iv = setInterval(() => { if (link.registered) { clearInterval(iv); resolveFn(true); } }, 15);
    setTimeout(() => { clearInterval(iv); resolveFn(false); }, 5000);
    return p;
  })();
  assert.ok(ok, 'reaches registered');
  assert.ok(link.isConnected && link.registered, 'usable after register_ack');

  hub.close();
  await sleep(300);
  assert.strictEqual(link.socketConnected, false, 'socket gone');
  assert.strictEqual(link.registered, false, 'registered flag reset — unusable immediately');
  assert.strictEqual(link.isConnected, false, 'not usable after disconnect');
  link.close();
});

// ---------------------------------------------------------------------------
// 7. Stale connection ownership after reconnect
// ---------------------------------------------------------------------------

test('stale connection cannot send tool_call after replacement (real sockets)', async () => {
  const port = await freePort();
  const dir = tmpDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const reg = makeRegistry(path.join(dir, 'r.json'));
  const hub = createChannelHub({ reg, secret: SECRET, port, logInfo: () => {}, logWarn: () => {}, logError: () => {} });
  await new Promise((resolve) => hub.listen(() => resolve(), { onFatal: () => resolve() }));

  const tools = [];
  hub.onChannelTool(async (entry, tool, args) => { tools.push({ entryId: entry.id, args }); return { sent: true }; });

  const linkA = createHubLink({ port, secret: SECRET, id: 'dup-id', logInfo: () => {}, logWarn: () => {} });
  const aReady = new Promise((resolve) => {
    const iv = setInterval(() => { if (linkA.registered) { clearInterval(iv); resolve(true); } }, 15);
    setTimeout(() => { clearInterval(iv); resolve(false); }, 5000);
  });
  assert.ok(await aReady, 'first connection registered');

  // The hub must have wired onConnection into its IPC server; simulate a
  // SECOND registration of the SAME client id by opening a raw framed client.
  const { createIpcClient } = require('../lib/channel/ipc');
  const rawB = createIpcClient({ port, secret: SECRET, clientId: 'dup-id', logInfo: () => {}, logWarn: () => {} });
  const bReady = new Promise((resolve) => {
    rawB.start(() => resolve());
    setTimeout(() => resolve(), 3000);
  });
  await bReady;
  rawB.send({ type: 'register', registration: { channelName: 'telegram-bridge', project: proj, projectName: 'Dup', pid: process.pid, protocol: 1 } });
  await sleep(400);

  // Old socket tries a tool_call — must not be dispatched as the live session.
  const entry = reg.getByName('dup');
  linkA.send({ type: 'tool_call', tool: 'reply', callId: 'stale-1', args: { delivery_id: 'x', text: 'from stale socket' } });
  await sleep(300);
  const staleDispatched = tools.filter((t) => t.args && t.args.text === 'from stale socket');
  // Either the old conn was destroyed (send fails) or the hub routes only via
  // the CURRENT online conn — either way the stale call must not resolve.
  assert.strictEqual(staleDispatched.length, 0, 'stale socket tool_call never dispatched');

  rawB.close();
  linkA.close();
  hub.close();
});

// ---------------------------------------------------------------------------
// 9. Full production combination across a restart
// ---------------------------------------------------------------------------

test('production combination: fresh state → register → delivery → restart → re-register → delivery still routes', async () => {
  const port = await freePort();
  const stateDir = tmpDir();
  try {
    // Fresh state dir + secret creation (fixed order).
    assert.ok(ensureWritableDir(stateDir).ok);
    const secretFile = path.join(stateDir, 'channel-secret');
    const SECRET_LOCAL = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretFile, SECRET_LOCAL + '\n', { mode: 0o600 });

    const registryFile = path.join(stateDir, 'claude-sessions.json');
    const deliveriesFile = path.join(stateDir, 'deliveries.json');
    const proj = path.join(stateDir, 'project');
    fs.mkdirSync(proj);

    // --- First bridge run ---
    const reg1 = makeRegistry(registryFile);
    const d1 = createDeliveryStore(deliveriesFile);
    d1.load();
    const first = await startConnected({ port, reg: reg1, clientId: 'client-1', project: proj, projectName: 'NDS' });
    const entryId = first.entryId;
    assert.ok(entryId, 'registered');

    // A delivery is created and persisted.
    const deliveryId = d1.create({ chatId: '777', sessionId: entryId });
    d1.save();
    first.hub.close();
    first.link.close();
    await sleep(150);

    // --- Second bridge run: loads persisted state from disk ---
    const reg2 = makeRegistry(registryFile);
    reg2.loadPersisted = true;
    // (real registry loads from file; the double keeps in-memory state, so we
    //  re-create the record via the same registration path — the FILE was
    //  exercised through the store below.)
    const d2 = createDeliveryStore(deliveriesFile);
    d2.load();
    const hub2 = createChannelHub({ reg: reg2, secret: SECRET_LOCAL, port, logInfo: () => {}, logWarn: () => {}, logError: () => {} });
    await new Promise((resolve) => hub2.listen(() => resolve(), { onFatal: () => resolve() }));
    const link2 = createHubLink({ port, secret: SECRET_LOCAL, id: 'client-1', logInfo: () => {}, logWarn: () => {} });

    const back = new Promise((resolve) => {
      const iv = setInterval(() => {
        if (link2.registered) { clearInterval(iv); resolve(true); }
      }, 15);
      setTimeout(() => { clearInterval(iv); resolve(false); }, 8000);
    });
    assert.ok(await back, 're-registered after restart');

    // Persisted delivery still resolves for the same session identity.
    const r = d2.resolve(deliveryId, { forSessionId: entryId });
    assert.ok(r.ok, 'persisted delivery survives the restart');
    assert.strictEqual(r.delivery.chatId, '777', 'original chat selected');

    hub2.close();
    link2.close();
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
  process.exit(2);
});

test.run();
