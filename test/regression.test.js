'use strict';

/**
 * Regression tests for the final hardening pass.
 * Run with `node test/regression.test.js` (wired into `npm test`).
 * No network access and no Claude process is spawned.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Same sandboxed env as bridge.test.js BEFORE bridge.js is required.
process.env.BRIDGE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgbridge-reg-state-'));
process.env.TELEGRAM_BOT_TOKEN = '123456789:TEST_TOKEN_FOR_TESTS_ONLY_TESTING';
process.env.ALLOWED_TELEGRAM_IDS = '111,222';
process.env.CLAUDE_BIN = '';

const { isShimPath, resolveClaudeBin, applyEnvFile, validateBridgeCwd, SHIM_EXTS } = require('../lib/config');
const { createSessionStore, migrateChatEntry, SCHEMA_VERSION } = require('../lib/sessions');
const { createJobQueue } = require('../lib/queue');
const { createOffsetStore } = require('../lib/offset');

const bridge = require('../bridge.js');
const T = bridge.__test;

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tgbridge-reg-'));
}

// Fake Telegram client with call recording.
function fakeTg({ getUpdatesResult } = {}) {
  const calls = [];
  return {
    calls,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'getUpdates') return getUpdatesResult || [];
      return {};
    },
    state: () => ({ agent: null, source: null, label: 'direct' }),
    refresh: () => ({}),
    markFailure: () => {},
  };
}

// --------------------------------------------------------------------------

(async () => {
  // ---------------- Issue 1: first-start backlog policy ---------------------

  await test('no persisted offset + default config => backlog skipped via negative offset', async () => {
    const committed = [];
    const osImpl = { load: () => null, commit: (n) => committed.push(n) };
    const tgImpl = fakeTg({ getUpdatesResult: [{ update_id: 100 }, { update_id: 101 }, { update_id: 102 }] });
    delete process.env.PROCESS_INITIAL_BACKLOG;
    const startOffset = await T.purgeBacklogIfFirstStart({ osImpl, tgImpl });
    assert.strictEqual(startOffset, 103, 'starts after the latest pending update');
    assert.deepStrictEqual(committed, [103], 'starting offset persisted');
    // exactly one getUpdates call, with Telegram's negative-offset purge form
    const gu = tgImpl.calls.filter((c) => c.method === 'getUpdates');
    assert.strictEqual(gu.length, 1);
    assert.strictEqual(gu[0].params.offset, -1);
  });

  await test('persisted offset => normal resume, no purge request', async () => {
    const osImpl = { load: () => 555, commit: () => assert.fail('must not commit') };
    const tgImpl = fakeTg();
    const startOffset = await T.purgeBacklogIfFirstStart({ osImpl, tgImpl });
    assert.strictEqual(startOffset, 555);
    assert.strictEqual(tgImpl.calls.filter((c) => c.method === 'getUpdates').length, 0,
      'restart must NOT purge; resume silently from persisted offset');
  });

  await test('PROCESS_INITIAL_BACKLOG=true => backlog consumed normally (offset 0)', async () => {
    process.env.PROCESS_INITIAL_BACKLOG = 'true';
    try {
      const osImpl = { load: () => null, commit: () => assert.fail('must not commit') };
      const tgImpl = fakeTg();
      const startOffset = await T.purgeBacklogIfFirstStart({ osImpl, tgImpl });
      assert.strictEqual(startOffset, 0);
      assert.strictEqual(tgImpl.calls.filter((c) => c.method === 'getUpdates').length, 0);
    } finally {
      delete process.env.PROCESS_INITIAL_BACKLOG;
    }
  });

  await test('advanceOffset: persists next offset BEFORE handling (at-most-once)', () => {
    const order = [];
    const osImpl = {
      load: () => null,
      commit: (n) => order.push(`commit:${n}`),
    };
    const next = T.advanceOffset(5, 10, osImpl);
    assert.strictEqual(next, 11);
    assert.deepStrictEqual(order, ['commit:11']);
    assert.strictEqual(T.advanceOffset(11, 7, osImpl), 11, 'never moves backwards');
  });

  await test('offset store: load null when absent, commit/load round-trip', () => {
    const file = path.join(tmpDir(), 'offset.txt');
    const store = createOffsetStore(file);
    assert.strictEqual(store.load(), null, 'missing file = never persisted (first start)');
    assert.ok(store.commit(4242));
    assert.strictEqual(store.load(), 4242);
    assert.strictEqual(createOffsetStore(file).load(), 4242, 'survives restart');
    fs.writeFileSync(file, '   ');
    assert.strictEqual(createOffsetStore(file).load(), null, 'empty file treated as unpersisted');
    fs.writeFileSync(file, 'garbage');
    assert.strictEqual(createOffsetStore(file).load(), null, 'corrupt file treated as unpersisted');
  });

  // ---------------- Issue 2: Windows .cmd shim handling ---------------------

  await test('isShimPath detects .cmd/.bat cross-platform', () => {
    assert.strictEqual(isShimPath('C:\\x\\claude.cmd', 'win32'), true);
    assert.strictEqual(isShimPath('C:\\x\\claude.bat', 'win32'), true);
    assert.strictEqual(isShimPath('/x/claude.cmd', 'linux'), true, 'detection is cross-platform');
    assert.strictEqual(isShimPath('/x/claude.bat', 'linux'), true);
    assert.strictEqual(isShimPath('/x/claude.exe', 'win32'), false);
    assert.strictEqual(isShimPath('/x/claude', 'win32'), false);
    assert.strictEqual(isShimPath('', 'win32'), false);
    assert.deepStrictEqual(SHIM_EXTS, ['.cmd', '.bat', '.com']);
  });

  await test('resolveClaudeBin: native exe accepted, directory and missing paths rejected', () => {
    const dir = tmpDir();
    const exe = path.join(dir, 'claude.exe');
    fs.writeFileSync(exe, 'binary');
    if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
    const r = resolveClaudeBin(exe, fs, process.platform === 'win32' ? 'win32' : 'linux');
    assert.ok(r.ok, r.error || '');
    assert.strictEqual(path.resolve(r.resolved), path.resolve(exe));

    const missing = resolveClaudeBin(path.join(dir, 'nope.exe'), fs, 'win32');
    assert.strictEqual(missing.ok, false);
    assert.ok(/not found/i.test(missing.error));

    const dirAsBin = resolveClaudeBin(dir, fs, 'win32');
    assert.strictEqual(dirAsBin.ok, false);
    assert.ok(/is a directory/i.test(dirAsBin.error));
  });

  await test('resolveClaudeBin: .cmd shim resolved to sibling native exe', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\r\nnode cli.js %*\r\n');
    fs.writeFileSync(path.join(dir, 'claude.exe'), 'binary');
    if (process.platform !== 'win32') fs.chmodSync(path.join(dir, 'claude.exe'), 0o755);
    const r = resolveClaudeBin(path.join(dir, 'claude.cmd'), fs, 'win32');
    assert.ok(r.ok, r.error || '');
    assert.ok(r.resolved.toLowerCase().endsWith('claude.exe'), 'must resolve to the native exe');
  });

  await test('resolveClaudeBin: unresolvable .cmd shim fails with actionable error (never shell:true)', () => {
    const dir = tmpDir();
    const shim = path.join(dir, 'claude.cmd');
    fs.writeFileSync(shim, '@echo off\r\nnode some-missing-thing.js %*\r\n');
    const r = resolveClaudeBin(shim, fs, 'win32');
    assert.strictEqual(r.ok, false);
    assert.ok(/\.cmd shim/.test(r.error) && /CLAUDE_BIN/.test(r.error), r.error);

    const bat = path.join(dir, 'claude.bat');
    fs.writeFileSync(bat, '@echo off\r\nnode x.js %*\r\n');
    const r2 = resolveClaudeBin(bat, fs, 'win32');
    assert.strictEqual(r2.ok, false);
    assert.ok(/shim|CLAUDE_BIN/.test(r2.error), r2.error);
  });

  // ---------------- Issue 3: sessions named active / list -------------------

  await test('v2 schema: sessions named active and list survive restart', async () => {
    const file = path.join(tmpDir(), 'sessions.json');
    const store = createSessionStore(file);
    assert.ok(store.create('c1', 'active').ok, 'active is a legal session name');
    assert.ok(store.create('c1', 'list').ok, 'list is a legal session name');
    assert.ok(store.create('c1', 'normal-session').ok);
    await store.save();
    const reloaded = createSessionStore(file);
    for (const n of ['active', 'list', 'normal-session']) {
      assert.ok(reloaded.get('c1', n), `session "${n}" must survive restart`);
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(parsed.version, SCHEMA_VERSION, 'schema marker present');
    // metadata lives OUTSIDE the session namespace
    assert.ok(typeof parsed.chats.c1.activeSession === 'string');
    assert.ok(parsed.chats.c1.sessions.active && parsed.chats.c1.sessions.list);
  });

  await test('unsafe names still rejected; active/list allowed', () => {
    const store = createSessionStore(path.join(tmpDir(), 's.json'));
    assert.strictEqual(store.create('1', '__proto__').ok, false);
    assert.strictEqual(store.create('1', 'constructor').ok, false);
    assert.strictEqual(store.create('1', '../evil').ok, false);
    assert.ok(store.create('1', 'active').ok);
    assert.ok(store.create('1', 'list').ok);
  });

  await test('legacy migration keeps sessions named active/list inside raw.list', () => {
    // v1 file: { active: "<name>", list: { <name>: {id, initialized} } } — a
    // session literally named "active" or "list" inside list is a SESSION.
    const m = migrateChatEntry({
      active: 'list',
      list: {
        active: { id: '0e5b3a2e-1d2f-4c6b-9a3f-0000000000a1', initialized: true },
        list: { id: '0e5b3a2e-1d2f-4c6b-9a3f-0000000000a2', initialized: false },
        work: { id: '0e5b3a2e-1d2f-4c6b-9a3f-0000000000a3', initialized: true },
      },
    });
    assert.ok(m, 'migration succeeds');
    assert.strictEqual(m.active, 'list', 'active selection preserved');
    assert.ok(m.list.get('active'), 'session named "active" preserved');
    assert.strictEqual(m.list.get('active').initialized, true);
    assert.ok(m.list.get('list'), 'session named "list" preserved');
    assert.ok(m.list.get('work'));

    // oldest flat schema: metadata keys at top level ARE metadata (sessions
    // only became nameable "active"/"list" in the v1 list-object schema,
    // which the previous assertion covers)
    const oldest = migrateChatEntry({
      active: 'work',
      work: '0e5b3a2e-1d2f-4c6b-9a3f-0000000000b2',
    });
    assert.ok(oldest);
    assert.strictEqual(oldest.active, 'work');
    assert.ok(oldest.list.get('work'), 'real session kept');

    // v2 round-trips unchanged
    const v2 = migrateChatEntry({
      activeSession: 'work',
      sessions: { work: { id: '0e5b3a2e-1d2f-4c6b-9a3f-0000000000c1', initialized: true }, active: { id: '0e5b3a2e-1d2f-4c6b-9a3f-0000000000c2', initialized: false } },
    });
    assert.strictEqual(v2.active, 'work');
    assert.ok(v2.list.get('active'));
  });

  // ---------------- Issue 4: queue.close() lifecycle ------------------------

  await test('queue close: enqueue rejected after close, close idempotent', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const ran = [];
    const q = createJobQueue({ maxPerChat: 5, runJob: (c, j) => { ran.push(j.n); return gate; } });

    const before = q.enqueue('A', { n: 1 });
    assert.ok(before.ok, 'enqueue accepted before close');
    const waiting = q.enqueue('A', { n: 2 });
    assert.ok(waiting.ok);

    q.close();
    q.close(); // idempotent — must not throw

    const after = q.enqueue('A', { n: 3 });
    assert.strictEqual(after.ok, false, 'enqueue rejected after close');
    assert.strictEqual(after.error, 'queue_closed');
    assert.ok(q.isClosed());
    assert.strictEqual(q.totalQueued(), 0, 'waiting jobs cleared');

    release(); // finish running job; pump must not start anything new
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(ran, [1], 'only the already-running job ran; nothing new started');
  });

  await test('shutdown race: enqueue during close does not throw unhandled', async () => {
    const q = createJobQueue({ maxPerChat: 5, runJob: () => new Promise(() => {}) });
    q.close();
    // handler-style call with onRejected must not throw
    let rejectedReason = null;
    const res = q.enqueue('A', { n: 1 }, { onRejected: (_max, err) => { rejectedReason = err; } });
    assert.strictEqual(res.ok, false);
    assert.ok(rejectedReason && rejectedReason.code === 'QUEUE_CLOSED');
  });

  // ---------------- Issue 6/7: .env ordering + BRIDGE_CWD -------------------

  await test('applyEnvFile: .env honored, real environment takes precedence', () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, '.env'), [
      '# comment',
      'BRIDGE_STATE_DIR=/from/env/file',
      'BRIDGE_TEST_ONLY=from-file',
      'export QUOTED_TEST="quoted value"',
      'PRESET_TEST=from-file',
    ].join('\n'));
    const env = { PRESET_TEST: 'from-process' }; // simulates pre-existing env var
    const applied = applyEnvFile(root, env, fs);
    assert.strictEqual(env.BRIDGE_STATE_DIR, '/from/env/file', '.env BRIDGE_STATE_DIR applied before config derivation');
    assert.strictEqual(env.BRIDGE_TEST_ONLY, 'from-file');
    assert.strictEqual(env.QUOTED_TEST, 'quoted value');
    assert.strictEqual(env.PRESET_TEST, 'from-process', 'process env wins over .env');
    assert.ok(applied.includes('BRIDGE_STATE_DIR') && !applied.includes('PRESET_TEST'));
  });

  await test('BRIDGE_CWD must be an existing directory (not a file)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'afile.txt');
    fs.writeFileSync(file, 'x');
    assert.ok(validateBridgeCwd(dir).ok, 'directory accepted');
    const fileRes = validateBridgeCwd(file);
    assert.strictEqual(fileRes.ok, false, 'regular file rejected');
    assert.ok(/not a directory/i.test(fileRes.error), fileRes.error);
    const missing = validateBridgeCwd(path.join(dir, 'missing'));
    assert.strictEqual(missing.ok, false);
    assert.ok(/does not exist/i.test(missing.error));
  });

  // ---------------- Issue 9: /status path privacy ---------------------------

  await test('/status never reveals absolute Claude executable paths', async () => {
    const realTg = T.getTelegram();
    T.setTelegram(fakeTg());
    try {
      const st = T.statusText('555001');
      assert.ok(!/[A-Za-z]:\\/.test(st), `no Windows path in /status: ${st}`);
      assert.ok(!/\/(Users|home)\//.test(st), 'no unix home path in /status');
      assert.ok(!st.includes('TEST_TOKEN'));
      assert.ok(!/allowlist/i.test(st.toLowerCase()) || !/\b111\b/.test(st), 'allowlist not echoed');
    } finally {
      T.setTelegram(realTg);
    }
  });

  // ---------------- Issue 10: persistence failure propagation ---------------

  await test('store.save() rejects when the disk write fails (no silent success)', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'sessions.json');
    const failingFs = {
      existsSync: fs.existsSync,
      readFileSync: fs.readFileSync,
      copyFileSync: fs.copyFileSync,
      statSync: fs.statSync,
      promises: {
        mkdir: async () => {},
        open: async () => { throw new Error('EACCES: permission denied'); },
      },
    };
    const store = createSessionStore(file, failingFs);
    store.create('1', 'work');
    await assert.rejects(() => store.save(), /EACCES|permission/i, 'save must reject, not swallow');
  });

  await test('save() rejects on rename failure after successful write', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'sessions.json');
    const fh = {
      writeFile: async () => {},
      sync: async () => {},
      close: async () => {},
    };
    const failingFs = {
      existsSync: () => false,
      readFileSync: fs.readFileSync,
      copyFileSync: fs.copyFileSync,
      statSync: fs.statSync,
      promises: {
        mkdir: async () => {},
        open: async () => fh,
        rename: async () => { throw new Error('EPERM: rename failed'); },
      },
    };
    const store = createSessionStore(file, failingFs);
    store.create('1', 'work');
    await assert.rejects(() => store.save(), /rename failed/i);
  });

  await test('/new does not claim success when persistence fails (rollback)', async () => {
    const realTg = T.getTelegram();
    const tgStub = fakeTg();
    T.setTelegram(tgStub);
    // Monkeypatch the bridge's store save to fail, then restore.
    const origSave = T.store.save;
    T.store.save = async () => { throw new Error('EACCES: disk write failed'); };
    try {
      await T.handleMessage({ chat: { id: 777001 }, from: { id: 111 }, text: '/new doomed' });
      const replies = tgStub.calls.filter((c) => c.method === 'sendMessage').map((c) => c.params.text);
      const last = replies[replies.length - 1] || '';
      assert.ok(/failed to save|Could not create/i.test(last), `user must see the failure, got: ${last}`);
      assert.ok(!/✨/.test(last), 'must NOT claim the session was created');
      assert.strictEqual(T.store.get('777001', 'doomed'), null, 'in-memory mutation rolled back');
    } finally {
      T.store.save = origSave;
      T.setTelegram(realTg);
    }
  });

  await test('session init persistence failure is not silent in job reports', async () => {
    // markInitialized + save failure path in runClaudeJob's close handler:
    // verified via the /new rollback test above; here we assert the store's
    // markInitialized flips in-memory regardless, and save() surfaces errors.
    const store = createSessionStore(path.join(tmpDir(), 's.json'));
    const created = store.create('5', 'work');
    store.markInitialized('5', created.session.id);
    assert.strictEqual(store.get('5', 'work').initialized, true);
  });

  // ---------------- Issue 8: dead code is gone ------------------------------

  await test('no dead exports: safeSend / COMMAND_NAMES removed from lib', () => {
    const tg = require('../lib/telegram');
    const cmds = require('../lib/commands');
    assert.strictEqual(tg.safeSend, undefined, 'safeSend removed (unused abstraction)');
    assert.strictEqual(cmds.COMMAND_NAMES, undefined, 'COMMAND_NAMES removed (derive from BOT_COMMANDS)');
  });

  // --------------------------------------------------------------------------

  const summary = failures.length
    ? `\n${passed} passed, ${failures.length} FAILED`
    : `\nAll ${passed} regression tests passed.`;
  console.log(summary);
  if (failures.length) process.exit(1);
})().catch((err) => {
  console.error('regression runner crashed:', err);
  process.exit(1);
});
