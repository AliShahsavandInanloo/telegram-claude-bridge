'use strict';

/**
 * Tests for the global (user-scope) installation layer:
 *
 *   - scripts/launch-channel.js  — secret/port resolution, refusal paths, and
 *     the guarantee that no diagnostic ever leaks the secret
 *   - scripts/global-install-lib.js — wrapper rendering, MCP argv construction,
 *     ownership checks
 *   - scripts/install-global.js  — reading user-scope MCP config, refusing to
 *     clobber a foreign registration, writing wrappers without overwriting
 *     unmanaged files
 *
 * Everything runs against temporary directories and INJECTED dependencies.
 * The real ~/.claude.json, the real PATH, and the real Claude CLI are never
 * touched, and no subprocess is spawned.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const launcher = require('../scripts/launch-channel');
const lib = require('../scripts/global-install-lib');
const installer = require('../scripts/install-global');

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

function tmpDir(tag = 'tgbridge-global-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

/** A throwaway "bridge root" with a .env and a channel-secret file. */
function fakeRoot({ port = '8766', secret = 'a'.repeat(64), writeSecret = true } = {}) {
  const root = tmpDir();
  if (port !== null) fs.writeFileSync(path.join(root, '.env'), `CLAUDE_CHANNEL_PORT=${port}\n`);
  if (writeSecret) {
    fs.mkdirSync(path.join(root, 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, 'state', 'channel-secret'), `${secret}\n`, 'utf8');
  }
  return root;
}

