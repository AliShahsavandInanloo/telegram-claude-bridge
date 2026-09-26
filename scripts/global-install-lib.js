#!/usr/bin/env node
'use strict';

/**
 * Shared, side-effect-free logic for the global (user-scope) installation of
 * the telegram-bridge Claude Code Channel.
 *
 * Everything here is pure or dependency-injected (fs / env / paths), so the
 * installer's decisions can be unit-tested without touching the real machine,
 * the real ~/.claude.json, or the real PATH directories.
 *
 * What "global installation" means (three independent pieces):
 *
 *   1. MCP registration — one user-scope MCP server named `telegram-bridge`
 *      whose command is `node <root>/scripts/launch-channel.js`. Because it
 *      lives at USER scope (a top-level `mcpServers` entry in ~/.claude.json),
 *      every project sees it and no project needs its own .mcp.json. The
 *      command line carries only PATHS — never the channel secret.
 *
 *   2. Launcher wrappers — small .cmd files in a directory already on the
 *      user's PATH (`~/.local/bin` by default):
 *        claude-telegram         -> launch Claude in the CURRENT dir, channel on
 *        telegram-claude-bridge  -> start the central Bridge
 *      They are marked so uninstall can remove exactly what it created and
 *      never a hand-written file that happens to share a name.
 *
 *   3. The secret itself is NOT part of this installation. The launcher reads
 *      it from state/channel-secret at runtime.
 */

const os = require('os');
const path = require('path');

/** Comment stamped into every generated file, so removal is never a guess. */
const MARKER = 'telegram-claude-bridge:managed';

const MCP_SERVER_NAME = 'telegram-bridge';
const CLAUDE_TELEGRAM_CMD = 'claude-telegram.cmd';
const BRIDGE_CMD = 'telegram-claude-bridge.cmd';

/** The two files this installer owns (and is therefore allowed to delete). */
const WRAPPER_NAMES = [CLAUDE_TELEGRAM_CMD, BRIDGE_CMD];

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Platform-aware path equality for ownership decisions.
 *
 *   - normalizes to absolute paths and forward/back slash direction
 *   - Windows (win32): case-INSENSITIVE (NTFS default is case-insensitive)
 *   - everything else: case-SENSITIVE (Unix filesystems are case-sensitive)
 *
 * An empty/relative-only argument never matches (ownership checks must be
 * based on real absolute paths).
 */
function samePath(a, b, platform = process.platform) {
  const sa = String(a || '').trim();
  const sb = String(b || '').trim();
  if (!sa || !sb) return false;
  if (!path.isAbsolute(sa) || !path.isAbsolute(sb)) return false;
  let na;
  let nb;
  try {
    na = path.resolve(sa);
    nb = path.resolve(sb);
  } catch {
    return false;
  }
  if (platform === 'win32') return na.toLowerCase() === nb.toLowerCase();
  return na === nb;
}

/**
 * Directory that receives the wrapper commands. Defaults to `~/.local/bin`;
 * whether that directory is actually on the user's PATH is NOT assumed —
 * resolveBinDir() verifies it and falls back / fails clearly when it is not.
 * Overridable with --bin-dir or BRIDGE_BIN_DIR.
 */
function defaultBinDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const override = String(env.BRIDGE_BIN_DIR || '').trim();
  if (override) return path.resolve(override);
  return path.join(home, '.local', 'bin');
}

/**
 * True when `dir` resolves to a directory listed in the user's PATH.
 * Windows comparison is case-insensitive (NTFS); other platforms case-sensitive.
 */
function isDirectoryOnPath(dir, { env = process.env, platform = process.platform } = {}) {
  const d = String(dir || '').trim();
  if (!d) return false;
  let resolved;
  try {
    resolved = path.resolve(d);
  } catch {
    return false;
  }
  const cmp = (p) => (platform === 'win32' ? String(p).toLowerCase() : String(p));
  const target = cmp(resolved);
  // Split on the TARGET platform's delimiter (not the host's) so the helper
  // behaves correctly in cross-platform tests and when inspecting a PATH
  // captured on another OS.
  const delim = platform === 'win32' ? ';' : ':';
  const entries = String(env.PATH || env.Path || '').split(delim).filter(Boolean);
  return entries.some((e) => {
    try {
      return cmp(path.resolve(e)) === target;
    } catch {
      return false;
    }
  });
}

