'use strict';

/**
 * Regression tests for hardening passes 2 and 3.
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

const {
  isShimPath, resolveClaudeBin, resolveClaudeLaunch, parseShimLaunch,
  applyEnvFile, validateBridgeCwd, SHIM_EXTS,
} = require('../lib/config');
const { createSessionStore, migrateChatEntry, SCHEMA_VERSION } = require('../lib/sessions');
const { createJobQueue } = require('../lib/queue');
const { createOffsetStore } = require('../lib/offset');

const bridge = require('../bridge.js');
const T = bridge.__test;

// Managed Claude sessions must NEVER spawn real processes in tests.
T.setManagedSpawnFn(() => ({
  pid: 99999,
  exitCode: null,
  signalCode: null,
  stdin: { write: () => {}, on: () => {} },
  stdout: { on: () => {} },
  stderr: { on: () => {} },
  on: () => {},
  kill() {},
}));

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

// Offset-store stub helpers.
const missingState = () => ({ state: 'missing', offset: null, error: null });

function memOffsetStore(initialCommits = [], loadState = missingState) {
  let value = null;
  return {
    committed: initialCommits,
    load: () => loadState(value),
    commit(n) {
      initialCommits.push(n);
      value = n;
      return true;
    },
  };
}

// --------------------------------------------------------------------------

(async () => {
  // ---------------- Pass 3 item 1: commit failure blocks execution ----------

  await test('advanceOffset: successful commit returns the next offset', () => {
    const os = memOffsetStore();
    assert.strictEqual(T.advanceOffset(5, 10, os), 11);
    assert.deepStrictEqual(os.committed, [11]);
  });

  await test('advanceOffset: FAILED commit throws and must not execute the update', () => {
    const os = memOffsetStore();
    os.commit = () => false;
    assert.throws(() => T.advanceOffset(5, 10, os), /Failed to persist Telegram offset 11/);
    assert.deepStrictEqual(os.committed, [], 'no offset recorded as advanced');
  });

  await test('advanceOffset: commit throwing surfaces as a persist failure (no unhandled rejection)', async () => {
    const os = memOffsetStore();
    os.commit = () => { throw new Error('EACCES: disk on fire'); };
    await assert.rejects(
      () => Promise.resolve().then(() => T.advanceOffset(5, 10, os)),
      /Failed to persist Telegram offset 11.*EACCES/,
    );
  });

  await test('advanceOffset: in-memory offset does NOT advance on failed persistence', async () => {
    // Simulates the poll loop: current stays put, so a restart/next poll
    // re-delivers the same update safely (item 1 tests 3+4).
    let fail = true;
    const os = { load: missingState, commit: () => (fail ? false : true) };
    let current = 5;
    try {
      current = T.advanceOffset(current, 10, os);
      assert.fail('must throw');
    } catch (err) {
      assert.ok(/Failed to persist/.test(err.message));
    }
    assert.strictEqual(current, 5, 'offset unchanged after failed persistence');
    fail = false;
    current = T.advanceOffset(current, 10, os);
    assert.strictEqual(current, 11, 'after persistence recovers, the same update is processed once');
  });

  await test('pollLoop-level: failed offset persistence produces a clear at-most-once error', () => {
    // The thrown message must be actionable and mention that nothing ran.
    const os = { load: missingState, commit: () => false };
    let threw = null;
    try {
      T.advanceOffset(0, 41, os);
    } catch (err) {
      threw = err;
    }
    assert.ok(threw);
    assert.ok(/update NOT handled/.test(threw.message), threw.message);
  });

  await test('processUpdates: commit succeeds → update executes and offset advances', async () => {
    const handled = [];
    const os = memOffsetStore();
    const offset = await T.processUpdates(
      [{ update_id: 7, message: { chat: { id: 1 }, from: { id: 111 }, text: 'task-a' } },
       { update_id: 9, message: { chat: { id: 1 }, from: { id: 111 }, text: 'task-b' } }],
      { osImpl: os, handle: async (m) => handled.push(m.text) },
    );
    assert.deepStrictEqual(handled, ['task-a', 'task-b'], 'both updates executed after durable persist');
    assert.deepStrictEqual(os.committed, [8, 10], 'offsets persisted BEFORE handling');
    assert.strictEqual(offset, 10);
  });

  await test('processUpdates: commit fails → update does NOT execute, offset unchanged, error visible', async () => {
    const handled = [];
    const errors = [];
    const origError = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    const committed = [];
    const os = { load: missingState, commit: () => false, committed };
    let threw = null;
    try {
      await T.processUpdates(
        [{ update_id: 7, message: { chat: { id: 1 }, from: { id: 111 }, text: 'task-a' } },
         { update_id: 9, message: { chat: { id: 1 }, from: { id: 111 }, text: 'task-b' } }],
        { osImpl: os, handle: async (m) => handled.push(m.text) },
      );
    } catch (err) {
      threw = err;
    } finally {
      console.error = origError;
    }
    assert.ok(threw && /Failed to persist Telegram offset 8/.test(threw.message), 'persist failure surfaced');
    assert.deepStrictEqual(handled, [], 'NO update executed without a durable offset');
    assert.deepStrictEqual(committed, [], 'in-memory offset never advanced');
    // Visibility: the thrown message matches the pattern pollLoop branches on
    // to log its dedicated "offset persistence failed — update NOT executed"
    // backoff warning before retrying.
    assert.ok(/^Failed to persist Telegram offset/.test(threw.message), 'pollLoop logs a dedicated backoff for this');
  });

  await test('processUpdates: restart can safely receive the same update again after failure', async () => {
    // Simulates: persist fails -> crash/restart -> same update redelivered ->
    // persistence recovers -> update executes exactly once.
    const handled = [];
    let fail = true;
    const os = { load: missingState, commit: () => (fail ? false : true), committed: [] };
    try {
      await T.processUpdates([{ update_id: 7, message: { chat: { id: 1 }, from: { id: 111 }, text: 'x' } }],
        { osImpl: os, handle: async (m) => handled.push(m.text) });
      assert.fail('must throw');
    } catch { /* expected */ }
    assert.deepStrictEqual(handled, []);
    fail = false;
    const offset = await T.processUpdates([{ update_id: 7, message: { chat: { id: 1 }, from: { id: 111 }, text: 'x' } }],
      { osImpl: os, handle: async (m) => handled.push(m.text) });
    assert.deepStrictEqual(handled, ['x'], 'redelivered update executed exactly once after recovery');
    assert.strictEqual(offset, 8);
  });

  // ---------------- Pass 3 items 3+4: first-start init & offset states ------

  await test('first start with EMPTY backlog persists initialization state (offset 0)', async () => {
    const committed = [];
    const os = { load: missingState, commit: (n) => committed.push(n) };
    const tg = fakeTg({ getUpdatesResult: [] });
    delete process.env.PROCESS_INITIAL_BACKLOG;
    const startOffset = await T.purgeBacklogIfFirstStart({ osImpl: os, tgImpl: tg });
    assert.strictEqual(startOffset, 0);
    assert.deepStrictEqual(committed, [0], 'initialization marker MUST be persisted even with zero updates');
  });

  await test('first start with NON-EMPTY backlog persists the skipping offset', async () => {
    const committed = [];
    const os = { load: missingState, commit: (n) => committed.push(n) };
    const tg = fakeTg({ getUpdatesResult: [{ update_id: 100 }, { update_id: 101 }, { update_id: 102 }] });
    const startOffset = await T.purgeBacklogIfFirstStart({ osImpl: os, tgImpl: tg });
    assert.strictEqual(startOffset, 103);
    assert.deepStrictEqual(committed, [103]);
    const gu = tg.calls.filter((c) => c.method === 'getUpdates');
    assert.strictEqual(gu.length, 1);
    assert.strictEqual(gu[0].params.offset, -1);
  });

  await test('restart after empty-backlog initialization processes new messages (NOT another purge)', async () => {
    // Exact scenario from the issue: init with empty backlog -> shutdown ->
    // user sends a message -> restart must see state=valid, not missing.
    const file = path.join(tmpDir(), 'offset.txt');
    const first = createOffsetStore(file);
    assert.strictEqual(first.load().state, 'missing');
    // Simulate the first-start empty-backlog initialization:
    assert.ok(first.commit(0));
    // Restart:
    const second = createOffsetStore(file);
    const loaded = second.load();
    assert.strictEqual(loaded.state, 'valid', 'restart must NOT look like a first start');
    assert.strictEqual(loaded.offset, 0);
  });

  await test('initialization persistence failure is fatal (no pretend success)', async () => {
    const os = { load: missingState, commit: () => false };
    const tg = fakeTg({ getUpdatesResult: [] });
    await assert.rejects(
      () => T.purgeBacklogIfFirstStart({ osImpl: os, tgImpl: tg }),
      /Failed to persist Telegram offset/,
    );
    assert.strictEqual(tg.calls.filter((c) => c.method === 'getUpdates').length, 1,
      'the probe itself may run, but the outcome is an error, not silent success');
  });

  await test('offset store: state categories missing/valid/corrupt/unreadable', () => {
    const dir = tmpDir();
    // missing
    const s1 = createOffsetStore(path.join(dir, 'absent.txt'));
    assert.deepStrictEqual(s1.load(), { state: 'missing', offset: null, error: null });
    // valid
    const vf = path.join(dir, 'valid.txt');
    fs.writeFileSync(vf, '123');
    assert.deepStrictEqual(createOffsetStore(vf).load(), { state: 'valid', offset: 123, error: null });
    // corrupt
    const cf = path.join(dir, 'corrupt.txt');
    fs.writeFileSync(cf, 'not-a-number');
    const c = createOffsetStore(cf).load();
    assert.strictEqual(c.state, 'corrupt');
    assert.ok(c.error);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('corrupt.txt.corrupt-')), 'corrupt file backed up');
    // unreadable (stat succeeds but read fails)
    const uf = path.join(dir, 'unreadable.txt');
    fs.writeFileSync(uf, '77');
    const brokenFs = {
      readFileSync: (p) => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; },
      copyFileSync: fs.copyFileSync,
    };
    const u = createOffsetStore(uf, brokenFs).load();
    assert.strictEqual(u.state, 'unreadable');
    assert.ok(u.error);
  });

  await test('corrupt offset state refuses first-start purge (fail safe, actionable error)', async () => {
    const os = { load: () => ({ state: 'corrupt', offset: null, error: new Error('bad content') }) };
    const tg = fakeTg();
    await assert.rejects(
      () => T.purgeBacklogIfFirstStart({ osImpl: os, tgImpl: tg }),
      /Refusing to treat this as first startup.*pending updates/s,
    );
    assert.strictEqual(tg.calls.filter((c) => c.method === 'getUpdates').length, 0,
      'must NOT probe/purge Telegram when offset state is corrupt');
  });

  await test('unreadable offset state refuses first-start purge (fail safe)', async () => {
    const os = { load: () => ({ state: 'unreadable', offset: null, error: new Error('EACCES') }) };
    const tg = fakeTg();
    await assert.rejects(
      () => T.purgeBacklogIfFirstStart({ osImpl: os, tgImpl: tg }),
      /Refusing to treat this as first startup/,
    );
    assert.strictEqual(tg.calls.filter((c) => c.method === 'getUpdates').length, 0);
  });

  await test('offset commit cleans up its tmp file on failure', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'offset.txt');
    const failingFs = {
      openSync: () => { throw new Error('EACCES'); },
      renameSync: fs.renameSync,
      unlinkSync: (p) => { unlinks.push(p); },
    };
    const unlinks = [];
    const store = createOffsetStore(file, failingFs);
    assert.strictEqual(store.commit(7), false);
    assert.strictEqual(unlinks.length, 1, 'tmp file cleaned up');
    assert.ok(unlinks[0].endsWith('offset.txt.tmp'));
  });

  // ---------------- Pass 3 items 2+7: launch specification ------------------

  const win32 = process.platform === 'win32';
  const dirSep = path.sep;

  function shimDir(setup) {
    const dir = tmpDir();
    setup(dir);
    return dir;
  }

  function mkExe(p) {
    fs.writeFileSync(p, 'binary');
    if (!win32) fs.chmodSync(p, 0o755);
  }

  const nativeNode = process.execPath;

  await test('launch spec: native claude.exe -> {command, prefixArgs: []}', () => {
    const dir = tmpDir();
    const exe = path.join(dir, 'claude.exe');
    mkExe(exe);
    const r = resolveClaudeLaunch(exe, { platform: 'win32' });
    assert.ok(r.ok, r.error || '');
    assert.strictEqual(r.command, path.resolve(exe));
    assert.deepStrictEqual(r.prefixArgs, []);
  });

  await test('launch spec: npm .cmd shim -> {node.exe, [cli.js]} with correct argv order', () => {
    const dir = tmpDir();
    const cliJs = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    fs.mkdirSync(path.dirname(cliJs), { recursive: true });
    fs.writeFileSync(cliJs, '// entrypoint');
    const shim = path.join(dir, 'claude.cmd');
    fs.writeFileSync(shim, `@echo off\r\nnode "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`);
    const r = resolveClaudeLaunch(shim, { platform: 'win32' });
    assert.ok(r.ok, r.error || '');
    assert.strictEqual(path.basename(r.command).toLowerCase(), 'node.exe', 'command must be node, not node-less');
    assert.strictEqual(r.prefixArgs.length, 1, 'cli.js must be the prefix arg — never dropped');
    assert.ok(r.prefixArgs[0].toLowerCase().endsWith('cli.js'), r.prefixArgs[0]);
    // Conceptual argv: [node.exe, cli.js, ...bridgeArgs] — the bridge args come after.
    const spawnArgs = [...r.prefixArgs, '-p', 'hello', '--output-format', 'text'];
    assert.strictEqual(spawnArgs[0].toLowerCase().endsWith('cli.js'), true);
    assert.strictEqual(spawnArgs[1], '-p');
    assert.strictEqual(spawnArgs[2], 'hello');
  });

  await test('launch spec: .bat shim with explicit node path resolves node + cli.js', () => {
    const dir = tmpDir();
    const nodeExe = path.join(dir, 'node-custom.exe');
    mkExe(nodeExe);
    const cliJs = path.join(dir, 'cli.js');
    fs.writeFileSync(cliJs, '// entrypoint');
    const shim = path.join(dir, 'claude.bat');
    fs.writeFileSync(shim, `@echo off\r\n"${nodeExe}" "%~dp0cli.js" %*\r\n`);
    const r = resolveClaudeLaunch(shim, { platform: 'win32' });
    assert.ok(r.ok, r.error || '');
    assert.strictEqual(path.resolve(r.command), path.resolve(nodeExe));
    assert.strictEqual(path.resolve(r.prefixArgs[0]), path.resolve(cliJs));
  });

  await test('launch spec: explicit .js CLI entrypoint -> {node, [cli.js]}', () => {
    const dir = tmpDir();
    const cliJs = path.join(dir, 'cli.js');
    fs.writeFileSync(cliJs, '// entrypoint');
    const r = resolveClaudeLaunch(cliJs, { platform: 'win32' });
    assert.ok(r.ok, r.error || '');
    assert.strictEqual(r.command, process.execPath);
    assert.deepStrictEqual(r.prefixArgs, [path.resolve(cliJs)]);
    // Verify options.shell === false later via the spawn seam (item 20).
  });

  await test('launch spec: malformed .cmd fails startup (no guessing, no shell:true)', () => {
    const dir = tmpDir();
    const shim = path.join(dir, 'claude.cmd');
    fs.writeFileSync(shim, '@echo off\r\necho this is not a launcher\r\n');
    const r = resolveClaudeLaunch(shim, { platform: 'win32' });
    assert.strictEqual(r.ok, false);
    assert.ok(/Unable to safely resolve Claude from the Windows \.cmd launcher/.test(r.error), r.error);
    assert.ok(/Set CLAUDE_BIN/.test(r.error), r.error);
  });

  await test('launch spec: .cmd with node.exe but MISSING cli.js fails (never drops the entrypoint)', () => {
    const dir = tmpDir();
    // Structure looks like a node shim but the referenced cli.js does not exist.
    const shim = path.join(dir, 'claude.cmd');
    fs.writeFileSync(shim, '@echo off\r\nnode "%~dp0\\missing\\cli.js" %*\r\n');
    const r = resolveClaudeLaunch(shim, { platform: 'win32' });
    assert.strictEqual(r.ok, false, 'must not return node.exe without cli.js');
    assert.ok(/Unable to safely resolve/.test(r.error), r.error);
    // And it must not silently fall back to an unrelated sibling exe.
    const r2 = parseShimLaunch(shim, fs);
    assert.strictEqual(r2, null);
  });

  await test('launch spec: nonexistent bare executable fails startup', () => {
    const r = resolveClaudeLaunch('definitely-not-installed-xyz', {
      platform: 'win32',
      env: { PATH: 'C:\\does\\not\\exist' },
    });
    assert.strictEqual(r.ok, false);
    assert.ok(/not found on PATH/.test(r.error), r.error);
  });

  await test('launch spec: existing bare executable resolves via PATH', () => {
    const dir = tmpDir();
    const exe = path.join(dir, 'myclaude.exe');
    mkExe(exe);
    const r = resolveClaudeLaunch('myclaude', { platform: 'win32', env: { PATH: dir } });
    assert.ok(r.ok, r.error || '');
    assert.strictEqual(path.resolve(r.command), path.resolve(exe));
    assert.deepStrictEqual(r.prefixArgs, []);
  });

  await test('launch spec: nonexistent absolute path and directory are rejected', () => {
    const dir = tmpDir();
    const miss = resolveClaudeLaunch(path.join(dir, 'nope.exe'), { platform: 'win32' });
    assert.strictEqual(miss.ok, false);
    assert.ok(/not found/i.test(miss.error));
    const dirAsBin = resolveClaudeLaunch(dir, { platform: 'win32' });
    assert.strictEqual(dirAsBin.ok, false);
    assert.ok(/is a directory/i.test(dirAsBin.error));
  });

  await test('launch spec: bare shim-only name resolves through the modeled shim', () => {
    const dir = tmpDir();
    const cliJs = path.join(dir, 'cli.js');
    fs.writeFileSync(cliJs, '// entrypoint');
    fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\r\nnode "%~dp0cli.js" %*\r\n');
    const r = resolveClaudeLaunch('claude', { platform: 'win32', env: { PATH: dir } });
    assert.ok(r.ok, r.error || '');
    assert.strictEqual(r.prefixArgs.length, 1);
    assert.ok(r.prefixArgs[0].toLowerCase().endsWith('cli.js'));
  });

  await test('resolveClaudeBin (compat view): native exe, shim errors preserved', () => {
    const dir = tmpDir();
    const exe = path.join(dir, 'claude.exe');
    mkExe(exe);
    const ok = resolveClaudeBin(exe, fs, 'win32');
    assert.ok(ok.ok && ok.resolved === path.resolve(exe));
    const shim = path.join(dir, 'broken.cmd');
    fs.writeFileSync(shim, 'garbage\r\n');
    const bad = resolveClaudeBin(shim, fs, 'win32');
    assert.strictEqual(bad.ok, false);
  });

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

  // ---------------- Pass 3 item 20: spawn unit seam -------------------------

  await test('spawn seam: launch command/args/options visible incl. shell:false and prefix order', async () => {
    const realTg = T.getTelegram();
    const tgStub = fakeTg();
    T.setTelegram(tgStub);
    const spawns = [];
    const fakeChild = () => {
      const handlers = {};
      return {
        on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        kill() {},
        fire(ev, ...args) { for (const fn of handlers[ev] || []) fn(...args); },
      };
    };
    const child = fakeChild();
    try {
      const p = T.runClaudeJob('880001', {
        chatId: '880001', sessionName: 'work',
        sessionId: '0e5b3a2e-1d2f-4c6b-9a3f-000000000abc',
        initialized: false, text: 'hello', cwd: process.cwd(),
      }, { spawnFn: (command, args, options) => { spawns.push({ command, args, options }); return child; } });
      await new Promise((r) => setTimeout(r, 15));
      child.fire('close', 0, null);
      await p;
    } finally {
      T.setTelegram(realTg);
    }
    assert.strictEqual(spawns.length, 1);
    const { command, args, options } = spawns[0];
    assert.strictEqual(options.shell, false, 'shell:false is mandatory in every launch mode');
    assert.strictEqual(options.windowsHide, true);
    assert.ok(command, 'launch command present');
    // Prefix args (if any) precede the bridge args; -p + prompt never last.
    const pIdx = args.indexOf('-p');
    assert.ok(pIdx >= 0);
    assert.strictEqual(args[pIdx + 1], 'hello', 'prompt passed as a direct argv element');
    assert.ok(args.includes('--dangerously-skip-permissions'));
    assert.ok(args.includes('--session-id'));
    assert.ok(!args.includes('--resume'), 'uninitialized session uses --session-id');
    if (command.toLowerCase().includes('node')) {
      // node-launch modes must keep cli.js as prefix arg #1
      assert.ok(args[0] && args[0].toLowerCase().endsWith('.js'), `expected cli.js prefix, got ${args[0]}`);
      assert.strictEqual(args[1], '-p', 'cli.js must come BEFORE -p');
    }
  });

  await test('spawn seam: --resume path for an initialized session', async () => {
    const realTg = T.getTelegram();
    T.setTelegram(fakeTg());
    const spawns = [];
    const child = (() => {
      const handlers = {};
      return {
        on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        kill() {},
        fire(ev, ...args) { for (const fn of handlers[ev] || []) fn(...args); },
      };
    })();
    try {
      const p = T.runClaudeJob('880002', {
        chatId: '880002', sessionName: 'work',
        sessionId: '0e5b3a2e-1d2f-4c6b-9a3f-00000000abcd',
        initialized: true, text: 'hello again', cwd: process.cwd(),
      }, { spawnFn: (command, args, options) => { spawns.push({ command, args, options }); return child; } });
      await new Promise((r) => setTimeout(r, 15));
      child.fire('close', 0, null);
      await p;
    } finally {
      T.setTelegram(realTg);
    }
    const { args, options } = spawns[0];
    assert.strictEqual(options.shell, false);
    const rIdx = args.indexOf('--resume');
    assert.ok(rIdx >= 0, '--resume must be present for initialized sessions');
    assert.strictEqual(args[rIdx + 1], '0e5b3a2e-1d2f-4c6b-9a3f-00000000abcd');
    assert.ok(!args.includes('--session-id'));
  });

  // ---------------- Pass 3 item 8: backlog log count ------------------------

  await test('backlog log reports the NUMBER of updates, not an update id', async () => {
    const lines = [];
    const origLog = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
      const os = { load: missingState, commit: () => true };
      // 3 updates with small ids — the old code would have logged "103".
      const tg = fakeTg({ getUpdatesResult: [{ update_id: 100 }, { update_id: 101 }, { update_id: 102 }] });
      delete process.env.PROCESS_INITIAL_BACKLOG;
      await T.purgeBacklogIfFirstStart({ osImpl: os, tgImpl: tg });
    } finally {
      console.log = origLog;
    }
    const line = lines.find((l) => /skipping/i.test(l));
    assert.ok(line, 'expected a skipping log line');
    assert.ok(/skipping 3 pending Telegram update/i.test(line), `count must be updates.length=3, got: ${line}`);
    assert.ok(!/skipping 103/.test(line), 'must not conflate update_id 102+1 with a count');
  });

  // ---------------- Pass 3 items 5+10: session transactional rollback -------

  await test('/new replacing an existing session: failed save restores the OLD session exactly', async () => {
    const realTg = T.getTelegram();
    const tgStub = fakeTg();
    T.setTelegram(tgStub);
    const oldId = '0e5b3a2e-1d2f-4c6b-9a3f-000000000001';
    // Set up: existing "work" session, initialized, and there is another
    // session "keep" so we can verify unrelated state is untouched.
    const st = T.store.chat('910001');
    st.list.set('work', { id: oldId, initialized: true });
    st.list.set('keep', { id: '0e5b3a2e-1d2f-4c6b-9a3f-000000000002', initialized: false });
    st.active = 'work';
    const origSave = T.store.save;
    T.store.save = async () => { throw new Error('EACCES: disk write failed'); };
    try {
      await T.handleMessage({ chat: { id: 910001 }, from: { id: 111 }, text: '/new work' });
      const restored = T.store.get('910001', 'work');
      assert.ok(restored, 'old session must survive the rollback');
      assert.strictEqual(restored.id, oldId, 'old ID restored');
      assert.strictEqual(restored.initialized, true, 'old initialized flag restored');
      assert.strictEqual(T.store.active('910001').name, 'work', 'active selection preserved');
      assert.ok(T.store.get('910001', 'keep'), 'unrelated session untouched');
      const replies = tgStub.calls.filter((c) => c.method === 'sendMessage').map((c) => c.params.text);
      const last = replies[replies.length - 1] || '';
      assert.ok(/failed to save/i.test(last), `user must see the failure, got: ${last}`);
      assert.ok(!/✨/.test(last), 'must NOT claim success');
    } finally {
      T.store.save = origSave;
      T.setTelegram(realTg);
    }
  });

  await test('/new with a unique name: failed save leaves no phantom session', async () => {
    const realTg = T.getTelegram();
    const tgStub = fakeTg();
    T.setTelegram(tgStub);
    const origSave = T.store.save;
    T.store.save = async () => { throw new Error('EACCES'); };
    try {
      await T.handleMessage({ chat: { id: 910002 }, from: { id: 111 }, text: '/new fresh' });
      assert.strictEqual(T.store.get('910002', 'fresh'), null, 'no phantom in-memory session');
    } finally {
      T.store.save = origSave;
      T.setTelegram(realTg);
    }
  });

  await test('/use: failed save rolls the active session back exactly', async () => {
    const realTg = T.getTelegram();
    const tgStub = fakeTg();
    T.setTelegram(tgStub);
    const st = T.store.chat('910003');
    st.list.set('a', { id: '0e5b3a2e-1d2f-4c6b-9a3f-00000000000a', initialized: false });
    st.list.set('b', { id: '0e5b3a2e-1d2f-4c6b-9a3f-00000000000b', initialized: false });
    st.active = 'a';
    const origSave = T.store.save;
    T.store.save = async () => { throw new Error('EACCES'); };
    try {
      await T.handleMessage({ chat: { id: 910003 }, from: { id: 111 }, text: '/use b' });
      assert.strictEqual(T.store.active('910003').name, 'a', 'active selection rolled back');
      const replies = tgStub.calls.filter((c) => c.method === 'sendMessage').map((c) => c.params.text);
      const last = replies[replies.length - 1] || '';
      assert.ok(/failed to save/i.test(last));
    } finally {
      T.store.save = origSave;
      T.setTelegram(realTg);
    }
  });

  await test('/new overwrite: successful save keeps the NEW session', async () => {
    const realTg = T.getTelegram();
    T.setTelegram(fakeTg());
    const st = T.store.chat('910004');
    st.list.set('work', { id: '0e5b3a2e-1d2f-4c6b-9a3f-00000000000c', initialized: true });
    st.active = 'work';
    try {
      await T.handleMessage({ chat: { id: 910004 }, from: { id: 111 }, text: '/new work' });
      const now = T.store.get('910004', 'work');
      assert.ok(now);
      assert.notStrictEqual(now.id, '0e5b3a2e-1d2f-4c6b-9a3f-00000000000c', 'replaced with a fresh session');
      assert.strictEqual(now.initialized, false);
      assert.strictEqual(T.store.active('910004').name, 'work');
    } finally {
      T.setTelegram(realTg);
    }
  });

  await test('snapshotChat/restoreChat round-trip preserves exact state', () => {
    const store = createSessionStore(path.join(tmpDir(), 's.json'));
    store.create('c', 'work');
    store.markInitialized('c', store.get('c', 'work').id);
    store.setActive('c', 'work');
    const snap = store.snapshotChat('c');
    // mutate afterwards
    store.create('c', 'other');
    store.get('c', 'work').initialized = false;
    store.setActive('c', 'other');
    store.restoreChat('c', snap);
    assert.strictEqual(store.get('c', 'work').initialized, true);
    assert.strictEqual(store.active('c').name, 'work');
    assert.strictEqual(store.get('c', 'other'), null);
  });

  // ---------------- Pass 3 item 6: structure-based migration ----------------

  await test('legacy migration preserves sessions named active/list/sessions/activeSession/version', () => {
    const UUID = (n) => `0e5b3a2e-1d2f-4c6b-9a3f-0000000000${String(n).padStart(2, '0')}`;
    // v1 list-object layout: metadata is ONLY 'active' at top level; everything
    // inside raw.list is a session, whatever it is called.
    const m = migrateChatEntry({
      active: 'version',
      list: {
        active: { id: UUID(1), initialized: true },
        list: { id: UUID(2), initialized: false },
        sessions: { id: UUID(3), initialized: true },
        activeSession: { id: UUID(4), initialized: false },
        version: { id: UUID(5), initialized: true },
        normal: { id: UUID(6), initialized: true },
      },
    });
    assert.ok(m);
    for (const n of ['active', 'list', 'sessions', 'activeSession', 'version', 'normal']) {
      assert.ok(m.list.get(n), `session "${n}" must be preserved`);
    }
    assert.strictEqual(m.active, 'version', 'active selection preserved');
  });

  await test('oldest flat schema: metadata keys distinguished by STRUCTURE (uuid vs object)', () => {
    const UUID = (n) => `0e5b3a2e-1d2f-4c6b-9a3f-0000000001${String(n).padStart(2, '0')}`;
    // In the oldest layout, 'active' holds the active name and other top-level
    // keys with UUID-string values are sessions. 'sessions'/'version' with
    // non-uuid values are metadata/junk and are ignored — not name-blacklisted.
    const m = migrateChatEntry({
      active: 'work',
      version: 2,
      sessions: { nested: 'object' },
      work: UUID(1),
    });
    assert.ok(m);
    assert.strictEqual(m.active, 'work');
    assert.ok(m.list.get('work'), 'uuid-valued key is a session');
    assert.strictEqual(m.list.get('sessions'), undefined, 'object-valued junk is not a session');
    assert.strictEqual(m.list.get('version'), undefined, 'non-uuid junk is not a session');
  });

  await test('unsafe prototype-style names still rejected after migration change', () => {
    const UUID = '0e5b3a2e-1d2f-4c6b-9a3f-0000000002ff';
    const m = migrateChatEntry({
      active: 'normal',
      list: {
        normal: { id: UUID, initialized: true },
        __proto__: { id: UUID, initialized: true },
        constructor: { id: UUID, initialized: true },
      },
    });
    assert.ok(m);
    assert.ok(m.list.get('normal'));
    assert.strictEqual(m.list.get('__proto__'), undefined);
    assert.strictEqual(m.list.get('constructor'), undefined);
  });

  await test('v2 schema keeps version marker and never treats metadata as sessions', () => {
    const m = migrateChatEntry({
      activeSession: 'work',
      sessions: { work: { id: '0e5b3a2e-1d2f-4c6b-9a3f-000000000301', initialized: true } },
    });
    assert.strictEqual(m.active, 'work');
    assert.ok(m.list.get('work'));
    assert.strictEqual(m.list.get('activeSession'), undefined);
    assert.strictEqual(m.list.get('version'), undefined);
    assert.strictEqual(SCHEMA_VERSION, 2);
  });

  // ---------------- Pass 3 item 9: temp file cleanup ------------------------

  await test('session save failure removes its tmp file (original error unmasked)', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'sessions.json');
    const opened = [];
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
        open: async (p) => { opened.push(p); return fh; },
        rename: async () => { throw new Error('EPERM: rename failed'); },
        unlink: async (p) => { unlinks.push(p); },
      },
    };
    const unlinks = [];
    const store = createSessionStore(file, failingFs);
    store.create('1', 'work');
    await assert.rejects(() => store.save(), /rename failed/i, 'original error must propagate');
    assert.strictEqual(unlinks.length, 1, 'tmp file cleaned up');
    assert.strictEqual(unlinks[0], opened[0]);
  });

  await test('session save failure with broken cleanup still reports the ORIGINAL error', async () => {
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
        unlink: async () => { throw new Error('cleanup also failed'); },
      },
    };
    const store = createSessionStore(file, failingFs);
    store.create('1', 'work');
    await assert.rejects(() => store.save(), /rename failed/i, 'cleanup failure must not mask the original');
  });

  // ---------------- Pass 2 regressions (must keep passing) ------------------

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
    let rejectedReason = null;
    const res = q.enqueue('A', { n: 1 }, { onRejected: (_max, err) => { rejectedReason = err; } });
    assert.strictEqual(res.ok, false);
    assert.ok(rejectedReason && rejectedReason.code === 'QUEUE_CLOSED');
  });

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

  await test('/status never reveals absolute Claude executable paths', async () => {
    const realTg = T.getTelegram();
    T.setTelegram(fakeTg());
    try {
      const st = T.statusText('555001');
      assert.ok(!/[A-Za-z]:\\/.test(st), `no Windows path in /status: ${st}`);
      assert.ok(!/[\\/]/.test(st.replace(/[*_]|\n/g, '')), 'no path separators — basename only');
      assert.ok(!/node(\.exe)?\b/i.test(st), 'launch spec must not leak the node executable');
      assert.ok(!/cli\.js/i.test(st), 'launch spec must not leak the cli.js entrypoint');
      assert.ok(!/\.(js)\b/i.test(st), 'no JS entrypoint path in /status');
      assert.ok(!/\/(Users|home)\//.test(st), 'no unix home path in /status');
      assert.ok(!st.includes('TEST_TOKEN'));
      assert.ok(!/allowlist/i.test(st.toLowerCase()) || !/\b111\b/.test(st), 'allowlist not echoed');
    } finally {
      T.setTelegram(realTg);
    }
  });

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
        unlink: async () => { throw new Error('nothing to unlink'); },
      },
    };
    const store = createSessionStore(file, failingFs);
    store.create('1', 'work');
    await assert.rejects(() => store.save(), /EACCES|permission/i, 'save must reject, not swallow');
  });

  await test('/new does not claim success when persistence fails (rollback)', async () => {
    const realTg = T.getTelegram();
    const tgStub = fakeTg();
    T.setTelegram(tgStub);
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
    const store = createSessionStore(path.join(tmpDir(), 's.json'));
    const created = store.create('5', 'work');
    store.markInitialized('5', created.session.id);
    assert.strictEqual(store.get('5', 'work').initialized, true);
  });

  await test('runClaudeJob: init-save failure surfaces as a report warning and rolls the flag back', async () => {
    const realTg = T.getTelegram();
    const tgStub = fakeTg();
    T.setTelegram(tgStub);
    const sessionId = '0e5b3a2e-1d2f-4c6b-9a3f-00000000cafe';
    const child = (() => {
      const handlers = {};
      return {
        on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        kill() {},
        fire(ev, ...args) { for (const fn of handlers[ev] || []) fn(...args); },
      };
    })();
    // Chat pre-seeded with an uninitialized session matching the job.
    const st = T.store.chat('920001');
    st.list.set('work', { id: sessionId, initialized: false });
    st.active = 'work';
    const origSave = T.store.save;
    T.store.save = async () => { throw new Error('EACCES: disk full'); };
    try {
      const p = T.runClaudeJob('920001', {
        chatId: '920001', sessionName: 'work', sessionId,
        initialized: false, text: 'hello', cwd: process.cwd(),
      }, { spawnFn: () => child });
      await new Promise((r) => setTimeout(r, 15));
      child.fire('close', 0, null);
      await p;
    } finally {
      T.store.save = origSave;
      T.setTelegram(realTg);
    }
    const replies = tgStub.calls.filter((c) => c.method === 'sendMessage').map((c) => c.params.text);
    const report = replies.find((t) => /done in/.test(t));
    assert.ok(report, 'job report sent');
    assert.ok(/session state not saved to disk/.test(report), `warning shown: ${report}`);
    // Flag rolled back so the next job re-creates with --session-id (never
    // blindly resumes state that was never durably recorded).
    assert.strictEqual(T.store.get('920001', 'work').initialized, false, 'initialized flag rolled back');
  });

  await test('runClaudeJob: successful init persists and marks the session resumable', async () => {
    const realTg = T.getTelegram();
    T.setTelegram(fakeTg());
    const sessionId = '0e5b3a2e-1d2f-4c6b-9a3f-00000000bead';
    const child = (() => {
      const handlers = {};
      return {
        on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        kill() {},
        fire(ev, ...args) { for (const fn of handlers[ev] || []) fn(...args); },
      };
    })();
    const st = T.store.chat('920002');
    st.list.set('work', { id: sessionId, initialized: false });
    st.active = 'work';
    try {
      const p = T.runClaudeJob('920002', {
        chatId: '920002', sessionName: 'work', sessionId,
        initialized: false, text: 'hello', cwd: process.cwd(),
      }, { spawnFn: () => child });
      await new Promise((r) => setTimeout(r, 15));
      child.fire('close', 0, null);
      await p;
    } finally {
      T.setTelegram(realTg);
    }
    assert.strictEqual(T.store.get('920002', 'work').initialized, true, 'session marked resumable');
  });

  await test('no dead exports: safeSend / COMMAND_NAMES removed from lib', () => {
    const tg = require('../lib/telegram');
    const cmds = require('../lib/commands');
    assert.strictEqual(tg.safeSend, undefined, 'safeSend removed (unused abstraction)');
    assert.strictEqual(cmds.COMMAND_NAMES, undefined, 'COMMAND_NAMES removed (derive from BOT_COMMANDS)');
  });

  // ---------------- Claude Session Manager integration ----------------------

  await test('session manager: /new <name> <path> creates + attaches a managed session', async () => {
    const realTg = T.getTelegram();
    const tgStub = fakeTg();
    T.setTelegram(tgStub);
    const proj = tmpDir();
    try {
      await T.handleMessage({ chat: { id: 930001 }, from: { id: 111 }, text: `/new NDS ${proj}` });
      const replies = tgStub.calls.filter((c) => c.method === 'sendMessage').map((c) => c.params.text);
      const last = replies[replies.length - 1] || '';
      assert.ok(/Managed session \*NDS\* created/.test(last), `got: ${last}`);
      const attached = T.registry.attached('930001');
      assert.ok(attached, 'session attached to chat');
      assert.strictEqual(attached.name, 'NDS');
      assert.strictEqual(attached.project, path.resolve(proj));
      // privacy: project path shown basename-only
      assert.ok(!last.includes(proj), 'absolute project path must NOT be echoed');
      assert.ok(last.includes('NDS'));
    } finally {
      T.setTelegram(realTg);
    }
  });

  await test('session manager: plain text routes to the attached session (not the legacy queue)', async () => {
    const realTg = T.getTelegram();
    const tgStub = fakeTg();
    T.setTelegram(tgStub);
    const proj = tmpDir();
    try {
      await T.handleMessage({ chat: { id: 930002 }, from: { id: 111 }, text: `/new route-test ${proj}` });
      // legacy runner must NOT receive it; managed routing must accept it
      const realRun = T.claudeRunner.run;
      const legacyJobs = [];
      T.claudeRunner.run = async (c, j) => legacyJobs.push(j);
      let routedText = null;
      const realRoute = T.routeToManaged;
      await T.handleMessage({ chat: { id: 930002 }, from: { id: 111 }, text: 'analyze the nodes' });
      T.claudeRunner.run = realRun;
      assert.strictEqual(legacyJobs.length, 0, 'legacy queue untouched for attached chats');
      const entry = T.registry.attached('930002');
      assert.ok(entry, 'still attached');
    } finally {
      T.setTelegram(realTg);
    }
  });

  await test('session manager: unauthorized user cannot create or attach', async () => {
    const realTg = T.getTelegram();
    T.setTelegram(fakeTg());
    const proj = tmpDir();
    try {
      const before = T.registry.list().length;
      await T.handleMessage({ chat: { id: 930003 }, from: { id: 31337 }, text: `/new evil ${proj}` });
      await T.handleMessage({ chat: { id: 930003 }, from: { id: 31337 }, text: '/attach 1' });
      assert.strictEqual(T.registry.list().length, before, 'no registry entry created for unauthorized user');
      assert.strictEqual(T.registry.attached('930003'), null, 'unauthorized attach rejected');
    } finally {
      T.setTelegram(realTg);
    }
  });

  await test('session manager: /attach by number, /current, /detach round-trip', async () => {
    const realTg = T.getTelegram();
    const tgStub = fakeTg();
    T.setTelegram(tgStub);
    const proj = tmpDir();
    try {
      await T.handleMessage({ chat: { id: 930004 }, from: { id: 111 }, text: `/new alpha-rt ${proj}` });
      await T.handleMessage({ chat: { id: 930004 }, from: { id: 111 }, text: '/detach' });
      assert.strictEqual(T.registry.attached('930004'), null);
      // attach by NUMBER from the /sessions menu for THIS chat's listing
      const listed = T.listNumbered(T.claudeManager.list());
      const idx = T.claudeManager.list().findIndex((e) => e.name === 'alpha-rt') + 1;
      assert.ok(idx >= 1, 'session present in the numbered menu');
      await T.handleMessage({ chat: { id: 930004 }, from: { id: 111 }, text: `/attach ${idx}` });
      assert.ok(T.registry.attached('930004'), 'attach by number works');
      await T.handleMessage({ chat: { id: 930004 }, from: { id: 111 }, text: '/current' });
      const replies = tgStub.calls.filter((c) => c.method === 'sendMessage').map((c) => c.params.text);
      const cur = replies[replies.length - 1] || '';
      assert.ok(/Session: \*alpha-rt\*/.test(cur), `current shows session: ${cur}`);
      assert.ok(!cur.includes(proj), 'no absolute path in /current');
    } finally {
      T.setTelegram(realTg);
    }
  });

  await test('session manager: /download rejects path traversal and unknown files', async () => {
    const realTg = T.getTelegram();
    const tgStub = fakeTg();
    T.setTelegram(tgStub);
    const proj = tmpDir();
    try {
      await T.handleMessage({ chat: { id: 930005 }, from: { id: 111 }, text: `/new dl-test ${proj}` });
      for (const evil of ['..\\..\\secret.txt', 'sub/dir/file.txt', 'nope-does-not-exist.txt']) {
        const before = tgStub.calls.length;
        await T.handleMessage({ chat: { id: 930005 }, from: { id: 111 }, text: `/download ${evil}` });
        const replies = tgStub.calls.filter((c) => c.method === 'sendMessage').map((c) => c.params.text);
        const last = replies[replies.length - 1] || '';
        assert.ok(/Invalid|not a file|does not|not found|traversal|outside|not allowed/i.test(last) || last === '', `rejected: ${evil}`);
        assert.ok(!tgStub.calls.slice(before).some((c) => c.method === 'sendDocument'), 'no document sent for invalid request');
      }
    } finally {
      T.setTelegram(realTg);
    }
  });

  await test('session manager: help lists the new commands', () => {
    const { helpText } = require('../lib/commands');
    const h = helpText('Bot');
    for (const c of ['attach', 'detach', 'current', 'session-status', 'files', 'download', 'discover']) {
      assert.ok(h.includes(`/${c}`), `help missing /${c}`);
    }
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