async function main() {
  console.log('global install: launcher — secret resolution');

  await test('resolveSecretPath defaults to <root>/state/channel-secret', () => {
    const root = path.join('C:', 'bridge');
    const p = launcher.resolveSecretPath({ root, env: {} });
    assert.strictEqual(p, path.join(root, 'state', 'channel-secret'));
  });

  await test('resolveSecretPath honours CLAUDE_CHANNEL_SECRET_FILE', () => {
    const p = launcher.resolveSecretPath({ root: 'C:\\bridge', env: { CLAUDE_CHANNEL_SECRET_FILE: 'D:\\secrets\\chan' } });
    assert.strictEqual(p, path.resolve('D:\\secrets\\chan'));
  });

  await test('resolveSecretPath ignores a blank CLAUDE_CHANNEL_SECRET_FILE', () => {
    const p = launcher.resolveSecretPath({ root: 'C:\\bridge', env: { CLAUDE_CHANNEL_SECRET_FILE: '   ' } });
    assert.strictEqual(p, path.join('C:\\bridge', 'state', 'channel-secret'));
  });

  await test('readSecretFile returns the trimmed secret', () => {
    const root = fakeRoot({ secret: 'z'.repeat(40) });
    const s = launcher.readSecretFile(path.join(root, 'state', 'channel-secret'));
    assert.strictEqual(s, 'z'.repeat(40));
  });

  await test('readSecretFile reports a missing file without leaking anything', () => {
    const missing = path.join(tmpDir(), 'nope');
    assert.throws(
      () => launcher.readSecretFile(missing),
      (err) => {
        assert.ok(err.message.includes(missing), 'error names the path');
        assert.ok(/state\/channel-secret|not readable/.test(err.message), 'error explains the fix');
        return true;
      },
    );
  });

  await test('readSecretFile rejects an empty file', () => {
    const root = tmpDir();
    const f = path.join(root, 'channel-secret');
    fs.writeFileSync(f, '   \n', 'utf8');
    assert.throws(() => launcher.readSecretFile(f), /is empty/);
  });

  await test('readSecretFile rejects a too-short secret', () => {
    const root = tmpDir();
    const f = path.join(root, 'channel-secret');
    fs.writeFileSync(f, 'short\n', 'utf8');
    assert.throws(() => launcher.readSecretFile(f), /too short/);
  });

  console.log('global install: launcher — port + secret precedence');

  await test('bootstrap reads the port from .env (not a hardcoded 8765)', () => {
    const root = fakeRoot({ port: '8766' });
    const cfg = launcher.bootstrap({ root, env: {}, fsImpl: fs });
    assert.strictEqual(cfg.port, 8766, 'port comes from .env');
    assert.strictEqual(cfg.secret, 'a'.repeat(64));
    assert.strictEqual(cfg.secretSource, path.join(root, 'state', 'channel-secret'));
  });

  await test('bootstrap defaults to port 8765 when .env has no port', () => {
    const root = fakeRoot({ port: null });
    const cfg = launcher.bootstrap({ root, env: {}, fsImpl: fs });
    assert.strictEqual(cfg.port, 8765);
  });

  await test('bootstrap lets the real environment win over .env', () => {
    const root = fakeRoot({ port: '8766' });
    const cfg = launcher.bootstrap({ root, env: { CLAUDE_CHANNEL_PORT: '9100' }, fsImpl: fs });
    assert.strictEqual(cfg.port, 9100);
  });

  await test('bootstrap rejects an out-of-range port', () => {
    const root = fakeRoot({ port: '80' });
    assert.throws(() => launcher.bootstrap({ root, env: {}, fsImpl: fs }), /bad channel port/);
  });

  await test('bootstrap prefers an inline CLAUDE_CHANNEL_SECRET and reports the source', () => {
    const root = fakeRoot({ writeSecret: false });
    const cfg = launcher.bootstrap({
      root,
      env: { CLAUDE_CHANNEL_SECRET: 'inline-secret-value-123456' },
      fsImpl: fs,
    });
    assert.strictEqual(cfg.secret, 'inline-secret-value-123456');
    assert.strictEqual(cfg.secretSource, 'environment (CLAUDE_CHANNEL_SECRET)');
  });

  await test('bootstrap reads the secret file when no inline secret is set', () => {
    const root = fakeRoot({ secret: 'b'.repeat(32) });
    const cfg = launcher.bootstrap({
      root,
      env: { CLAUDE_CHANNEL_SECRET_FILE: path.join(root, 'state', 'channel-secret') },
      fsImpl: fs,
    });
    assert.strictEqual(cfg.secret, 'b'.repeat(32));
  });

  await test('applyToEnv exports both variables as strings', () => {
    const env = {};
    launcher.applyToEnv({ port: 8766, secret: 'x'.repeat(20) }, env);
    assert.strictEqual(env.CLAUDE_CHANNEL_PORT, '8766');
    assert.strictEqual(env.CLAUDE_CHANNEL_SECRET, 'x'.repeat(20));
  });

  await test('describe() never includes the secret value', () => {
    const secret = 'super-secret-do-not-print-0001';
    const d = launcher.describe({ root: 'C:\\bridge', port: 8766, secret, secretSource: 'file' });
    const serialized = JSON.stringify(d);
    assert.ok(!serialized.includes(secret), 'secret must not appear in the summary');
    assert.strictEqual(d.secretLength, secret.length);
    assert.strictEqual(d.ok, true);
  });

  console.log('global install: wrapper + MCP argv generation');

  await test('wrapperContents stamps the ownership marker on both files', () => {
    const files = lib.wrapperContents({ root: 'C:\\bridge', claudeExe: 'C:\\bin\\claude.exe' });
    assert.ok(lib.isManaged(files[lib.CLAUDE_TELEGRAM_CMD]));
    assert.ok(lib.isManaged(files[lib.BRIDGE_CMD]));
  });

  await test('claude wrapper enables the channel but does NOT change directory', () => {
    const files = lib.wrapperContents({ root: 'C:\\bridge', claudeExe: 'claude' });
    const body = files[lib.CLAUDE_TELEGRAM_CMD];
    assert.ok(body.includes('--dangerously-load-development-channels server:telegram-bridge'), 'channel flag + server name');
    assert.ok(body.includes('%*'), 'forwards extra arguments');
    assert.ok(!/^cd \/d/m.test(body), 'must keep the caller\'s cwd (the project)');
  });

  await test('bridge wrapper starts the Bridge from the repo root', () => {
    const files = lib.wrapperContents({ root: 'C:\\bridge', claudeExe: 'claude' });
    const body = files[lib.BRIDGE_CMD];
    assert.ok(body.includes('cd /d "C:\\bridge"'), 'cd to the bridge root');
    assert.ok(body.includes('node bridge.js'), 'runs the production entrypoint');
  });

  await test('wrappers contain no secret-shaped content', () => {
    const secret = 'deadbeef'.repeat(8);
    const files = lib.wrapperContents({ root: `C:\\bridge`, claudeExe: 'claude' });
    for (const body of Object.values(files)) {
      assert.ok(!body.includes(secret));
      assert.ok(!/CLAUDE_CHANNEL_SECRET/.test(body), 'no secret env var in a wrapper');
    }
  });

  await test('buildMcpAddArgs registers at user scope with paths only', () => {
    const args = lib.buildMcpAddArgs({ launcherPath: 'C:\\bridge\\scripts\\launch-channel.js' });
    assert.deepStrictEqual(args, [
      'mcp', 'add', '-s', 'user', 'telegram-bridge', '--',
      'node', 'C:\\bridge\\scripts\\launch-channel.js',
    ]);
    assert.ok(!args.join(' ').includes('CLAUDE_CHANNEL_SECRET'), 'no secret on the command line');
  });

  await test('buildMcpRemoveArgs targets user scope only', () => {
    assert.deepStrictEqual(lib.buildMcpRemoveArgs(), ['mcp', 'remove', '-s', 'user', 'telegram-bridge']);
  });

  await test('isManaged is false for an arbitrary file', () => {
    assert.strictEqual(lib.isManaged('@echo off\r\nnode something.js\r\n'), false);
    assert.strictEqual(lib.isManaged(null), false);
  });

  await test('defaultBinDir honours BRIDGE_BIN_DIR', () => {
    const dir = lib.defaultBinDir({ env: { BRIDGE_BIN_DIR: 'D:\\tools\\bin' }, platform: 'win32', home: 'C:\\Users\\x' });
    assert.strictEqual(dir, path.resolve('D:\\tools\\bin'));
  });

  await test('defaultBinDir falls back to ~/.local/bin', () => {
    const dir = lib.defaultBinDir({ env: {}, platform: 'win32', home: 'C:\\Users\\x' });
    assert.strictEqual(dir, path.join('C:\\Users\\x', '.local', 'bin'));
  });

  console.log('global install: ownership + config reading');

  await test('isOwnRegistration accepts our node + launcher registration', () => {
    const launcherPath = path.join(libDirRoot(), 'scripts', 'launch-channel.js');
    const entry = { type: 'stdio', command: 'node', args: [launcherPath] };
    assert.strictEqual(lib.isOwnRegistration(entry, { launcherPath, fsImpl: fs }), true);
  });

  await test('isOwnRegistration rejects a different command', () => {
    const launcherPath = path.join(libDirRoot(), 'scripts', 'launch-channel.js');
    assert.strictEqual(
      lib.isOwnRegistration({ command: 'bun', args: [launcherPath] }, { launcherPath, fsImpl: fs }),
      false,
    );
  });

  await test('isOwnRegistration rejects a different launcher', () => {
    const launcherPath = path.join(libDirRoot(), 'scripts', 'launch-channel.js');
    assert.strictEqual(
      lib.isOwnRegistration({ command: 'node', args: ['C:\\other\\thing.js'] }, { launcherPath, fsImpl: fs }),
      false,
    );
  });

  await test('isOwnRegistration rejects a non-stdio transport', () => {
    const launcherPath = path.join(libDirRoot(), 'scripts', 'launch-channel.js');
    assert.strictEqual(
      lib.isOwnRegistration({ type: 'http', url: 'http://x', command: 'node', args: [launcherPath] }, { launcherPath, fsImpl: fs }),
      false,
    );
  });

  await test('readUserMcpEntry finds a user-scope server in an injected home', () => {
    const home = tmpDir();
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { 'telegram-bridge': { type: 'stdio', command: 'node', args: ['x.js'] } } }),
      'utf8',
    );
    const found = installer.readUserMcpEntry('telegram-bridge', home);
    assert.strictEqual(found.present, true);
    assert.strictEqual(found.entry.command, 'node');
  });

  await test('readUserMcpEntry reports absence instead of throwing', () => {
    const home = tmpDir();
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: {} }), 'utf8');
    assert.strictEqual(installer.readUserMcpEntry('telegram-bridge', home).present, false);
    const empty = tmpDir();
    assert.strictEqual(installer.readUserMcpEntry('telegram-bridge', empty).present, false, 'missing file is not an error');
  });

  console.log('global install: installer behaviour (dry-run + temp dirs only)');

  await test('installMcp dry-run plans an add on a clean config without spawning', () => {
    const home = tmpDir();
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }), 'utf8');
    const res = installer.installMcp({ dryRun: true, home });
    assert.strictEqual(res.action, 'add');
    assert.strictEqual(res.dryRun, true);
    assert.ok(res.args.includes('user'), 'user scope');
  });

  await test('installMcp refuses to clobber a foreign registration', () => {
    const home = tmpDir();
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { 'telegram-bridge': { command: 'python', args: ['other.py'] } } }),
      'utf8',
    );
    const res = installer.installMcp({ dryRun: true, home });
    assert.strictEqual(res.action, 'refused');
    assert.ok(/refusing to overwrite/.test(res.reason));
    assert.ok(!res.args, 'must not have planned an add');
  });

  await test('installMcp plans a replace (not a duplicate) for our own registration', () => {
    const home = tmpDir();
    const launcherPath = path.join(libDirRoot(), 'scripts', 'launch-channel.js');
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { 'telegram-bridge': { type: 'stdio', command: 'node', args: [launcherPath] } } }),
      'utf8',
    );
    const res = installer.installMcp({ dryRun: true, home });
    assert.strictEqual(res.action, 'replace', 're-running must not duplicate the entry');
  });

  await test('installWrappers writes both commands into a temp bin dir', () => {
    const binDir = tmpDir();
    const res = installer.installWrappers({ dryRun: false, binDir });
    assert.strictEqual(res.written.length, 2);
    for (const name of lib.WRAPPER_NAMES) {
      const p = path.join(binDir, name);
      assert.ok(fs.existsSync(p), `${name} written`);
      assert.ok(lib.isManaged(fs.readFileSync(p, 'utf8')), `${name} carries the marker`);
    }
  });

  await test('installWrappers refuses to overwrite an unmanaged file of the same name', () => {
    const binDir = tmpDir();
    const clash = path.join(binDir, lib.CLAUDE_TELEGRAM_CMD);
    fs.writeFileSync(clash, '@echo off\r\necho hand written\r\n', 'utf8');
    const res = installer.installWrappers({ dryRun: false, binDir });
    assert.strictEqual(res.skipped.length, 1);
    assert.strictEqual(res.skipped[0].name, lib.CLAUDE_TELEGRAM_CMD);
    assert.strictEqual(fs.readFileSync(clash, 'utf8'), '@echo off\r\necho hand written\r\n', 'file untouched');
    assert.strictEqual(res.written.length, 1, 'the other wrapper is still installed');
  });

  await test('installWrappers is idempotent (update in place, same content)', () => {
    const binDir = tmpDir();
    installer.installWrappers({ dryRun: false, binDir });
    const first = fs.readFileSync(path.join(binDir, lib.CLAUDE_TELEGRAM_CMD), 'utf8');
    const res = installer.installWrappers({ dryRun: false, binDir });
    const second = fs.readFileSync(path.join(binDir, lib.CLAUDE_TELEGRAM_CMD), 'utf8');
    assert.strictEqual(first, second);
    assert.ok(res.written.every((w) => w.status === 'updated'));
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`\n${f.name}\n${f.err && f.err.stack}`);
    process.exit(1);
  }
}

/** The repository root, used to build a realistic launcher path in tests. */
function libDirRoot() {
  return path.resolve(__dirname, '..');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
