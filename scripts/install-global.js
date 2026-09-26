#!/usr/bin/env node
'use strict';

/**
 * `npm run install-global` — install the telegram-bridge Channel for the
 * current Windows user, so NO project needs its own .mcp.json.
 *
 * It performs exactly three things:
 *
 *   1. registers the MCP server `telegram-bridge` at USER scope, pointing at
 *      scripts/launch-channel.js (paths only — never the secret)
 *   2. writes two wrapper commands into a directory already on the user PATH
 *        claude-telegram         — Claude in the current dir, Channel enabled
 *        telegram-claude-bridge  — start the central Bridge
 *   3. verifies both, and prints what it did
 *
 * Safe to run repeatedly: an existing OWN registration is replaced, never
 * duplicated. An existing registration that is NOT ours is left alone and
 * reported (we never clobber unrelated configuration).
 *
 * Flags:
 *   --dry-run        show what would change, touch nothing
 *   --bin-dir <dir>  where to write the wrappers (default ~/.local/bin)
 *   --no-mcp         skip the MCP registration step
 *   --no-wrappers    skip the wrapper step
 *   --json           machine-readable summary on stdout
 *   --help
 *
 * Every subprocess is spawned with shell:false. No secret is ever printed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LAUNCHER = path.join(ROOT, 'scripts', 'launch-channel.js');
const BRIDGE_ENTRY = path.join(ROOT, 'bridge.js');

const { findExecutableInPath, resolveClaudeLaunch } = require(path.join(ROOT, 'lib', 'config.js'));
const {
  MCP_SERVER_NAME,
  WRAPPER_NAMES,
  wrapperNamesFor,
  defaultBinDir,
  isDirectoryOnPath,
  resolveBinDir,
  wrapperContents,
  isManaged,
  buildMcpAddArgs,
  buildMcpRemoveArgs,
  buildMcpGetArgs,
  isOwnRegistration,
} = require('./global-install-lib.js');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { dryRun: false, binDir: null, noMcp: false, noWrappers: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-mcp') opts.noMcp = true;
    else if (a === '--no-wrappers') opts.noWrappers = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--bin-dir') {
      if (i + 1 >= argv.length) throw new Error('--bin-dir requires a directory argument');
      opts.binDir = argv[i + 1];
      i += 1;
    }
    else if (a.startsWith('--bin-dir=')) opts.binDir = a.slice('--bin-dir='.length);
    else if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
    else throw new Error(`unexpected positional argument: ${a}`);
  }
  return opts;
}

const HELP = `install-global — install the telegram-bridge Channel for this user

Usage: node scripts/install-global.js [options]

  --dry-run        show what would change, touch nothing
  --bin-dir <dir>  directory for the wrapper commands (default ~/.local/bin;
                   the directory must already be on PATH — it is verified,
                   never assumed, and PATH is never modified automatically)
  --no-mcp         skip the user-scope MCP registration
  --no-wrappers    skip installing the wrapper commands
  --json           print a machine-readable summary
  --help
`;

/**
 * Run a `claude` CLI subcommand through the resolved Claude LAUNCH SPEC
 * { command, prefixArgs } — always shell:false, argv-preserved (paths with
 * spaces stay single arguments). The spec comes from checkPrerequisites()
 * (lib/config.js resolveClaudeLaunch), so native claude.exe AND Windows
 * .cmd/.bat shim installations both work. Tests may stub module.exports.runClaude.
 */
