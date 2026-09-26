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
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LAUNCHER = path.join(ROOT, 'scripts', 'launch-channel.js');
const BRIDGE_ENTRY = path.join(ROOT, 'bridge.js');

const { findExecutableInPath } = require(path.join(ROOT, 'lib', 'config.js'));
const {
  MCP_SERVER_NAME,
  WRAPPER_NAMES,
  defaultBinDir,
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
    else if (a === '--bin-dir') { opts.binDir = argv[i + 1]; i += 1; }
    else if (a.startsWith('--bin-dir=')) opts.binDir = a.slice('--bin-dir='.length);
    else if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
  }
  return opts;
}

const HELP = `install-global — install the telegram-bridge Channel for this user

Usage: node scripts/install-global.js [options]

  --dry-run        show what would change, touch nothing
  --bin-dir <dir>  directory for the wrapper commands (default ~/.local/bin)
  --no-mcp         skip the user-scope MCP registration
  --no-wrappers    skip installing the wrapper commands
  --json           print a machine-readable summary
  --help
`;

function runClaude(args) {
  const claudeExe = findExecutableInPath('claude', process.platform, process.env, fs) || 'claude';
  try {
    const stdout = execFileSync(claudeExe, args, { encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
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

function checkPrerequisites() {
  const problems = [];
  for (const [label, p] of [['launcher', LAUNCHER], ['bridge entry', BRIDGE_ENTRY], ['package.json', path.join(ROOT, 'package.json')]]) {
    if (!fs.existsSync(p)) problems.push(`${label} missing: ${p}`);
  }
  if (!findExecutableInPath('claude', process.platform, process.env, fs)) {
    problems.push('`claude` (Claude Code CLI) not found on PATH — install Claude Code first');
  }
  const nodeExe = findExecutableInPath('node', process.platform, process.env, fs);
  if (!nodeExe) problems.push('`node` not found on PATH');
  return { problems, nodeExe };
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

function installMcp({ dryRun, home = os.homedir() }) {
  const before = readUserMcpEntry(MCP_SERVER_NAME, home);
  if (before.present && !isOwnRegistration(before.entry, { launcherPath: LAUNCHER, fsImpl: fs })) {
    return {
      action: 'refused',
      reason: `a user-scope MCP server named "${MCP_SERVER_NAME}" already exists and was not created by this installer — refusing to overwrite it. Remove it manually with: claude mcp remove -s user ${MCP_SERVER_NAME}`,
      existing: { command: before.entry && before.entry.command, args: before.entry && before.entry.args },
    };
  }

  const addArgs = buildMcpAddArgs({ launcherPath: LAUNCHER, nodeExe: 'node' });
  if (dryRun) {
    return { action: before.present ? 'replace' : 'add', args: addArgs, dryRun: true };
  }

  // Remove first so re-running never creates a duplicate entry.
  if (before.present) runClaude(buildMcpRemoveArgs());
  const added = runClaude(addArgs);
  if (!added.ok) return { action: 'failed', error: added.stderr || added.stdout || 'claude mcp add failed' };

  const verified = runClaude(buildMcpGetArgs());
  return {
    action: before.present ? 'replaced' : 'added',
    args: addArgs,
    verified: verified.ok,
    detail: verified.ok ? verified.stdout.trim().split('\n')[0] : 'verification via `claude mcp get` failed',
  };
}

function installWrappers({ dryRun, binDir }) {
  const claudeExe = findExecutableInPath('claude', process.platform, process.env, fs) || 'claude';
  const files = wrapperContents({ root: ROOT, claudeExe });
  const written = [];
  const skipped = [];

  if (!dryRun && !fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

  for (const name of WRAPPER_NAMES) {
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
    if (!dryRun) fs.writeFileSync(target, files[name], 'utf8');
    written.push({ name, path: target, status });
  }

  return { binDir, written, skipped, claudeExe };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const log = opts.json ? () => {} : (m) => process.stdout.write(`${m}\n`);
  const { problems, nodeExe } = checkPrerequisites();
  const secret = secretStatus();

  if (problems.length) {
    for (const p of problems) process.stderr.write(`error: ${p}\n`);
    return 1;
  }

  const binDir = opts.binDir ? path.resolve(opts.binDir) : defaultBinDir();

  log(`telegram-bridge — global install${opts.dryRun ? ' (dry run)' : ''}`);
  log(`  bridge root : ${ROOT}`);
  log(`  launcher    : ${LAUNCHER}`);
  log(`  node        : ${nodeExe}`);
  log(`  bin dir     : ${binDir}`);
  log(`  secret      : ${secret.path} (${secret.present ? `ok, ${secret.length} chars` : 'NOT FOUND'})`);
  log('');

  const result = { root: ROOT, launcher: LAUNCHER, binDir, dryRun: opts.dryRun, secret: { path: secret.path, present: secret.present, length: secret.length } };

  if (opts.noMcp) {
    result.mcp = { action: 'skipped' };
  } else {
    result.mcp = installMcp({ dryRun: opts.dryRun });
    const r = result.mcp;
    if (r.action === 'refused' || r.action === 'failed') {
      log(`  MCP: ${r.action} — ${r.reason || r.error}`);
      if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 1;
    }
    log(`  MCP: ${r.action} user-scope server "${MCP_SERVER_NAME}"${r.dryRun ? '' : r.verified ? ' (verified)' : ' (WARNING: not verified)'}`);
  }

  if (opts.noWrappers) {
    result.wrappers = { action: 'skipped' };
  } else {
    result.wrappers = installWrappers({ dryRun: opts.dryRun, binDir });
    for (const w of result.wrappers.written) log(`  wrapper: ${w.status} ${w.path}`);
    for (const s of result.wrappers.skipped) log(`  wrapper: SKIPPED ${s.name} — ${s.reason}`);
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
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`install-global failed: ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, readUserMcpEntry, checkPrerequisites, secretStatus, installMcp, installWrappers, runClaude };
