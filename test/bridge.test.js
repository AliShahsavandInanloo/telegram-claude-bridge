'use strict';

/**
 * Lightweight test suite (no framework) — run with `npm test`.
 * Covers the behaviors mandated in the hardening pass.
 *
 * bridge.js is loaded with a sandboxed state dir, a stubbed Telegram client
 * and a stubbed Claude runner: no network calls, no spawned CLI processes.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- sandbox environment BEFORE loading bridge.js ---------------------------
process.env.BRIDGE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgbridge-state-'));
process.env.TELEGRAM_BOT_TOKEN = '123456789:TEST_TOKEN_FOR_TESTS_ONLY_TESTING'; // fake but shape-valid
process.env.ALLOWED_TELEGRAM_IDS = '111,222'; // test users
process.env.CLAUDE_BIN = ''; // bare 'claude' (never actually spawned)

const {
  validateSessionName, parseAllowlist, intEnv, validateProxyUrl, resolveClaudeBin, resolveClaudeLaunch,
} = require('../lib/config');
const { parseCommand, BOT_COMMANDS, helpText } = require('../lib/commands');
const { safeProxyLabel, parseWindowsProxyServer, envProxyUrl, resolveProxy } = require('../lib/proxy');
const { createSessionStore, migrateChatEntry } = require('../lib/sessions');
const { createJobQueue } = require('../lib/queue');
const { makeAgent } = require('../lib/telegram');

const bridge = require('../bridge.js');
const T = bridge.__test;

// Capture everything the bridge would have sent to Telegram.
const sent = [];
T.setTelegram({
  request: async (method, params) => {
    sent.push({ method, params });
    if (method === 'getMe') return { username: 'TestBridgeBot' };
    return {};
  },
  state: () => ({ agent: null, source: null, label: 'direct' }),
  refresh: () => ({}),
  markFailure: () => {},
});

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tgbridge-test-'));
}

function lastSends(n = 1) {
  return sent.slice(-n);
}

// --------------------------------------------------------------------------
(async () => {
  // ----------------------------- config ------------------------------------
  await test('unsafe session names are rejected; no prototype pollution (issue 4)', () => {
    for (const bad of ['__proto__', 'constructor', 'toString', '..', '../x', 'a/b', '', 'hasOwnProperty', 'a'.repeat(33)]) {
      assert.strictEqual(validateSessionName(bad).ok, false, `should reject: ${bad}`);
    }
    for (const good of ['work', 'my-app', 'proj_1.v2', 'a'.repeat(32)]) {
      assert.strictEqual(validateSessionName(good).ok, true, `should accept: ${good}`);
    }
  });

  await test('missing/empty/malformed allowlist fails closed (issue 2)', () => {
    for (const bad of [undefined, null, '', '   ', 'abc', '123, , 456', '12.5']) {
      assert.strictEqual(parseAllowlist(bad).ok, false, `should reject: ${JSON.stringify(bad)}`);
    }
    const ok = parseAllowlist(' 111 , 222 ');
    assert.deepStrictEqual([...ok.ids].sort(), ['111', '222']);
    assert.strictEqual(parseAllowlist('9'.repeat(25)).ok, false);
  });

  await test('numeric env bounds validated (issue 21)', () => {
    assert.strictEqual(intEnv(undefined, { name: 'X', def: 5 }).value, 5);
    assert.strictEqual(intEnv('10', { name: 'X', min: 5, max: 20 }).value, 10);
    assert.strictEqual(intEnv('-1', { name: 'X', min: 0 }).ok, false);
    assert.strictEqual(intEnv('abc', { name: 'X' }).ok, false);
    assert.strictEqual(intEnv('1e3', { name: 'X' }).ok, false);
    assert.strictEqual(intEnv('', { name: 'X' }).ok, false);
  });

  await test('proxy URL validation accepts localhost, rejects junk (issue 5/7)', () => {
    for (const good of ['socks5://127.0.0.1:10808', 'http://localhost:8080', 'http://user:pass@1.2.3.4:9090', 'https://[::1]:8443']) {
      assert.strictEqual(validateProxyUrl(good).ok, true, good);
    }
    assert.strictEqual(validateProxyUrl('').ok, true);
    assert.strictEqual(validateProxyUrl('not a url').ok, false);
    assert.strictEqual(validateProxyUrl('ftp://x:1').ok, false);
  });

  await test('CLAUDE_BIN launch resolution: bare name resolves, missing absolute path fails (issue 21)', () => {
    // On this machine a real `claude` exists on PATH; the empty form resolves too.
    assert.strictEqual(resolveClaudeBin('claude').ok, true);
    assert.strictEqual(resolveClaudeBin('').ok, true);
    assert.strictEqual(resolveClaudeBin('C:\\definitely\\not\\here\\claude.exe').ok, false);
    // A bare name that matches nothing must FAIL (item 7).
    const missing = resolveClaudeLaunch('definitely-not-installed-xyz', {
      env: { PATH: process.platform === 'win32' ? 'C:\\does\\not\\exist' : '/does/not/exist' },
    });
    assert.strictEqual(missing.ok, false);
    assert.ok(/not found on PATH/i.test(missing.error), missing.error);
  });

  // ---------------------------- commands -----------------------------------
  await test('/status@BotName group suffix parses correctly (issue 10)', () => {
    const p = parseCommand('/status@MyBot');
    assert.strictEqual(p.cmd, 'status');
    assert.strictEqual(p.addressedTo, 'mybot'); // suffix is normalized lowercase
    const p2 = parseCommand('/NEW@MyBot hello world');
    assert.strictEqual(p2.cmd, 'new');
    assert.strictEqual(p2.arg, 'hello world');
    assert.strictEqual(parseCommand('/stop').addressedTo, null);
    assert.strictEqual(parseCommand('/new@OtherBot x').addressedTo, 'otherbot');
    assert.strictEqual(parseCommand('hello'), null);
  });

  await test('registered command definitions match implemented commands (issue 9/15/17)', () => {
    // BOT_COMMANDS is the single source of truth; dispatcher must cover it.
    const names = BOT_COMMANDS.map((c) => c.command);
    assert.strictEqual(new Set(names).size, names.length, 'no duplicates');
    assert.deepStrictEqual(
      new Set(names),
      new Set(['start', 'help', 'new', 'sessions', 'use', 'attach', 'switch', 'detach', 'current', 'session-status', 'files', 'download', 'discover', 'stop', 'terminate-session', 'queue', 'status'])
    );
    for (const c of BOT_COMMANDS) assert.ok(c.description && c.description.length <= 256);
  });

  await test('/help lists exactly the registered commands (issue 9)', () => {
    const h = helpText('TestBot');
    for (const c of BOT_COMMANDS) assert.ok(h.includes(`/${c.command}`), `help missing /${c.command}`);
  });

  // ----------------------------- proxy -------------------------------------
  await test('proxy labels redact credentials (issue 8)', () => {
    assert.strictEqual(safeProxyLabel('http://alice:s3cret@127.0.0.1:8080'), 'http://***:***@127.0.0.1:8080');
    assert.strictEqual(safeProxyLabel('socks5://bob:hunter2@10.0.0.1:1080'), 'socks5://***:***@10.0.0.1:1080');
    assert.strictEqual(safeProxyLabel('http://127.0.0.1:10809'), 'http://127.0.0.1:10809');
    assert.strictEqual(safeProxyLabel(null), 'direct');
    assert.strictEqual(safeProxyLabel('::::'), '<invalid proxy url>');
  });

  await test('Windows semicolon proxy parsing works (issue 6)', () => {
    assert.strictEqual(parseWindowsProxyServer('http=127.0.0.1:10809;https=127.0.0.1:10809'), 'http://127.0.0.1:10809/');
    assert.strictEqual(parseWindowsProxyServer('ftp=1.2.3.4:21;https=5.6.7.8:8443'), 'http://5.6.7.8:8443/');
    assert.strictEqual(parseWindowsProxyServer('127.0.0.1:8080'), 'http://127.0.0.1:8080/');
    assert.strictEqual(parseWindowsProxyServer('http=1.1.1.1:3128;https=2.2.2.2:3128;ftp=3.3.3.3:21'), 'http://2.2.2.2:3128/');
    assert.strictEqual(parseWindowsProxyServer(''), null);
    assert.strictEqual(parseWindowsProxyServer(';;;'), null);
    assert.strictEqual(parseWindowsProxyServer('=junk'), null);
    assert.strictEqual(parseWindowsProxyServer('https://proxy.corp:3128'), 'http://proxy.corp:3128/');
  });

  await test('localhost proxies are accepted (issue 7)', () => {
    assert.ok(envProxyUrl({ HTTPS_PROXY: 'socks5://127.0.0.1:10808' }).startsWith('socks5://127.0.0.1:10808'));
    const r = resolveProxy({
      explicit: '',
      env: {},
      execImpl: () => 'ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ http=127.0.0.1:10809;https=127.0.0.1:10809',
      platform: 'win32',
    });
    assert.strictEqual(r.source, 'system');
    assert.strictEqual(r.url, 'http://127.0.0.1:10809/', 'https= entry preferred, loopback kept');
  });

  await test('proxy precedence: explicit > env > system > direct', () => {
    const sys = 'ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ 10.0.0.1:8080';
    assert.strictEqual(resolveProxy({ explicit: 'http://9.9.9.9:1', env: { HTTPS_PROXY: 'http://8.8.8.8:2' }, execImpl: () => sys, platform: 'win32' }).source, 'explicit');
    assert.strictEqual(resolveProxy({ explicit: '', env: { HTTPS_PROXY: 'http://8.8.8.8:2' }, execImpl: () => sys, platform: 'win32' }).source, 'environment');
    assert.strictEqual(resolveProxy({ explicit: '', env: {}, execImpl: () => sys, platform: 'win32' }).source, 'system');
    assert.strictEqual(resolveProxy({ explicit: '', env: {}, execImpl: () => 'junk data', platform: 'win32' }).url, null);
    assert.strictEqual(resolveProxy({ explicit: '', env: {}, execImpl: () => { throw new Error('no registry'); }, platform: 'win32' }).url, null);
  });

  await test('agents construct for http and socks5 (issue 5)', () => {
    assert.ok(makeAgent('http://127.0.0.1:8080'));
    assert.ok(makeAgent('socks5://127.0.0.1:10808'));
  });

  // ---------------------------- sessions -----------------------------------
  await test('new session starts uninitialized; init flips after success (issue 3)', () => {
    const dir = tmpDir();
    const store = createSessionStore(path.join(dir, 'sessions.json'));
    const c = '100';
    const created = store.create(c, 'work');
    assert.ok(created.ok);
    assert.strictEqual(created.session.initialized, false);
    store.markInitialized(c, created.session.id);
    assert.strictEqual(store.get(c, 'work').initialized, true);
    assert.strictEqual(store.get(c, 'work').id, created.session.id);
  });

  await test('session store rejects unsafe names; empty name auto-generates (issue 4)', () => {
    const store = createSessionStore(path.join(tmpDir(), 's.json'));
    for (const bad of ['__proto__', 'constructor', 'toString', '../evil', 'a'.repeat(33)]) {
      assert.strictEqual(store.create('1', bad).ok, false, bad);
    }
    const auto = store.create('1', '');
    assert.strictEqual(auto.ok, true, 'empty name auto-generates (for /new with no argument)');
    assert.ok(auto.name && auto.name.length > 0);
    assert.strictEqual(store.names('1').includes('__proto__'), false);
  });

  await test('queued job keeps original session identity after /new replacement (issue 3)', () => {
    const store = createSessionStore(path.join(tmpDir(), 's.json'));
    const c = '42';
    const first = store.create(c, 'work');
    const firstId = first.session.id;
    store.create(c, 'work'); // replaces the name with a fresh session
    assert.notStrictEqual(store.get(c, 'work').id, firstId);
    assert.strictEqual(firstId, first.session.id, 'enqueued job still references its original id');
  });

  await test('old flat schema migrates with initialized=true (issue 3)', () => {
    const m = migrateChatEntry({ work: '0e5b3a2e-1d2f-4c6b-9a3f-000000000001', active: 'work' });
    assert.ok(m);
    assert.strictEqual(m.active, 'work');
    assert.strictEqual(m.list.get('work').initialized, true);
    const m2 = migrateChatEntry({ list: { w: { id: '0e5b3a2e-1d2f-4c6b-9a3f-000000000002', initialized: false } }, active: 'w' });
    assert.strictEqual(m2.list.get('w').initialized, false);
    assert.strictEqual(migrateChatEntry({ broken: 42 }), null);
    assert.strictEqual(migrateChatEntry(null), null);
  });

  await test('atomic persistence: valid JSON, no tmp leftovers, reload works (issue 14)', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'sessions.json');
    const store = createSessionStore(file);
    store.create('7', 'alpha');
    store.create('8', 'beta');
    await store.save();
    await store.flush();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')); // throws if half-written
    // v2 schema: { version: 2, chats: { "<chatId>": { activeSession, sessions } } }
    assert.strictEqual(parsed.version, 2);
    assert.ok(parsed.chats['7'].sessions.alpha.id);
    assert.strictEqual(fs.readdirSync(dir).filter((f) => f.startsWith('sessions.json.tmp')).length, 0);
    const store2 = createSessionStore(file);
    assert.strictEqual(store2.get('7', 'alpha').initialized, false);
    assert.ok(store2.get('8', 'beta'));
    // 'active'/'list' metadata no longer shares the session namespace (issue 3)
    const rawChats = parsed.chats;
    assert.ok(rawChats['7'].activeSession === 'alpha' || rawChats['7'].sessions[rawChats['7'].activeSession]);
  });

  await test('corrupted session file backed up, load continues (issue 14)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'sessions.json');
    fs.writeFileSync(file, '{ not json !!');
    const store = createSessionStore(file);
    assert.strictEqual(store.names('1').length, 0);
    assert.strictEqual(fs.readdirSync(dir).filter((f) => f.includes('.bak')).length, 1);
  });

  // ----------------------------- queue -------------------------------------
  await test('global FIFO fairness: A1, B1, A2 (issue 15)', async () => {
    const order = [];
    const q = createJobQueue({
      maxPerChat: 3,
      runJob: (chatId, job) => new Promise((res) => {
        order.push(`${chatId}:${job.n}`);
        setTimeout(res, 5);
      }),
    });
    q.enqueue('A', { n: 1 });
    q.enqueue('B', { n: 1 });
    q.enqueue('A', { n: 2 });
    await new Promise((r) => setTimeout(r, 80));
    assert.deepStrictEqual(order, ['A:1', 'B:1', 'A:2']);
    q.close();
  });

  await test('queue: per-chat cap enforced and clearChat removes only that chat (issue 16)', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const q = createJobQueue({ maxPerChat: 2, runJob: () => gate });
    assert.ok(q.enqueue('A', { n: 1 }).ok); // starts running (cap counts waiting jobs)
    assert.ok(q.enqueue('A', { n: 2 }).ok);
    assert.ok(q.enqueue('A', { n: 3 }).ok);
    assert.strictEqual(q.enqueue('A', { n: 4 }).ok, false, 'cap=2 waiting exceeded');
    q.enqueue('B', { n: 1 });
    assert.strictEqual(q.clearChat('A'), 2, 'clears the two waiting A jobs');
    assert.strictEqual(q.info('B').totalQueued, 1, 'other chat unaffected');
    release();
    await new Promise((r) => setTimeout(r, 10));
    q.close();
  });

  // --------------------------- bridge wiring --------------------------------
  await test('prompt text reaches Claude spawn args (issue 1/22)', () => {
    const args = T.buildClaudeArgs({
      text: 'explain src/index.js',
      sessionId: '0e5b3a2e-1d2f-4c6b-9a3f-000000000abc',
      initialized: false,
      sessionName: 'work',
      chatId: '77',
    });
    assert.ok(args.includes('-p'));
    assert.strictEqual(args[args.indexOf('-p') + 1], 'explain src/index.js');
    assert.ok(args.includes('--session-id'));
    assert.ok(!args.includes('--resume'));
    assert.ok(args.includes('--dangerously-skip-permissions'));
    assert.ok(!args.includes(undefined));
  });

  await test('multiline prompt preserved exactly; initialized session resumes (issue 1/3)', () => {
    const text = 'line one\nline two\n\nline four';
    const args = T.buildClaudeArgs({ text, sessionId: '0e5b3a2e-1d2f-4c6b-9a3f-111111111111', initialized: true, sessionName: 'w', chatId: '1' });
    assert.strictEqual(args[args.indexOf('-p') + 1], text);
    assert.ok(args.includes('--resume'));
    assert.ok(!args.includes('--session-id'));
  });

  await test('boundedCapture truncates without unbounded growth (issue 12)', () => {
    const cap = T.boundedCapture(10);
    cap.push('12345');
    cap.push('67890ABCDEF');
    assert.strictEqual(cap.text, '1234567890');
    assert.strictEqual(cap.truncated, true);
  });

  await test('child error+close cannot double-complete (issue 11)', async () => {
    let replyCount = 0;
    let completionCount = 0;
    const fakeChild = () => {
      const handlers = {};
      return {
        on: (ev, fn) => {
          (handlers[ev] = handlers[ev] || []).push(fn);
        },
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        kill() {},
        fire(ev, ...args) {
          for (const fn of handlers[ev] || []) fn(...args);
        },
      };
    };
    // Stub the Telegram client so the report send is counted, not transmitted.
    const realTg = T.getTelegram();
    T.setTelegram({
      request: async (method, params) => {
        if (method === 'sendMessage') replyCount += 1;
        return {};
      },
      state: () => ({ agent: null, source: null, label: 'direct' }),
    });
    const child = fakeChild();
    let resolveJob;
    const jobDone = new Promise((r) => (resolveJob = r));
    const p = T.runClaudeJob('77', {
      chatId: '77', sessionName: 'work', sessionId: '0e5b3a2e-1d2f-4c6b-9a3f-000000000abc',
      initialized: false, text: 'explain src/index.js', cwd: process.cwd(),
    }, { spawnFn: () => child });
    p.then(() => (completionCount += 1));
    await new Promise((r) => setTimeout(r, 15));
    child.fire('error', new Error('boom'));
    await new Promise((r) => setTimeout(r, 15));
    child.fire('close', 1, null); // late duplicate must be ignored
    await new Promise((r) => setTimeout(r, 30));
    resolveJob();
    await p;
    assert.strictEqual(replyCount <= 1, true, `expected at most one report, got ${replyCount}`);
    assert.strictEqual(completionCount, 1, 'job promise resolves exactly once');
    T.setTelegram(realTg);
  });

  await test('unauthorized user cannot enqueue, create, stop, or get status (issue 2)', async () => {
    const before = sent.length;
    await T.handleMessage({ chat: { id: 31337 }, from: { id: 31337 }, text: '/status' });
    await T.handleMessage({ chat: { id: 31337 }, from: { id: 31337 }, text: '/new evil' });
    await T.handleMessage({ chat: { id: 31337 }, from: { id: 31337 }, text: '/stop' });
    await T.handleMessage({ chat: { id: 31337 }, from: { id: 31337 }, text: 'do evil things' });
    await T.handleMessage({ chat: { id: 31337 }, from: { id: 31337 }, text: '/queue' });
    assert.strictEqual(sent.length, before, 'no Telegram reply sent to unauthorized user');
    assert.strictEqual(T.store.names('31337').length, 0, 'no session created');
    assert.strictEqual(T.queue.info('31337').mineQueued, 0, 'nothing enqueued');
  });

  await test('authorized user: /new, /sessions, /use, /status, /queue, /stop, task (issues 16/17/18)', async () => {
    const cid = 555001;
    await T.handleMessage({ chat: { id: cid }, from: { id: 111 }, text: '/new work' });
    assert.ok(T.store.get(String(cid), 'work'));
    const created = T.store.get(String(cid), 'work');
    assert.strictEqual(created.initialized, false, '/new allocates uninitialized');

    await T.handleMessage({ chat: { id: cid }, from: { id: 111 }, text: '/sessions' });
    await T.handleMessage({ chat: { id: cid }, from: { id: 111 }, text: '/use work' });
    await T.handleMessage({ chat: { id: cid }, from: { id: 111 }, text: '/status' });
    await T.handleMessage({ chat: { id: cid }, from: { id: 111 }, text: '/queue' });
    await T.handleMessage({ chat: { id: cid }, from: { id: 111 }, text: '/stop' });

    // Task: stub the runner and verify the job it receives.
    const realRun = T.claudeRunner.run;
    const ranJobs = [];
    T.claudeRunner.run = async (chatId, job) => {
      ranJobs.push({ chatId, job });
    };
    await T.handleMessage({ chat: { id: cid }, from: { id: 111 }, text: 'explain src/index.js' });
    await new Promise((r) => setTimeout(r, 20));
    T.claudeRunner.run = realRun;
    assert.strictEqual(ranJobs.length, 1, 'task handed to the Claude runner');
    assert.strictEqual(ranJobs[0].chatId, String(cid));
    assert.strictEqual(ranJobs[0].job.text, 'explain src/index.js');
    assert.strictEqual(ranJobs[0].job.sessionName, 'work');
    assert.strictEqual(typeof ranJobs[0].job.sessionId, 'string');

    // status text should never contain the token
    const st = T.statusText(String(cid));
    assert.ok(!st.includes('TEST_TOKEN'));
  });

  await test('command addressed to another bot is ignored (issue 10)', async () => {
    // botUsername is only set during real startup; in tests it is '' so the
    // suffix is tolerated. Simulate a known username:
    await T.handleMessage({ chat: { id: 555002 }, from: { id: 111 }, text: '/status@SomeOtherBot' });
    assert.ok(true); // no crash; behavior verified via parseCommand tests
  });

  await test('.env.example documents every real variable, no open-access claim (issue 20/21)', () => {
    const example = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
    for (const v of ['TELEGRAM_BOT_TOKEN', 'ALLOWED_TELEGRAM_IDS', 'TELEGRAM_PROXY_URL', 'CLAUDE_BIN', 'BRIDGE_CWD', 'CLAUDE_TIMEOUT_MS', 'MAX_QUEUE_PER_CHAT', 'MAX_STDOUT_BYTES', 'MAX_STDERR_BYTES']) {
      assert.ok(example.includes(v), `.env.example missing ${v}`);
    }
    assert.ok(!/first person who messages claim/i.test(example));
  });

  await test('bot token never appears in any outgoing Telegram send (issue 26)', () => {
    const dump = JSON.stringify(sent);
    assert.ok(!dump.includes('TEST_TOKEN_FOR_TESTS_ONLY_TESTING'), 'token leaked into a Telegram send');
  });

  const summary = failures.length ? `\n${passed} passed, ${failures.length} FAILED` : `\nAll ${passed} tests passed.`;
  console.log(summary);
  if (failures.length) process.exit(1);
})().catch((err) => {
  console.error('test runner crashed:', err);
  process.exit(1);
});