function runClaude(args, claudeLaunch = null) {
  const launch = claudeLaunch || resolveClaudeLaunch('claude', { fsImpl: fs, platform: process.platform, env: process.env });
  // Accept BOTH shapes: a full resolver result ({ok, command, prefixArgs, error})
  // and a plain launch spec ({command, prefixArgs}). Only a spec with a usable
  // command proceeds — a failed/unmodelable resolution never runs.
  const usable = launch && typeof launch.command === 'string' && launch.command &&
    Array.isArray(launch.prefixArgs || []) &&
    (launch.ok !== false);
  if (!usable) {
    return { ok: false, stderr: (launch && launch.error) || 'Claude Code CLI could not be resolved safely', status: null };
  }
  try {
    const stdout = childProcess.execFileSync(launch.command, [...launch.prefixArgs, ...args], { encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stdout: String(stdout || '') };
  } catch (err) {
    return {
      ok: false,
      stdout: String((err && err.stdout) || ''),
      stderr: String((err && err.stderr) || (err && err.message) || ''),
      status: err && err.status,
    };
  }
}

/** Read the user-scope MCP entry for `name` from ~/.claude.json (read-only). */
function readUserMcpEntry(name = MCP_SERVER_NAME, home = os.homedir()) {
  const file = path.join(home, '.claude.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { present: false, entry: null, file };
  }
  const servers = parsed && parsed.mcpServers;
  if (!servers || typeof servers !== 'object' || !servers[name]) return { present: false, entry: null, file };
  return { present: true, entry: servers[name], file };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Verify prerequisites and resolve the two executables the installer needs:
 *   - nodeExe: absolute node (pinned into the MCP registration)
 *   - claudeLaunch: the Claude LAUNCH SPEC { command, prefixArgs } used for
 *     every `claude mcp ...` invocation AND baked into claude-telegram.cmd.
 *     Resolved by the Bridge's own safe resolver (resolveClaudeLaunch), so a
 *     Windows .cmd/.bat shim installation is modeled safely or fails with
 *     its clear error — the installer never guesses.
 */
function checkPrerequisites() {
  const problems = [];
  for (const [label, p] of [['launcher', LAUNCHER], ['bridge entry', BRIDGE_ENTRY], ['package.json', path.join(ROOT, 'package.json')]]) {
    if (!fs.existsSync(p)) problems.push(`${label} missing: ${p}`);
  }
  const claudeCheck = resolveClaudeLaunch('claude', { fsImpl: fs, platform: process.platform, env: process.env });
  if (!claudeCheck.ok) problems.push(`Claude Code CLI could not be resolved safely: ${claudeCheck.error}`);
  const nodeExe = findExecutableInPath('node', process.platform, process.env, fs);
  if (!nodeExe) problems.push('`node` not found on PATH');
  const claudeLaunch = claudeCheck.ok ? { command: claudeCheck.command, prefixArgs: claudeCheck.prefixArgs } : null;
  return { problems, nodeExe, claudeLaunch };
}

function secretStatus() {
  const explicit = String(process.env.CLAUDE_CHANNEL_SECRET_FILE || '').trim();
  const p = explicit ? path.resolve(explicit) : path.join(ROOT, 'state', 'channel-secret');
  try {
    const len = fs.readFileSync(p, 'utf8').trim().length;
    return { path: p, present: len >= 16, length: len };
  } catch {
    return { path: p, present: false, length: 0 };
  }
}

function installMcp({ dryRun, home = os.homedir(), nodeExe = 'node', claudeLaunch = null }) {
  const before = readUserMcpEntry(MCP_SERVER_NAME, home);
  if (before.present && !isOwnRegistration(before.entry, { launcherPath: LAUNCHER, fsImpl: fs })) {
    return {
      action: 'refused',
      reason: `a user-scope MCP server named "${MCP_SERVER_NAME}" already exists and was not created by this installer — refusing to overwrite it. Remove it manually with: claude mcp remove -s user ${MCP_SERVER_NAME}`,
      existing: { command: before.entry && before.entry.command, args: before.entry && before.entry.args },
    };
  }

  // PIN the absolute Node executable resolved by checkPrerequisites(): the
  // registered command must not depend on whatever PATH Claude Code inherits.
  const addArgs = buildMcpAddArgs({ launcherPath: LAUNCHER, nodeExe: nodeExe || 'node' });
  if (dryRun) {
    return { action: before.present ? 'replace' : 'add', args: addArgs, dryRun: true };
  }

  // Replacement is failure-safe: remember the previous OWN registration so a
  // failed `claude mcp add` can roll it back instead of leaving NO registration.
  const previous = before.present ? { command: before.entry.command, args: [...(before.entry.args || [])] } : null;

  // Remove first so re-running never creates a duplicate entry.
  // (Called via module.exports so tests can stub the subprocess runner.)
  // The removal result is CHECKED: if it fails, abort immediately — the old
  // registration should still exist, so no rollback is needed and no new
  // `mcp add` may run (a failed removal followed by an add could leave a
  // duplicate or a half-replaced registration while reporting "replaced").
  if (before.present) {
    const removed = module.exports.runClaude(buildMcpRemoveArgs(), claudeLaunch);
    if (!removed.ok) {
      return {
        action: 'failed',
        error: `could not remove the existing registration before replacing it: ${removed.stderr || removed.stdout || 'claude mcp remove failed'}`,
      };
    }
  }
  const added = module.exports.runClaude(addArgs, claudeLaunch);
  if (!added.ok) {
    let rollback = null;
    if (previous) {
      const restore = module.exports.runClaude(['mcp', 'add', '-s', 'user', MCP_SERVER_NAME, '--', previous.command, ...previous.args], claudeLaunch);
      rollback = restore.ok ? 'previous registration restored' : `ROLLBACK FAILED: previous registration could not be restored (run: claude mcp add -s user ${MCP_SERVER_NAME} -- ${previous.command} ${previous.args.join(' ')})`;
    }
    return { action: 'failed', error: added.stderr || added.stdout || 'claude mcp add failed', rollback };
  }

  const verified = module.exports.runClaude(buildMcpGetArgs(), claudeLaunch);
  return {
    action: before.present ? 'replaced' : 'added',
    args: addArgs,
    verified: verified.ok,
    detail: verified.ok ? verified.stdout.trim().split('\n')[0] : 'verification via `claude mcp get` failed',
  };
}

function installWrappers({ dryRun, binDir, nodeExe = 'node', claudeLaunch = null, platform = process.platform }) {
  const names = wrapperNamesFor(platform);
  const files = wrapperContents({ root: ROOT, claudeLaunch, nodeExe: nodeExe || 'node', platform });
  const written = [];
  const skipped = [];

  if (!dryRun && !fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

  for (const name of names) {
    const target = path.join(binDir, name);
    let existing = null;
    try {
      existing = fs.readFileSync(target, 'utf8');
    } catch {
      existing = null;
    }
    if (existing !== null && !isManaged(existing)) {
      skipped.push({ name, reason: 'exists but was not created by this installer — left untouched' });
      continue;
    }
    const status = existing === null ? 'created' : 'updated';
    if (!dryRun) {
      fs.writeFileSync(target, files[name], 'utf8');
      if (platform !== 'win32') {
        // POSIX wrappers must be executable to be usable from a shell/PATH.
        fs.chmodSync(target, 0o755);
      }
    }
    written.push({ name, path: target, status });
  }

  const launch = claudeLaunch || { command: 'claude', prefixArgs: [] };
  return { binDir, written, skipped, claudeLaunch: launch, platform };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const log = opts.json ? () => {} : (m) => process.stdout.write(`${m}\n`);
  // Routed through module.exports so tests can stub prerequisite discovery.
  const { problems, nodeExe, claudeLaunch } = module.exports.checkPrerequisites();
  const secret = secretStatus();

  if (problems.length) {
    for (const p of problems) process.stderr.write(`error: ${p}\n`);
    return 1;
  }

  // WHERE do the wrappers go? The bin directory is verified against PATH —
  // never assumed. Default falls back to the npm global bin dir; an explicit
  // --bin-dir is honored but warned about when it is not on PATH.
  // NOTE: with --no-wrappers there is nothing to place, so no bin directory
  // is required, validated, or reported — a machine with no suitable PATH
  // directory can still install the MCP cleanly.
  const bin = opts.noWrappers
    ? null
    : resolveBinDir({ env: process.env, platform: process.platform, explicit: opts.binDir });
  if (bin && bin.error) {
    process.stderr.write(`error: ${bin.error}\n`);
    return 1;
  }
  const binDir = bin ? bin.dir : null;

  log(`telegram-bridge — global install${opts.dryRun ? ' (dry run)' : ''}`);
  log(`  bridge root : ${ROOT}`);
  log(`  launcher    : ${LAUNCHER}`);
  log(`  node        : ${nodeExe}`);
  log(`  claude      : ${claudeLaunch.command}${claudeLaunch.prefixArgs.length ? ' ' + claudeLaunch.prefixArgs.join(' ') : ''}`);
  if (bin) {
    log(`  bin dir     : ${binDir}${bin.onPath ? '' : '  (WARNING: not on PATH — commands will not resolve globally)'}`);
    if (bin.note) log(`  note        : ${bin.note}`);
  }
  log(`  secret      : ${secret.path} (${secret.present ? `ok, ${secret.length} chars` : 'NOT FOUND'})`);
  log('');

  const result = { root: ROOT, launcher: LAUNCHER, binDir, binOnPath: bin ? bin.onPath : null, dryRun: opts.dryRun, secret: { path: secret.path, present: secret.present, length: secret.length } };
  let exitCode = 0;

  if (opts.noMcp) {
    result.mcp = { action: 'skipped' };
  } else {
    result.mcp = installMcp({ dryRun: opts.dryRun, nodeExe, claudeLaunch });
    const r = result.mcp;
    if (r.action === 'refused' || r.action === 'failed') {
      log(`  MCP: ${r.action} — ${r.reason || r.error}`);
      if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 1;
    }
    log(`  MCP: ${r.action} user-scope server "${MCP_SERVER_NAME}"${r.dryRun ? '' : r.verified ? ' (verified)' : ' (WARNING: not verified)'}`);
    // Registration succeeded but verification failed: report it honestly.
    if (!r.dryRun && r.verified === false) exitCode = 1;
  }

  if (opts.noWrappers) {
    result.wrappers = { action: 'skipped' };
  } else {
    result.wrappers = installWrappers({ dryRun: opts.dryRun, binDir, nodeExe, claudeLaunch });
    for (const w of result.wrappers.written) log(`  wrapper: ${w.status} ${w.path}`);
    for (const s of result.wrappers.skipped) {
      log(`  wrapper: SKIPPED ${s.name} — ${s.reason}`);
      log(`           remediation: remove or rename the existing file, then re-run, or choose another --bin-dir`);
    }
    // A skipped (unmanaged) wrapper means the requested installation did NOT
    // complete: report partial, never a clean success. Explicit bin dir not
    // on PATH is also only a partial success.
    if (result.wrappers.skipped.length > 0) {
      result.wrappers.action = 'partial';
      exitCode = 1;
    } else {
      result.wrappers.action = opts.dryRun ? 'planned' : 'installed';
    }
  }
  if (bin && !bin.onPath && exitCode === 0) {
    log(`  WARNING: ${binDir} is not on PATH — telegram-claude-bridge / claude-telegram will not resolve globally.`);
    exitCode = 1;
  }

  log('');
  if (secret.present) {
    log('Next steps:');
    log('  1. telegram-claude-bridge      # start the central Bridge (once)');
    log('  2. cd <any project>');
    log('     claude-telegram             # Claude in that project, Channel enabled');
  } else {
    log('Next step: start the Bridge once so it generates state/channel-secret:');
    log('  telegram-claude-bridge');
  }

  if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return exitCode;
}

// Exports are assigned BEFORE the main invocation: installMcp routes its
// subprocess calls through module.exports.runClaude so tests can stub the
// runner, which only works if the exports object exists while main() runs.
module.exports = { parseArgs, readUserMcpEntry, checkPrerequisites, secretStatus, installMcp, installWrappers, runClaude, main };

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`install-global failed: ${err.message}\n`);
    process.exitCode = 1;
  }
}