/**
 * Decide WHERE the wrapper commands go and whether that directory is on PATH.
 *
 *   - explicit (--bin-dir / BRIDGE_BIN_DIR): always used; onPath is reported
 *     so the caller can warn that commands will not resolve globally.
 *   - default: `~/.local/bin` when it IS on PATH; otherwise the npm global
 *     bin directory (`%APPDATA%\npm`) when that is on PATH; otherwise the
 *     install FAILS with clear remediation — the user's PATH is never
 *     modified automatically and wrappers are never written into a
 *     system/administrator directory just because it happens to be on PATH.
 */
function resolveBinDir({ env = process.env, platform = process.platform, home = os.homedir(), explicit = null } = {}) {
  const override = explicit != null ? String(explicit).trim() : String(env.BRIDGE_BIN_DIR || '').trim();
  if (override) {
    const dir = path.resolve(override);
    return { dir, onPath: isDirectoryOnPath(dir, { env, platform }), explicit: true };
  }
  const primary = path.join(home, '.local', 'bin');
  if (isDirectoryOnPath(primary, { env, platform })) return { dir: primary, onPath: true, explicit: false };
  const npmBin = env.APPDATA ? path.join(env.APPDATA, 'npm') : null;
  if (npmBin && isDirectoryOnPath(npmBin, { env, platform })) {
    return { dir: npmBin, onPath: true, explicit: false, note: `~/.local/bin is not on PATH; using the npm global bin directory ${npmBin}` };
  }
  return {
    dir: null,
    onPath: false,
    explicit: false,
    error: `no suitable bin directory found: ${primary} is not on PATH and no npm global bin directory is either. Re-run with an explicit directory that is already on PATH: npm run install-global -- --bin-dir "<user-writable directory on PATH>"`,
  };
}

/**
 * The installer's KNOWN default wrapper locations, in preference order:
 * ~/.local/bin first, then the npm global bin directory when it can be
 * determined. Used by uninstall to find wrappers no matter which candidate
 * install chose — deliberately independent of the user's CURRENT PATH (which
 * may have changed since installation and must never become a deletion
 * surface). Only ownership-marked files are ever removed from these dirs.
 */
