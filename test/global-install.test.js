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
const uninstaller = require('../scripts/uninstall-global');
const { readEnvValue, parseEnvFile, applyEnvFile, resolveClaudeLaunch, parseShimLaunch } = require('../lib/config');

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

  console.log('global install: least-privilege channel configuration');

  await test('parseEnvFile returns key/value pairs WITHOUT mutating the environment', () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, '.env'), [
      '# comment',
      'CLAUDE_CHANNEL_PORT=8766',
      'TELEGRAM_BOT_TOKEN=do-not-import-me',
      "export QUOTED='quoted value'",
    ].join('\n'));
    const env = {};
    const pairs = parseEnvFile(root, fs);
    assert.deepStrictEqual(pairs.map((p) => p.key), ['CLAUDE_CHANNEL_PORT', 'TELEGRAM_BOT_TOKEN', 'QUOTED']);
    assert.strictEqual(pairs[2].value, 'quoted value');
    assert.deepStrictEqual(env, {}, 'environment untouched by parseEnvFile');
  });

  await test('applyEnvFile still applies keys with process-env precedence (Bridge behavior unchanged)', () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, '.env'), 'A_KEY=from-file\nPRESET=from-file\n');
    const env = { PRESET: 'from-process' };
    const applied = applyEnvFile(root, env, fs);
    assert.strictEqual(env.A_KEY, 'from-file');
    assert.strictEqual(env.PRESET, 'from-process');
    assert.ok(applied.includes('A_KEY') && !applied.includes('PRESET'));
  });

  await test('readEnvValue: explicit env wins, then .env, then undefined — never mutating', () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, '.env'), 'CLAUDE_CHANNEL_PORT=8766\n');
    assert.strictEqual(readEnvValue(root, 'CLAUDE_CHANNEL_PORT', { env: { CLAUDE_CHANNEL_PORT: '9100' }, fsImpl: fs }), '9100');
    assert.strictEqual(readEnvValue(root, 'CLAUDE_CHANNEL_PORT', { env: {}, fsImpl: fs }), '8766');
    assert.strictEqual(readEnvValue(root, 'MISSING_KEY', { env: {}, fsImpl: fs }), undefined);
    const env = {};
    readEnvValue(root, 'CLAUDE_CHANNEL_PORT', { env, fsImpl: fs });
    assert.deepStrictEqual(env, {}, 'readEnvValue must not mutate the env object');
  });

  await test('bootstrap reads CLAUDE_CHANNEL_PORT from .env WITHOUT importing unrelated Bridge keys', () => {
    const root = fakeRoot({ port: '8766' });
    // The Bridge .env contains unrelated secrets/config the Channel must NOT inherit.
    fs.writeFileSync(path.join(root, '.env'), [
      'CLAUDE_CHANNEL_PORT=8766',
      'TELEGRAM_BOT_TOKEN=bridge-only-token-value',
      'TELEGRAM_PROXY_URL=http://bridge-only-proxy:8080',
      'ALLOWED_TELEGRAM_IDS=123456',
    ].join('\n'));
    const injected = {}; // a "clean" injected environment
    const cfg = launcher.bootstrap({ root, env: injected, fsImpl: fs });
    assert.strictEqual(cfg.port, 8766, 'port resolved from .env');
    for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_PROXY_URL', 'ALLOWED_TELEGRAM_IDS']) {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(injected, k), false, `${k} must NOT leak into the channel environment`);
    }
    assert.strictEqual(Object.prototype.hasOwnProperty.call(injected, 'CLAUDE_CHANNEL_PORT'), false, 'bootstrap itself does not mutate env (applyToEnv does)');
  });

  await test('bootstrap + applyToEnv exposes ONLY the channel keys in the environment', () => {
    const root = fakeRoot({ port: '8766' });
    fs.writeFileSync(path.join(root, '.env'), [
      'CLAUDE_CHANNEL_PORT=8766',
      'TELEGRAM_BOT_TOKEN=bridge-only-token-value',
    ].join('\n'));
    const injected = {};
    const cfg = launcher.bootstrap({ root, env: injected, fsImpl: fs });
    launcher.applyToEnv(cfg, injected);
    const keys = Object.keys(injected).sort();
    assert.deepStrictEqual(keys, ['CLAUDE_CHANNEL_PORT', 'CLAUDE_CHANNEL_SECRET'], 'exactly the two channel keys may be exported');
    assert.ok(!JSON.stringify(keys).includes('TELEGRAM'), 'no Telegram configuration in the channel environment');
  });

  await test('describe() output never contains Bridge-only .env values', () => {
    const root = fakeRoot({ port: '8766' });
    fs.writeFileSync(path.join(root, '.env'), [
      'CLAUDE_CHANNEL_PORT=8766',
      'TELEGRAM_BOT_TOKEN=bridge-only-token-value',
    ].join('\n'));
    const cfg = launcher.bootstrap({ root, env: {}, fsImpl: fs });
    const d = JSON.stringify(launcher.describe(cfg));
    assert.ok(!d.includes('bridge-only-token-value'), 'describe must not leak unrelated .env values');
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
    const files = lib.wrapperContents({ root: 'C:\\bridge', claudeExe: 'claude', nodeExe: 'C:\\Program Files\\nodejs\\node.exe' });
    const body = files[lib.BRIDGE_CMD];
    assert.ok(body.includes('cd /d "C:\\bridge"'), 'cd to the bridge root');
    assert.ok(body.includes('"C:\\Program Files\\nodejs\\node.exe" "C:\\bridge\\bridge.js"'), 'runs the production entrypoint via the pinned node');
    assert.ok(body.includes('%*'), 'forwards extra arguments');
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

  await test('buildMcpAddArgs uses the ABSOLUTE node executable when given', () => {
    const args = lib.buildMcpAddArgs({
      launcherPath: 'C:\\bridge\\scripts\\launch-channel.js',
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
    });
    assert.deepStrictEqual(args, [
      'mcp', 'add', '-s', 'user', 'telegram-bridge', '--',
      'C:\\Program Files\\nodejs\\node.exe', 'C:\\bridge\\scripts\\launch-channel.js',
    ]);
  });

  await test('bridge wrapper pins the absolute node executable and preserves spaces', () => {
    const files = lib.wrapperContents({
      root: 'C:\\Some Folder\\telegram-claude-bridge',
      claudeExe: 'C:\\Users\\Test User\\.local\\bin\\claude.exe',
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
    });
    const bridge = files[lib.BRIDGE_CMD];
    assert.ok(bridge.includes('"C:\\Program Files\\nodejs\\node.exe"'), 'node pinned and quoted as one argument');
    assert.ok(bridge.includes('"C:\\Some Folder\\telegram-claude-bridge\\bridge.js"'), 'bridge path quoted as one argument');
    assert.ok(!/\bnode bridge\.js\b/.test(bridge), 'bare `node` must be gone');
    const claude = files[lib.CLAUDE_TELEGRAM_CMD];
    assert.ok(claude.includes('"C:\\Users\\Test User\\.local\\bin\\claude.exe"'), 'claude path quoted with spaces');
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

  await test('isOwnRegistration REJECTS a foreign launch-channel.js with the same basename', () => {
    // The old fallback accepted ANY existing launch-channel.js — this file must
    // be classified as NOT ours even though it exists and shares the basename.
    const otherRoot = tmpDir('tgbridge-foreign-');
    const foreign = path.join(otherRoot, 'scripts', 'launch-channel.js');
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, '// a foreign project launcher', 'utf8');
    const ours = path.join(libDirRoot(), 'scripts', 'launch-channel.js');
    assert.strictEqual(
      lib.isOwnRegistration({ type: 'stdio', command: 'node', args: [foreign] }, { launcherPath: ours, fsImpl: fs }),
      false,
      'same-basename foreign launcher must not be ours',
    );
  });

  await test('isOwnRegistration accepts the exact own launcher with different slash/case on Windows', () => {
    const ours = path.join(libDirRoot(), 'scripts', 'launch-channel.js');
    const variant = path.join(libDirRoot(), 'scripts', 'LAUNCH-CHANNEL.js').replace(/\\/g, '/');
    assert.strictEqual(
      lib.isOwnRegistration({ type: 'stdio', command: 'node', args: [variant] }, { launcherPath: ours, fsImpl: fs }),
      true,
      'Windows ownership comparison is case/slash-insensitive',
    );
  });

  await test('samePath: absolute+slash normalization, win32 case-insensitive, posix case-sensitive', () => {
    assert.strictEqual(lib.samePath('C:\\A\\B\\c.js', 'c:/a/b/C.JS', 'win32'), true);
    assert.strictEqual(lib.samePath('C:\\A\\B\\c.js', 'C:\\A\\B\\d.js', 'win32'), false);
    assert.strictEqual(lib.samePath('/a/b/c.js', '/a/b/c.js', 'linux'), true);
    assert.strictEqual(lib.samePath('/a/b/c.js', '/A/B/c.js', 'linux'), false, 'Unix comparison stays case-sensitive');
    assert.strictEqual(lib.samePath('relative/path.js', 'relative/path.js', 'win32'), false, 'relative paths never match');
    assert.strictEqual(lib.samePath('', 'C:\\x', 'win32'), false);
  });

  await test('isOwnRegistration no longer depends on file existence for moved-path acceptance', () => {
    // Exact path match must work even if fsImpl says the file does not exist
    // (e.g. drive not mounted) — ownership is a path comparison, not a lookup.
    const ours = 'C:\\Does\\Not\\Exist\\scripts\\launch-channel.js';
    const fakeFs = { existsSync: () => false };
    assert.strictEqual(
      lib.isOwnRegistration({ type: 'stdio', command: 'node.exe', args: [ours] }, { launcherPath: ours, fsImpl: fakeFs }),
      true,
    );
  });

  await test('installMcp refuses a foreign SAME-BASENAME registration (no removal, no replace)', () => {
    const home = tmpDir();
    const otherRoot = tmpDir('tgbridge-foreign2-');
    const foreign = path.join(otherRoot, 'scripts', 'launch-channel.js');
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, '// foreign launcher', 'utf8');
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { 'telegram-bridge': { type: 'stdio', command: 'node', args: [foreign] } } }),
      'utf8',
    );
    const res = installer.installMcp({ dryRun: true, home, nodeExe: 'C:\\Program Files\\nodejs\\node.exe' });
    assert.strictEqual(res.action, 'refused', 'foreign same-basename registration must be refused');
    const parsed = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    assert.deepStrictEqual(parsed.mcpServers['telegram-bridge'].args, [foreign], 'foreign config untouched');
    assert.ok(!res.args, 'no add planned');
  });

  await test('uninstall refusals + removals are decided by exact ownership (dry-run)', () => {
    const otherRoot = tmpDir('tgbridge-foreign3-');
    const foreign = path.join(otherRoot, 'scripts', 'launch-channel.js');
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, '// foreign', 'utf8');
    const ours = path.join(libDirRoot(), 'scripts', 'launch-channel.js');
    const { isOwnRegistration } = lib;
    // Foreign (even with an existing file) must be removable-eligible only via --force.
    assert.strictEqual(isOwnRegistration({ command: 'node', args: [foreign] }, { launcherPath: ours, fsImpl: fs }), false);
    // Our exact path is ours.
    assert.strictEqual(isOwnRegistration({ command: 'node', args: [ours] }, { launcherPath: ours, fsImpl: fs }), true);
  });

  await test('installMcp dry-run shows the pinned absolute node executable', () => {
    const home = tmpDir();
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }), 'utf8');
    const res = installer.installMcp({ dryRun: true, home, nodeExe: 'C:\\Program Files\\nodejs\\node.exe' });
    assert.strictEqual(res.action, 'add');
    assert.ok(res.args.includes('C:\\Program Files\\nodejs\\node.exe'), 'dry-run argv carries the real executable');
    assert.ok(!res.args.includes('node'), 'bare node gone from argv');
  });

  // ------------------------------------------------------------------------
  // Portability pass: --force parsing, uninstall exit status, Claude launch
  // specs, PATH-verified bin dirs, honest partial-install reporting.
  // ------------------------------------------------------------------------

  console.log('global install: uninstall argument parsing (--force)');

  await test('parseUninstallArgs accepts --force alone and with --dry-run', () => {
    const a = uninstaller.parseUninstallArgs(['--force']);
    assert.strictEqual(a.force, true);
    assert.strictEqual(a.dryRun, false);
    const b = uninstaller.parseUninstallArgs(['--force', '--dry-run']);
    assert.strictEqual(b.force, true);
    assert.strictEqual(b.dryRun, true);
  });

  await test('parseUninstallArgs accepts --bin-dir in both forms', () => {
    const a = uninstaller.parseUninstallArgs(['--bin-dir', 'D:\\bin']);
    assert.strictEqual(a.binDir, 'D:\\bin');
    const b = uninstaller.parseUninstallArgs(['--bin-dir=D:\\bin']);
    assert.strictEqual(b.binDir, 'D:\\bin');
  });

  await test('parseUninstallArgs rejects unknown options and missing --bin-dir value', () => {
    assert.throws(() => uninstaller.parseUninstallArgs(['--no-mcp']), /unknown option: --no-mcp/);
    assert.throws(() => uninstaller.parseUninstallArgs(['--no-wrappers']), /unknown option: --no-wrappers/);
    assert.throws(() => uninstaller.parseUninstallArgs(['--wat']), /unknown option: --wat/);
    assert.throws(() => uninstaller.parseUninstallArgs(['--bin-dir']), /--bin-dir requires a directory argument/);
    assert.throws(() => uninstaller.parseUninstallArgs(['stray']), /unexpected positional/);
  });

  await test('uninstall --force --dry-run runs and mutates nothing (end-to-end main)', () => {
    const otherRoot = tmpDir('tgbridge-force1-');
    const foreign = path.join(otherRoot, 'scripts', 'launch-channel.js');
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, '// foreign launcher', 'utf8');
    const home = tmpDir();
    const claudeJson = path.join(home, '.claude.json');
    fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { 'telegram-bridge': { type: 'stdio', command: 'node', args: [foreign] } } }), 'utf8');
    const binDir = tmpDir();
    const realHomedir = os.homedir;
    os.homedir = () => home;
    try {
      const code = uninstaller.main.call(null, ['--force', '--dry-run', '--bin-dir', binDir]);
      assert.strictEqual(code, 0, 'valid dry run exits 0');
      const parsed = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
      assert.deepStrictEqual(parsed.mcpServers['telegram-bridge'].args, [foreign], 'dry run removes nothing');
    } finally {
      os.homedir = realHomedir;
    }
  });

  await test('foreign MCP survives a NORMAL uninstall but is removed with --force (removal CLI invoked only when forced)', () => {
    const otherRoot = tmpDir('tgbridge-force2-');
    const foreign = path.join(otherRoot, 'scripts', 'launch-channel.js');
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, '// foreign launcher', 'utf8');
    const home = tmpDir();
    const claudeJson = path.join(home, '.claude.json');
    const writeConfig = () => fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { 'telegram-bridge': { type: 'stdio', command: 'node', args: [foreign] } } }), 'utf8');
    const realHomedir = os.homedir;
    const realRun = installer.runClaude;
    os.homedir = () => home;
    // Stub the claude CLI and record every removal invocation.
    const removals = [];
    installer.runClaude = (args) => {
      if (args[1] === 'remove') removals.push(args);
      return { ok: true, stdout: 'removed' };
    };
    try {
      writeConfig();
      let code = uninstaller.main(['--bin-dir', tmpDir()]);
      assert.strictEqual(code, 0);
      assert.strictEqual(removals.length, 0, 'NO claude mcp remove without --force');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(claudeJson, 'utf8')).mcpServers['telegram-bridge'].args, [foreign], 'foreign registration SURVIVES without --force');

      writeConfig();
      code = uninstaller.main(['--force', '--bin-dir', tmpDir()]);
      assert.strictEqual(code, 0, 'forced removal of a foreign registration succeeds');
      assert.strictEqual(removals.length, 1, '--force invokes claude mcp remove exactly once');
      assert.deepStrictEqual(removals[0], ['mcp', 'remove', '-s', 'user', 'telegram-bridge'], 'removal is user-scoped');
    } finally {
      os.homedir = realHomedir;
      installer.runClaude = realRun;
    }
  });

  await test('failed claude mcp remove makes uninstall exit non-zero with a precise error', () => {
    const ours = path.join(libDirRoot(), 'scripts', 'launch-channel.js');
    const claudeJson = path.join(tmpDir(), '.claude.json');
    fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { 'telegram-bridge': { type: 'stdio', command: 'node', args: [ours] } } }), 'utf8');
    const realHomedir = os.homedir;
    const realRun = installer.runClaude;
    os.homedir = () => path.dirname(claudeJson);
    installer.runClaude = () => ({ ok: false, stderr: 'simulated claude mcp remove failure' });
    try {
      const code = uninstaller.main(['--bin-dir', tmpDir()]);
      assert.strictEqual(code, 1, 'failed removal must exit non-zero');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(claudeJson, 'utf8')).mcpServers['telegram-bridge'].args, [ours], 'config untouched when removal fails');
    } finally {
      os.homedir = realHomedir;
      installer.runClaude = realRun;
    }
  });

  await test('--force never deletes unmanaged wrapper files (MCP override is MCP-only)', () => {
    const ours = path.join(libDirRoot(), 'scripts', 'launch-channel.js');
    const claudeJson = path.join(tmpDir(), '.claude.json');
    fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { 'telegram-bridge': { type: 'stdio', command: 'node', args: [ours] } } }), 'utf8');
    const binDir = tmpDir();
    const clash = path.join(binDir, lib.CLAUDE_TELEGRAM_CMD);
    fs.writeFileSync(clash, '@echo off\r\necho hand written\r\n', 'utf8');
    const realHomedir = os.homedir;
    const realRun = installer.runClaude;
    os.homedir = () => path.dirname(claudeJson);
    installer.runClaude = () => ({ ok: true, stdout: 'removed' });
    try {
      const code = uninstaller.main(['--force', '--bin-dir', binDir]);
      assert.strictEqual(code, 0);
      assert.strictEqual(fs.readFileSync(clash, 'utf8'), '@echo off\r\necho hand written\r\n', 'unmanaged wrapper untouched even with --force');
    } finally {
      os.homedir = realHomedir;
      installer.runClaude = realRun;
    }
  });

  console.log('global install: Claude launch specs (.cmd/.bat shim support)');

  await test('resolveClaudeLaunch accepts a native claude.exe', () => {
    const root = tmpDir();
    const exe = path.join(root, 'claude.exe');
    fs.writeFileSync(exe, 'MZ', 'utf8');
    const spec = resolveClaudeLaunch(exe, { fsImpl: fs, platform: 'win32' });
    assert.ok(spec.ok, spec.error);
    assert.strictEqual(spec.command, path.resolve(exe));
    assert.deepStrictEqual(spec.prefixArgs, []);
  });

  await test('resolveClaudeLaunch models a node-invoking claude.cmd shim safely', () => {
    const root = tmpDir();
    const nodeExe = path.join(root, 'node.exe');
    const cliJs = path.join(root, 'node_modules', 'claude', 'cli.js');
    fs.mkdirSync(path.dirname(cliJs), { recursive: true });
    fs.writeFileSync(nodeExe, 'MZ', 'utf8');
    fs.writeFileSync(cliJs, '// cli', 'utf8');
    const shim = path.join(root, 'claude.cmd');
    fs.writeFileSync(shim, `@echo off\r\nnode  "%~dp0\\node_modules\\claude\\cli.js" %*\r\n`, 'utf8');
    const shimSpec = parseShimLaunch(shim, fs);
    assert.ok(shimSpec, 'shim must be modelable');
    // The shim's bare `node` resolves against the injected PATH.
    const env = { PATH: root };
    const spec = resolveClaudeLaunch('claude', { fsImpl: fs, platform: 'win32', env, nodeExe });
    assert.ok(spec.ok, spec.error);
    assert.strictEqual(path.basename(spec.command).toLowerCase(), 'node.exe');
    assert.strictEqual(spec.prefixArgs.length, 1);
    assert.ok(spec.prefixArgs[0].toLowerCase().endsWith('cli.js'));
  });

  await test('an unmodelable shim fails with the resolver error (never guessed)', () => {
    const root = tmpDir();
    const shim = path.join(root, 'claude.cmd');
    fs.writeFileSync(shim, '@echo off\r\nstart-something-weird --flag', 'utf8');
    const env = { PATH: root };
    const spec = resolveClaudeLaunch('claude', { fsImpl: fs, platform: 'win32', env });
    assert.strictEqual(spec.ok, false);
    assert.ok(/Unable to safely resolve/.test(spec.error));
  });

  await test('runClaude executes through the resolved launch spec (prefixArgs honored)', () => {
    const calls = [];
    const childProcess = require('child_process');
    const origExec = childProcess.execFileSync;
    childProcess.execFileSync = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return 'ok';
    };
    try {
      const launch = { command: 'C:\\Program Files\\nodejs\\node.exe', prefixArgs: ['C:\\claude\\cli.js'] };
      const r = installer.runClaude(['mcp', 'get', 'telegram-bridge'], launch);
      assert.ok(r.ok);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].cmd, launch.command);
      assert.deepStrictEqual(calls[0].args, [...launch.prefixArgs, 'mcp', 'get', 'telegram-bridge'], 'prefixArgs precede the claude argv');
      assert.strictEqual(calls[0].opts.shell, false, 'never a shell');
    } finally {
      childProcess.execFileSync = origExec;
    }
  });

  await test('runClaude without a resolvable claude returns a clean failure (no throw)', () => {
    const r = installer.runClaude(['mcp', 'get'], { ok: false, command: null, prefixArgs: null, error: 'resolver error text' });
    assert.strictEqual(r.ok, false);
    assert.ok(/resolver error text/.test(r.stderr));
  });

  await test('claude wrapper uses the launch spec: native exe', () => {
    const files = lib.wrapperContents({
      root: 'C:\\bridge',
      claudeLaunch: { command: 'C:\\Users\\Test User\\.local\\bin\\claude.exe', prefixArgs: [] },
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
    });
    const body = files[lib.CLAUDE_TELEGRAM_CMD];
    assert.ok(body.includes('"C:\\Users\\Test User\\.local\\bin\\claude.exe" --dangerously-load-development-channels server:telegram-bridge %*'));
  });

  await test('claude wrapper uses the launch spec: node + cli.js shim', () => {
    const files = lib.wrapperContents({
      root: 'C:\\bridge',
      claudeLaunch: { command: 'C:\\Program Files\\nodejs\\node.exe', prefixArgs: ['C:\\Users\\Test User\\AppData\\claude-cli.js'] },
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
    });
    const body = files[lib.CLAUDE_TELEGRAM_CMD];
    assert.ok(body.includes('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Test User\\AppData\\claude-cli.js" --dangerously-load-development-channels server:telegram-bridge %*'), 'shim invocation is two quoted argv elements');
  });

  await test('claudeInvocation quotes every argv element so spaces survive', () => {
    const line = lib.claudeInvocation({ command: 'C:\\Pro gram\\claude.exe', prefixArgs: ['C:\\a b\\x.js'] }, '--flag');
    assert.strictEqual(line, '"C:\\Pro gram\\claude.exe" "C:\\a b\\x.js" --flag %*');
  });

  console.log('global install: PATH-verified bin directory');

  await test('isDirectoryOnPath: present, absent, case-insensitive on Windows, case-sensitive on POSIX', () => {
    const env = { PATH: 'C:\\Users\\x\\.local\\bin;C:\\Windows\\system32' };
    assert.strictEqual(lib.isDirectoryOnPath('C:\\Users\\x\\.local\\bin', { env, platform: 'win32' }), true);
    assert.strictEqual(lib.isDirectoryOnPath('c:\\users\\X\\.LOCAL\\BIN', { env, platform: 'win32' }), true, 'Windows is case-insensitive');
    assert.strictEqual(lib.isDirectoryOnPath('C:\\not\\on\\path', { env, platform: 'win32' }), false);
    const posix = { PATH: '/home/x/.local/bin:/usr/bin' };
    assert.strictEqual(lib.isDirectoryOnPath('/home/x/.local/bin', { env: posix, platform: 'linux' }), true);
    assert.strictEqual(lib.isDirectoryOnPath('/HOME/X/.LOCAL/BIN', { env: posix, platform: 'linux' }), false, 'POSIX stays case-sensitive');
  });

  await test('resolveBinDir: default on PATH, npm fallback, explicit not-on-PATH, and clear failure', () => {
    const home = 'C:\\Users\\x';
    // Default dir IS on PATH.
    let r = lib.resolveBinDir({ env: { PATH: 'C:\\Users\\x\\.local\\bin' }, platform: 'win32', home });
    assert.strictEqual(r.onPath, true);
    assert.strictEqual(r.dir, path.join(home, '.local', 'bin'));
    // Default NOT on PATH, but the npm global bin dir is -> fallback with a note.
    r = lib.resolveBinDir({ env: { PATH: 'C:\\Users\\x\\AppData\\Roaming\\npm', APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, platform: 'win32', home });
    assert.strictEqual(r.onPath, true);
    assert.ok(r.note, 'fallback explains itself');
    // Explicit --bin-dir not on PATH: honored, but flagged.
    r = lib.resolveBinDir({ env: { PATH: 'C:\\Windows\\system32' }, platform: 'win32', home, explicit: 'D:\\tools' });
    assert.strictEqual(r.dir, path.resolve('D:\\tools'));
    assert.strictEqual(r.onPath, false);
    assert.strictEqual(r.explicit, true);
    // Nothing on PATH and nothing explicit -> clear failure (never auto-modify PATH).
    r = lib.resolveBinDir({ env: { PATH: 'C:\\Windows\\system32' }, platform: 'win32', home });
    assert.strictEqual(r.dir, null);
    assert.ok(/--bin-dir/.test(r.error), 'failure names the remediation');
  });

  await test('installMcp dry-run with a shim launch spec still pins the absolute node for the MCP', () => {
    const home = tmpDir();
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }), 'utf8');
    const res = installer.installMcp({
      dryRun: true,
      home,
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
      claudeLaunch: { command: 'C:\\Program Files\\nodejs\\node.exe', prefixArgs: ['C:\\claude\\cli.js'] },
    });
    assert.strictEqual(res.action, 'add');
    assert.ok(res.args.includes('C:\\Program Files\\nodejs\\node.exe'), 'MCP command is the pinned node');
    assert.ok(!res.args.includes('C:\\claude\\cli.js'), 'the Claude shim cli.js is NOT part of the MCP registration (separate concerns)');
  });

  await test('a skipped (unmanaged) wrapper makes the installer exit non-zero (partial install)', () => {
    const binDir = tmpDir();
    const clash = path.join(binDir, lib.BRIDGE_CMD);
    fs.writeFileSync(clash, '@echo off\r\necho mine\r\n', 'utf8');
    const realHomedir = os.homedir;
    os.homedir = () => tmpDir();
    try {
      // Dry run: skipped wrapper detected -> non-zero.
      let code = installer.main(['--dry-run', '--json', '--bin-dir', binDir, '--no-mcp']);
      assert.strictEqual(code, 1, 'skipped wrapper must fail the install status');
      // Real write: same.
      code = installer.main(['--json', '--bin-dir', binDir, '--no-mcp']);
      assert.strictEqual(code, 1);
      assert.strictEqual(fs.readFileSync(clash, 'utf8'), '@echo off\r\necho mine\r\n', 'unmanaged file untouched');
    } finally {
      os.homedir = realHomedir;
    }
  });

  await test('install-global exits non-zero when the bin dir is not on PATH (dry run, JSON)', () => {
    const binDir = tmpDir();
    const realHomedir = os.homedir;
    const realPrereq = installer.checkPrerequisites;
    os.homedir = () => tmpDir();
    // Stub prerequisites so the test does not depend on the REAL machine PATH
    // (which must keep containing node/claude for everything else to work).
    installer.checkPrerequisites = () => ({
      problems: [],
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
      claudeLaunch: { command: 'C:\\Program Files\\nodejs\\node.exe', prefixArgs: ['C:\\claude\\cli.js'] },
    });
    try {
      let out = '';
      const origWrite = process.stdout.write;
      process.stdout.write = (s) => { out += s; return true; };
      let code;
      try {
        code = installer.main(['--dry-run', '--json', '--bin-dir', binDir, '--no-mcp']);
      } finally {
        process.stdout.write = origWrite;
      }
      assert.strictEqual(code, 1, 'not-on-PATH bin dir is a partial/failed install');
      const parsed = JSON.parse(out);
      assert.strictEqual(parsed.binOnPath, false);
    } finally {
      os.homedir = realHomedir;
      installer.checkPrerequisites = realPrereq;
    }
  });

  await test('a clean install into an on-PATH bin dir exits 0 (dry run, JSON)', () => {
    const binDir = tmpDir();
    const realHomedir = os.homedir;
    const realPrereq = installer.checkPrerequisites;
    const realPath = process.env.PATH;
    os.homedir = () => tmpDir();
    installer.checkPrerequisites = () => ({
      problems: [],
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
      claudeLaunch: { command: 'C:\\Program Files\\nodejs\\node.exe', prefixArgs: ['C:\\claude\\cli.js'] },
    });
    try {
      let out = '';
      const origWrite = process.stdout.write;
      // The temp bin dir must appear on PATH for THIS process: append it.
      process.env.PATH = `${binDir}${path.delimiter}${realPath || ''}`;
      process.stdout.write = (s) => { out += s; return true; };
      let code;
      try {
        code = installer.main(['--dry-run', '--json', '--bin-dir', binDir, '--no-mcp']);
      } finally {
        process.stdout.write = origWrite;
      }
      assert.strictEqual(code, 0);
      const parsed = JSON.parse(out);
      assert.strictEqual(parsed.binOnPath, true);
      assert.strictEqual(parsed.wrappers.action, 'planned');
    } finally {
      os.homedir = realHomedir;
      installer.checkPrerequisites = realPrereq;
      process.env.PATH = realPath;
    }
  });

  await test('installMcp plans a rollback of the previous registration when add fails (non-dry-run, stubbed runClaude)', () => {
    const home = tmpDir();
    const ours = path.join(libDirRoot(), 'scripts', 'launch-channel.js');
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { 'telegram-bridge': { type: 'stdio', command: 'node', args: [ours] } } }),
      'utf8',
    );
    const calls = [];
    let addCalls = 0;
    const origRun = installer.runClaude;
    installer.runClaude = (args) => {
      calls.push(args);
      if (args[1] === 'add') {
        addCalls += 1;
        if (addCalls === 1) return { ok: false, stderr: 'simulated add failure' }; // the FIRST add fails
      }
      return { ok: true, stdout: 'ok' };
    };
    try {
      const res = installer.installMcp({ dryRun: false, home, nodeExe: 'C:\\Program Files\\nodejs\\node.exe' });
      assert.strictEqual(res.action, 'failed');
      assert.strictEqual(res.rollback, 'previous registration restored', 'rollback attempted and reported');
      assert.strictEqual(calls.length, 3, 'remove -> add -> rollback add');
      assert.deepStrictEqual(calls[2].slice(4), ['telegram-bridge', '--', 'node', ours], 'rollback re-adds the PREVIOUS registration');
    } finally {
      installer.runClaude = origRun;
    }
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
