#!/usr/bin/env node
'use strict';

/**
 * `npm run uninstall-global` — remove ONLY what install-global created.
 *
 *   - removes the USER-scope MCP server `telegram-bridge`, but only when the
 *     registration is the one this installer made (an unrelated server of the
 *     same name is reported and left alone; --force overrides)
 *   - deletes the wrapper commands, but only files carrying this installer's
 *     marker (a hand-written file of the same name is never deleted)
 *
 * It never touches project .mcp.json files, other MCP servers, or the Bridge's
 * own state (.env, state/channel-secret, node_modules).
 *
 * Flags: --dry-run, --bin-dir <dir>, --force, --json, --help
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LAUNCHER = path.join(ROOT, 'scripts', 'launch-channel.js');

const {
  MCP_SERVER_NAME,
  WRAPPER_NAMES,
  defaultBinDir,
  isManaged,
  buildMcpRemoveArgs,
  isOwnRegistration,
} = require('./global-install-lib.js');
const installer = require('./install-global.js');
const { readUserMcpEntry } = installer;
// Routed through the module object so tests can stub the claude CLI runner.
const runClaude = (...a) => installer.runClaude(...a);

const HELP = `uninstall-global — remove this project's global integrations

Usage: node scripts/uninstall-global.js [options]

  --dry-run        show what would change, touch nothing
  --bin-dir <dir>  directory holding the wrapper commands (default ~/.local/bin)
  --force          remove the user-scope MCP server even if it does not look like ours
                   (MCP ONLY — wrapper files are still deleted only when they
                   carry this installer's ownership marker)
  --json           print a machine-readable summary
  --help
`;

/**
 * uninstall-global's OWN argument parser (the installer's parser does not
 * know --force and must not silently accept installer-only flags).
 * Supported: --dry-run, --bin-dir <dir>, --force, --json, --help.
 */
function parseUninstallArgs(argv) {
  const opts = { dryRun: false, binDir: null, force: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
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

function main(argv = process.argv.slice(2)) {
  const opts = parseUninstallArgs(argv);
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const log = opts.json ? () => {} : (m) => process.stdout.write(`${m}\n`);
  const binDir = opts.binDir ? path.resolve(opts.binDir) : defaultBinDir();
  const result = { dryRun: opts.dryRun, binDir, mcp: null, wrappers: [] };

  log(`telegram-bridge — global uninstall${opts.dryRun ? ' (dry run)' : ''}`);

  // ---- MCP registration ----------------------------------------------------
  const entry = readUserMcpEntry(MCP_SERVER_NAME);
  if (!entry.present) {
    result.mcp = { action: 'absent' };
    log(`  MCP: no user-scope server "${MCP_SERVER_NAME}"`);
  } else if (!opts.force && !isOwnRegistration(entry.entry, { launcherPath: LAUNCHER, fsImpl: fs })) {
    result.mcp = { action: 'skipped', reason: 'registration does not look like this installer\'s (use --force to remove anyway)' };
    log(`  MCP: SKIPPED "${MCP_SERVER_NAME}" — ${result.mcp.reason}`);
  } else {
    if (!opts.dryRun) {
      const res = runClaude(buildMcpRemoveArgs());
      // A failed removal MUST fail the uninstall (non-zero): automation and
      // AI agents must never believe a server was removed when it was not.
      result.mcp = res.ok ? { action: 'removed' } : { action: 'failed', error: res.stderr || res.stdout || 'claude mcp remove failed' };
    } else {
      result.mcp = { action: 'remove', dryRun: true };
    }
    log(`  MCP: ${result.mcp.action} user-scope server "${MCP_SERVER_NAME}"`);
  }

  // ---- Wrapper commands ----------------------------------------------------
  for (const name of WRAPPER_NAMES) {
    const target = path.join(binDir, name);
    let content = null;
    try {
      content = fs.readFileSync(target, 'utf8');
    } catch {
      result.wrappers.push({ name, action: 'absent' });
      continue;
    }
    if (!isManaged(content)) {
      result.wrappers.push({ name, action: 'skipped', reason: 'not created by this installer' });
      log(`  wrapper: SKIPPED ${name} — not created by this installer`);
      continue;
    }
    if (!opts.dryRun) fs.unlinkSync(target);
    result.wrappers.push({ name, action: opts.dryRun ? 'would-remove' : 'removed', path: target });
    log(`  wrapper: ${opts.dryRun ? 'would remove' : 'removed'} ${target}`);
  }

  log('');
  log('Bridge data (state/, .env, node_modules) was left untouched.');
  // Exit status must reflect reality: a failed MCP removal (or any failure)
  // makes the uninstall non-zero even though this function still completes.
  const failed = result.mcp && result.mcp.action === 'failed';
  if (failed) {
    process.stderr.write(`error: MCP removal failed: ${result.mcp.error}\n`);
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return failed ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`uninstall-global failed: ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, parseUninstallArgs };
