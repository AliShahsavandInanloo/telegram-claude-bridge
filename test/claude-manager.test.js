'use strict';

/**
 * Tests for the Claude Session Manager subsystem (registry, launcher adapter,
 * managed session, manager routing, output streaming, discovery).
 * Run with `node test/claude-manager.test.js` (wired into `npm test`).
 * No real Claude process and no network access is used.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRegistry, validateProjectPath, SCHEMA_VERSION } = require('../lib/claude/registry');
const { createManagedSession } = require('../lib/claude/session');
const { createClaudeManager } = require('../lib/claude/manager');
const { createProgressReporter, CHUNK_LIMIT } = require('../lib/claude/output');
const { discoverClaudeProcesses } = require('../lib/claude/discover');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tgbridge-mgr-'));
}

function fakeChild() {
  const handlers = {};
  return {
    pid: 4242 + Math.floor(Math.random() * 1000),
    exitCode: null,
    signalCode: null,
    stdin: { write: (d) => handlers.stdin && handlers.stdin(d), on: () => {} },
    stdout: { on: (ev, fn) => { (handlers['out:' + ev] = handlers['out:' + ev] || []).push(fn); } },
    stderr: { on: () => {} },
    on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
    kill() { handlers.close && handlers.close.forEach((f) => f(0, null)); },
    fire(ev, ...a) { (handlers[ev] || []).forEach((f) => f(...a)); },
    fireOut(data) { (handlers['out:data'] || []).forEach((f) => f(Buffer.from(data))); },
    handlers,
  };
}

const LAUNCH = { command: 'claude.exe', prefixArgs: [] };

// ---------------------------------------------------------------------------

(async () => {
  // ---------------- registry: create / list / remove / persist --------------

  await test('registry: create validates name and project path', () => {
    const dir = tmpDir();
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(proj);
    const reg = createRegistry(path.join(dir, 'r.json'));
    assert.strictEqual(reg.create({ name: '../evil', project: proj }).ok, false);
    assert.strictEqual(reg.create({ name: '__proto__', project: proj }).ok, false);
    assert.strictEqual(reg.create({ name: 'ok', project: path.join(dir, 'missing') }).ok, false);
    assert.ok(reg.create({ name: 'ok', project: proj }).ok);
    assert.strictEqual(reg.create({ name: 'OK', project: proj }).ok, false, 'duplicate names rejected (case-insensitive)');
  });

  await test('registry: list, attach, detach, remove; attachments cleaned on remove', () => {
    const dir = tmpDir();
    const reg = createRegistry(path.join(dir, 'r.json'));
    const a = reg.create({ name: 'alpha', project: dir }).entry;
    const b = reg.create({ name: 'beta', project: dir }).entry;
    assert.deepStrictEqual(reg.list().map((e) => e.name), ['alpha', 'beta']);
    assert.ok(reg.attach('111', a.id).ok);
    assert.strictEqual(reg.attached('111').id, a.id);
    assert.ok(reg.remove(b.id).ok);
    assert.strictEqual(reg.get(b.id), null);
    assert.strictEqual(reg.attached('111').id, a.id, 'unrelated attachment kept');
    reg.detach('111');
    assert.strictEqual(reg.attached('111'), null);
  });

  await test('registry: persistence round-trip + schema version', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'r.json');
    const reg = createRegistry(file);
    const e = reg.create({ name: 'work', project: dir, owner: { userId: '42' } }).entry;
    reg.attach('555', e.id);
    reg.setClaudeSessionId(e.id, '0e5b3a2e-1d2f-4c6b-9a3f-0000000000aa');
    await reg.save();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(raw.version, SCHEMA_VERSION);
    const reg2 = createRegistry(file);
    const e2 = reg2.getByName('work');
    assert.ok(e2);
    assert.strictEqual(e2.project, path.resolve(dir));
    assert.strictEqual(e2.claudeSessionId, '0e5b3a2e-1d2f-4c6b-9a3f-0000000000aa');
    assert.strictEqual(e2.initialized, true);
    assert.strictEqual(e2.owner.userId, '42');
    assert.strictEqual(reg2.attached('555').id, e2.id, 'attachment survives restart');
  });

  await test('registry: corrupt file backed up and start-fresh', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'r.json');
    fs.writeFileSync(file, '{ not json !!');
    const reg = createRegistry(file);
    assert.strictEqual(reg.list().length, 0);
    assert.ok(fs.readdirSync(dir).some((f) => f.includes('.corrupt-') && f.endsWith('.bak')));
  });

  await test('registry: save failure rolls back via snapshot/restore', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'r.json');
    const failingFs = {
      existsSync: () => false,
      readFileSync: fs.readFileSync,
      copyFileSync: fs.copyFileSync,
      statSync: fs.statSync,
      promises: {
        mkdir: async () => {},
        open: async () => { throw new Error('EACCES'); },
        unlink: async () => {},
      },
    };
    const reg = createRegistry(file, failingFs);
    const snap = reg.snapshot();
    const created = reg.create({ name: 'doomed', project: dir });
    assert.ok(created.ok);
    await assert.rejects(() => reg.save());
    reg.restore(snap);
    assert.strictEqual(reg.getByName('doomed'), null, 'in-memory state rolled back');
  });

  await test('validateProjectPath: file rejected, directory accepted', () => {
    const dir = tmpDir();
    const f = path.join(dir, 'file.txt');
    fs.writeFileSync(f, 'x');
    assert.ok(validateProjectPath(dir).ok);
    assert.strictEqual(validateProjectPath(f).ok, false);
  });

  // ---------------- managed session: protocol + lifecycle -------------------

  await test('managed session: stream-json line parsing routes progress and result', async () => {
    const dir = tmpDir();
    const child = fakeChild();
    const entry = {
      id: 'x', name: 'n', project: dir, claudeSessionId: null,
      initialized: false, status: 'idle', pid: null,
    };
    const ms = createManagedSession(entry, LAUNCH, { spawnFn: () => child });
    ms.start();
    const progress = [];
    const resultP = ms.submitTask('do things', (p) => progress.push(p.text));
    // capture the stdin line that was written
    const stdinLine = child.handlers.stdin ? null : null;
    // Simulate Claude's stream-json output:
    child.fireOut(JSON.stringify({ type: 'system', subtype: 'init', session_id: '0e5b3a2e-1d2f-4c6b-9a3f-00000000beef' }) + '\n');
    child.fireOut(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Running tests.' }] } }) + '\n');
    child.fireOut(JSON.stringify({ type: 'result', subtype: 'success', result: '83 tests passed' }) + '\n');
    const r = await resultP;
    assert.ok(r.ok);
    assert.strictEqual(r.summary, '83 tests passed');
    assert.deepStrictEqual(progress, ['Running tests.']);
    assert.strictEqual(entry.claudeSessionId, '0e5b3a2e-1d2f-4c6b-9a3f-00000000beef');
    assert.strictEqual(entry.initialized, true);
  });

  await test('managed session: user task is written to stdin as a JSON line (never a shell string)', async () => {
    const dir = tmpDir();
    const written = [];
    const child = fakeChild();
    child.stdin.write = (d) => written.push(d);
    const entry = { id: 'x', name: 'n', project: dir, claudeSessionId: null, initialized: false, status: 'idle', pid: null };
    const ms = createManagedSession(entry, LAUNCH, { spawnFn: () => child });
    ms.start();
    const p = ms.submitTask('hello "world" $(rm -rf /)');
    child.fireOut(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }) + '\n');
    await p;
    assert.strictEqual(written.length, 1);
    const parsed = JSON.parse(written[0].trim());
    assert.strictEqual(parsed.type, 'user');
    assert.strictEqual(parsed.message.content[0].text, 'hello "world" $(rm -rf /)', 'exact text via JSON line — no shell interpolation possible');
    assert.ok(written[0].trim().endsWith('}'), 'single JSON line');
  });

  await test('managed session: exit with pending task resolves it as failed', async () => {
    const dir = tmpDir();
    const child = fakeChild();
    const entry = { id: 'x', name: 'n', project: dir, claudeSessionId: null, initialized: false, status: 'idle', pid: null };
    const ms = createManagedSession(entry, LAUNCH, { spawnFn: () => child });
    ms.start();
    const p = ms.submitTask('long task');
    child.fire('close', 1, null);
    const r = await p;
    assert.strictEqual(r.ok, false);
    assert.ok(/exited/.test(r.summary));
  });

  // ---------------- manager: routing / attach / restart ---------------------

  await test('manager: create, attach, route, and status wiring', async () => {
    const dir = tmpDir();
    const reg = createRegistry(path.join(dir, 'r.json'));
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(proj);
    const children = [];
    const mgr = createClaudeManager({
      reg,
      launch: LAUNCH,
      spawnFn: (cmd, args, opts) => {
        const c = fakeChild();
        c._spawnArgs = args;
        children.push(c);
        return c;
      },
      saveDelayMs: 5,
    });
    const created = await mgr.createSession({ name: 'work', project: proj, owner: { userId: '1' } });
    assert.ok(created.ok, created.error);
    const att = await mgr.attach('77', created.entry.id);
    assert.ok(att.ok);
    const routed = mgr.route('77', 'task one');
    assert.strictEqual(children.length, 1, 'process spawned lazily on route');
    const spawnedArgs = children[0]._spawnArgs;
    assert.ok(!spawnedArgs.includes('-p'), 'managed mode is interactive, not one-shot -p');
    assert.ok(spawnedArgs.includes('--dangerously-skip-permissions'));
    assert.ok(spawnedArgs.includes('--input-format'), 'managed mode uses the stream-json stdin protocol');
    // Simulate a completed turn:
    children[0].fireOut(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok!' }) + '\n');
    const r = await routed;
    assert.ok(r.ok && r.summary === 'ok!');
    const st = mgr.status(created.entry.id);
    assert.strictEqual(st.entry.name, 'work');
    assert.strictEqual(st.process.running, true);
    mgr.stopAll();
  });

  await test('manager: route without attachment reports no_session_attached', async () => {
    const dir = tmpDir();
    const reg = createRegistry(path.join(dir, 'r.json'));
    const mgr = createClaudeManager({ reg, launch: LAUNCH, spawnFn: () => fakeChild() });
    const r = await mgr.route('404', 'hello');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'no_session_attached');
  });

  await test('manager: registry save failure inside route does not corrupt state', async () => {
    const dir = tmpDir();
    const reg = createRegistry(path.join(dir, 'r.json'));
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(proj);
    const e = reg.create({ name: 'work', project: proj }).entry;
    reg.attach('9', e.id);
    let fail = true;
    const origSave = reg.save;
    reg.save = () => (fail ? Promise.reject(new Error('disk gone')) : origSave.call(reg));
    const mgr = createClaudeManager({
      reg,
      launch: LAUNCH,
      spawnFn: () => {
        const c = fakeChild();
        setTimeout(() => c.fireOut(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }) + '\n'), 5);
        return c;
      },
      saveDelayMs: 5,
    });
    const r = await mgr.route('9', 'task');
    assert.ok(r.ok);
    await new Promise((res) => setTimeout(res, 30));
    assert.ok(reg.getByName('work'), 'session survives failed registry save');
    fail = false;
    mgr.stopAll();
    reg.save = origSave;
  });

  // ---------------- streaming output: anti-spam ------------------------------

  await test('progress reporter: rate-limits progress, always sends final', async () => {
    const sent = [];
    const rep = createProgressReporter({
      send: async (t) => sent.push(t),
      minIntervalMs: 60,
      minChunkChars: 5,
    });
    rep.push('chunk one ');
    rep.push('chunk two');
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(sent.length, 0, 'too soon: nothing sent yet');
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(sent.length, 1, 'one grouped progress message');
    rep.push(' more output');
    await new Promise((r) => setTimeout(r, 30));
    rep.complete('FINAL');
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(sent.some((t) => t.includes('FINAL')), 'final result always delivered');
    assert.ok(sent.length <= 3, 'no spam');
  });

  await test('progress reporter: caps message size to Telegram-safe chunk', async () => {
    const sent = [];
    const rep = createProgressReporter({ send: async (t) => sent.push(t), minIntervalMs: 0, minChunkChars: 1 });
    rep.push('x'.repeat(CHUNK_LIMIT + 5000));
    rep.complete();
    await new Promise((r) => setTimeout(r, 20));
    for (const s of sent) assert.ok(s.length <= CHUNK_LIMIT, 'every message within Telegram-safe size');
  });

  // ---------------- discovery: read-only inventory ---------------------------

  await test('discovery: parses tasklist CSV and returns claude processes only', async () => {
    const csv = '"claude.exe","1234","Console","1","1,000 K"\r\n"notepad.exe","99","Console","1","100 K"\r\n"Claude Helper","55","Console","1","100 K"\r\n';
    const procs = await discoverClaudeProcesses({
      platform: 'win32',
      execImpl: async (file, args) => {
        assert.strictEqual(file, 'tasklist');
        assert.deepStrictEqual(args, ['/FO', 'CSV', '/NH']);
        return { stdout: csv };
      },
    });
    assert.deepStrictEqual(procs.map((p) => p.pid), [1234, 55], 'claude images only');
  });

  await test('discovery: helper failure degrades to empty list (never throws)', async () => {
    const procs = await discoverClaudeProcesses({
      platform: 'win32',
      execImpl: async () => { throw new Error('tasklist missing'); },
    });
    assert.deepStrictEqual(procs, []);
  });

  // ---------------------------------------------------------------------------

  const summary = failures.length
    ? `\n${passed} passed, ${failures.length} FAILED`
    : `\nAll ${passed} claude-manager tests passed.`;
  console.log(summary);
  if (failures.length) process.exit(1);
})().catch((err) => {
  console.error('claude-manager runner crashed:', err);
  process.exit(1);
});