function defaultWrapperDirs({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const dirs = [path.join(home, '.local', 'bin')];
  if (platform === 'win32' && env.APPDATA) dirs.push(path.join(env.APPDATA, 'npm'));
  return dirs;
}

// ---------------------------------------------------------------------------
// Wrapper file generation
// ---------------------------------------------------------------------------

/** Renders a .cmd wrapper with a `@echo off` header and the ownership marker. */
function renderCmd({ lines }) {
  return [
    '@echo off',
    `REM ${MARKER} — generated by \`npm run install-global\`; do not edit by hand.`,
    ...lines,
    '',
  ].join('\r\n');
}

/**
 * Content of both wrappers. `claudeExe` is the absolute path to the Claude Code
 * executable resolved at install time (falls back to the bare name `claude`).
 *
 * Neither file contains a secret: the Claude wrapper names the MCP server, and
 * the Bridge wrapper only starts the Bridge, which loads its own .env.
 */
/**
 * Quote a path for a .cmd wrapper (double quotes; no shell interpolation is
 * ever performed by the installer itself — the wrapper is a static file).
 */
function quoteCmd(p) {
  return `"${String(p)}"`;
}

/**
 * The claude-telegram invocation line from a Claude LAUNCH SPEC
 * { command, prefixArgs } — the same concept lib/config.js resolves for the
 * Bridge. Native exe: "claude.exe" flag %*. npm-style shim: "node.exe"
 * "claude-cli.js" flag %*. Every element is quoted so spaces survive.
 */
function claudeInvocation(launch, channelFlag) {
  const parts = [quoteCmd(launch.command), ...launch.prefixArgs.map(quoteCmd), channelFlag, '%*'];
  return parts.join(' ');
}

function wrapperContents({ root, claudeExe = 'claude', claudeLaunch = null, nodeExe = 'node' }) {
  // Launch spec wins; a bare claudeExe is treated as a native command.
  const launch = claudeLaunch || { command: claudeExe, prefixArgs: [] };
  const claudeTelegram = renderCmd({
    lines: [
      'REM Launch Claude Code in the CURRENT directory with the telegram-bridge Channel.',
      'REM The Channel comes from the user-scope MCP server "telegram-bridge";',
      'REM no project needs its own .mcp.json.',
      claudeInvocation(launch, `--dangerously-load-development-channels server:${MCP_SERVER_NAME}`),
    ],
  });

  const bridge = renderCmd({
    lines: [
      'REM Start the central Telegram Bridge (the only Telegram Bot API consumer).',
      `cd /d "${root}"`,
      // PIN the Node executable resolved at install time: the wrapper must not
      // depend on whichever PATH the invoking shell happens to have.
      `"${nodeExe}" "${path.join(root, 'bridge.js')}" %*`,
    ],
  });

  return { [CLAUDE_TELEGRAM_CMD]: claudeTelegram, [BRIDGE_CMD]: bridge };
}

/** True when a file was written by this installer (and is safe to delete). */
function isManaged(content) {
  return typeof content === 'string' && content.includes(MARKER);
}

// ---------------------------------------------------------------------------
// Claude Code MCP registration
// ---------------------------------------------------------------------------

/**
 * argv for `claude mcp add`. Uses USER scope so the server is visible from
 * every project; a project .mcp.json becomes unnecessary. `nodeExe` should be
 * the ABSOLUTE node executable resolved by checkPrerequisites() — pinning it
 * makes the registration independent of whatever PATH Claude Code inherits
 * (PowerShell vs VS Code vs GUI launches). Paths only — never the secret.
 */
function buildMcpAddArgs({ launcherPath, nodeExe = 'node', serverName = MCP_SERVER_NAME }) {
  return ['mcp', 'add', '-s', 'user', serverName, '--', nodeExe, launcherPath];
}

/** argv for `claude mcp remove`, scoped to user so project config is untouched. */
function buildMcpRemoveArgs({ serverName = MCP_SERVER_NAME } = {}) {
  return ['mcp', 'remove', '-s', 'user', serverName];
}

/** argv for `claude mcp get` (verification). */
function buildMcpGetArgs({ serverName = MCP_SERVER_NAME } = {}) {
  return ['mcp', 'get', serverName];
}

/**
 * A user-scope registration is "ours" ONLY when the command is node and the
 * launcher argument is THIS installation's launcher — compared as an exact
 * normalized path (samePath: absolute, slash-normalized, case-insensitive on
 * Windows only).
 *
 * An arbitrary existing file is NEVER accepted just because its basename is
 * `launch-channel.js`: a foreign registration like
 * `node C:\OtherProject\scripts\launch-channel.js` is NOT ours, and both the
 * installer and uninstaller must refuse to touch it.
 */
function isOwnRegistration(entry, { launcherPath, fsImpl = require('fs') } = {}) {
  if (!entry || typeof entry !== 'object') return false;
  if (String(entry.type || 'stdio') !== 'stdio') return false;
  const command = path.basename(String(entry.command || '')).toLowerCase();
  if (command !== 'node' && command !== 'node.exe') return false;
  const args = Array.isArray(entry.args) ? entry.args : [];
  const launcher = args.find((a) => typeof a === 'string' && a.toLowerCase().endsWith('.js'));
  if (!launcher) return false;
  return samePath(launcher, launcherPath);
}

module.exports = {
  MARKER,
  MCP_SERVER_NAME,
  CLAUDE_TELEGRAM_CMD,
  BRIDGE_CMD,
  WRAPPER_NAMES,
  defaultBinDir,
  defaultWrapperDirs,
  isDirectoryOnPath,
  resolveBinDir,
  renderCmd,
  wrapperContents,
  isManaged,
  buildMcpAddArgs,
  buildMcpRemoveArgs,
  buildMcpGetArgs,
  isOwnRegistration,
  samePath,
  quoteCmd,
  claudeInvocation,
};
