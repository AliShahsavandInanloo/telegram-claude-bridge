'use strict';

/**
 * Environment/config validation for the bridge.
 * Pure logic; fs is injectable for tests.
 */

const fs = require('fs');
const path = require('path');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

// Object.prototype-style names are forbidden even though the store uses Maps,
// so a crafted name can never collide with anything object-shaped.
const RESERVED_NAMES = new Set([
  '__proto__', 'constructor', 'toString', 'toLocaleString', 'valueOf',
  'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
]);

function validateSessionName(name) {
  if (typeof name !== 'string' || !name) return { ok: false, error: 'empty name' };
  if (name.length > 32) return { ok: false, error: 'name too long (max 32)' };
  if (RESERVED_NAMES.has(name)) return { ok: false, error: 'that name is reserved' };
  if (!NAME_RE.test(name)) {
    return { ok: false, error: 'use letters, digits, dot, underscore or dash (must start alphanumeric)' };
  }
  return { ok: true };
}

/**
 * Parse ALLOWED_TELEGRAM_IDS. Returns { ok, ids:Set<string>|null, error }.
 * IDs are kept as strings to avoid any numeric precision concerns.
 */
function parseAllowlist(raw) {
  if (raw === undefined || raw === null) return { ok: false, ids: null, error: 'ALLOWED_TELEGRAM_IDS is not set' };
  if (String(raw).trim() === '') return { ok: false, ids: null, error: 'ALLOWED_TELEGRAM_IDS is empty' };
  const segments = String(raw).split(',').map((s) => s.trim());
  if (segments.some((s) => s.length === 0)) {
    return { ok: false, ids: null, error: 'ALLOWED_TELEGRAM_IDS contains an empty entry (check for stray commas)' };
  }
  const entries = segments;
  if (entries.length === 0) return { ok: false, ids: null, error: 'ALLOWED_TELEGRAM_IDS is empty' };
  const ids = new Set();
  for (const e of entries) {
    if (!/^\d{1,20}$/.test(e)) {
      return { ok: false, ids: null, error: `ALLOWED_TELEGRAM_IDS contains invalid entry "${e.slice(0, 30)}" (expected numeric Telegram user IDs, comma-separated)` };
    }
    ids.add(e);
  }
  return { ok: true, ids, error: null };
}

const NUM_RE = /^\d+$/;

/** Integer env var with bounds; returns { ok, value, error }. */
function intEnv(raw, { name, def, min, max }) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    if (def === undefined) return { ok: false, value: null, error: `${name} is required` };
    return { ok: true, value: def, error: null };
  }
  const s = String(raw).trim();
  if (!NUM_RE.test(s)) return { ok: false, value: null, error: `${name} must be a non-negative integer (got "${s.slice(0, 40)}")` };
  const n = Number(s);
  if (!Number.isSafeInteger(n)) return { ok: false, value: null, error: `${name} is too large` };
  if (min !== undefined && n < min) return { ok: false, value: null, error: `${name} must be >= ${min}` };
  if (max !== undefined && n > max) return { ok: false, value: null, error: `${name} must be <= ${max}` };
  return { ok: true, value: n, error: null };
}

/** Validate the proxy URL syntax. Returns { ok, url, error }. */
function validateProxyUrl(raw) {
  if (!raw) return { ok: true, url: null, error: null };
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return { ok: false, url: null, error: 'TELEGRAM_PROXY_URL is not a valid URL (e.g. socks5://127.0.0.1:10808 or http://127.0.0.1:8080)' };
  }
  const proto = u.protocol.replace(':', '').toLowerCase();
  if (!['http', 'https', 'socks', 'socks4', 'socks4a', 'socks5', 'socks5h'].includes(proto)) {
    return { ok: false, url: null, error: `TELEGRAM_PROXY_URL has unsupported protocol "${proto}" (use http, https or socks5)` };
  }
  if (!u.hostname) return { ok: false, url: null, error: 'TELEGRAM_PROXY_URL is missing a host' };
  return { ok: true, url: u.toString(), error: null };
}

/**
 * Validate bot token shape (does not contact Telegram).
 * Real tokens look like "<digits>:<35-ish alphanumeric chars>".
 */
function validateBotToken(token) {
  if (!token || typeof token !== 'string') return { ok: false, error: 'TELEGRAM_BOT_TOKEN is missing (put it in .env next to bridge.js)' };
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token.trim())) {
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN does not look like a bot token (expected "<digits>:<secret>" from @BotFather)' };
  }
  return { ok: true, error: null };
}

/**
 * Check that a directory exists and is writable.
 */
function ensureWritableDir(dir, fsImpl = fs) {
  try {
    fsImpl.mkdirSync(dir, { recursive: true });
    fsImpl.accessSync(dir, fsImpl.constants.W_OK);
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: `cannot write to ${dir}: ${err.message}` };
  }
}

/**
 * Validate BRIDGE_CWD: must exist AND be a directory (a plain file would pass
 * an existence-only check and then fail as spawn cwd). Returns a resolved path.
 */
function validateBridgeCwd(raw, fsImpl = fs) {
  if (!raw || !String(raw).trim()) return { ok: false, resolved: null, error: 'BRIDGE_CWD is empty' };
  let resolved;
  try {
    resolved = path.resolve(String(raw).trim());
  } catch (err) {
    return { ok: false, resolved: null, error: `BRIDGE_CWD is not a valid path: ${err.message}` };
  }
  let st;
  try {
    st = fsImpl.statSync(resolved);
  } catch {
    return { ok: false, resolved: null, error: `BRIDGE_CWD "${raw}" does not exist.` };
  }
  if (!st.isDirectory()) {
    return { ok: false, resolved: null, error: `BRIDGE_CWD exists but is not a directory: ${raw}` };
  }
  return { ok: true, resolved, error: null };
}

// ---------------------------------------------------------------------------
// Claude launch specification (Windows-shim-aware; shell:false stays intact)
//
// Claude execution is represented as a LAUNCH SPECIFICATION:
//   { command: '<executable>', prefixArgs: ['<args before the bridge args>'] }
//
//   native claude.exe        -> { command: 'C:\\...\\claude.exe', prefixArgs: [] }
//   npm claude.cmd shim      -> { command: node.exe, prefixArgs: [cli.js] }
//   explicit .js entrypoint  -> { command: node.exe, prefixArgs: [cli.js] }
//
// Invocation is always:
//   spawn(launch.command, [...launch.prefixArgs, ...bridgeArgs], { shell: false })
//
// shell:true / cmd.exe / powershell are NEVER used: the Telegram prompt is
// passed as a direct argv element, so no interpolation is possible.
// ---------------------------------------------------------------------------

/** File extensions Windows cannot exec directly with shell:false. */
const SHIM_EXTS = ['.cmd', '.bat', '.com'];

/** True when a path points at a Windows shell shim (.cmd/.bat). */
function isShimPath(p, platform = process.platform) {
  if (!p) return false;
  const lower = String(p).toLowerCase();
  if (platform === 'win32') {
    return SHIM_EXTS.some((ext) => lower.endsWith(ext));
  }
  // Cross-platform detection for tests: an explicit ".cmd"/".bat" suffix is a
  // shim marker anywhere; a bare ".com" would be a unix login script only by
  // convention, so it is only treated as a shim on Windows.
  return lower.endsWith('.cmd') || lower.endsWith('.bat');
}

/**
 * Read a Windows .cmd/.bat shim and, IF it is a launcher structure we know how
 * to model, return a launch spec for what it actually invokes.
 *
 * Supported structures (npm/yarn-style wrappers):
 *   1. node-invoking shim:
 *        node  "%~dp0\node_modules\pkg\cli.js" %*
 *      -> { command: <that node>, prefixArgs: [<resolved cli.js>] }
 *      The node reference must itself resolve to an existing executable file.
 *   2. sibling native exe (installer-style shim):
 *        @myapp.exe %*
 *      -> { command: <sibling-or-referenced .exe>, prefixArgs: [] }
 *
 * Anything else returns null: the caller must FAIL rather than guess — a wrong
 * guess historically produced `node.exe` with the cli.js argument dropped,
 * which launches plain node instead of Claude.
 */
function parseShimLaunch(shimPath, fsImpl) {
  let script;
  try {
    const st = fsImpl.statSync(shimPath);
    if (!st.isFile()) return null;
    script = fsImpl.readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }

  // Active lines only (skip @echo off, rem, labels, blank lines).
  const lines = String(script)
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^@/, ''))
    .filter((l) => l && !/^rem\b/i.test(l) && !l.startsWith(':') && !/^echo\b/i.test(l));
  const body = lines.join(' ');
  if (!body) return null;

  const shimDir = path.dirname(shimPath);

  // Case 1: node + JS entrypoint. Find a `node ...<something>.js` invocation
  // with %* passthrough. First token must be a node reference we can resolve.
  // If the structure LOOKS like a node shim but its JS entrypoint does not
  // verify, we fall through to the sibling-exe check and ultimately return
  // null — we never guess.
  const nodeMatch = body.match(/^(?:"([^"]+)"|(\S+))\s+(.*)$/);
  let looksLikeNodeShim = false;
  if (nodeMatch) {
    const nodeRef = (nodeMatch[1] || nodeMatch[2] || '').replace(/\/%?$/, ''); // strip trailing %* artifact
    const rest = nodeMatch[3] || '';
    const base = path.basename(nodeRef).toLowerCase().replace(/\.exe$/, '');
    const jsInRest = rest.match(/"([^"]*?\.js)"|(\S*?\.js)/i);
    if (/^node/.test(base) && jsInRest) {
      looksLikeNodeShim = true;
      let nodeExe;
      if (base === 'node') {
        nodeExe = process.execPath; // bare `node` -> this Node runtime
      } else {
        // NOTE: %~dp0 expands WITH a trailing backslash, so substitute the
        // shim dir plus a separator ("%~dp0cli.js" -> <dir>/cli.js).
        const ref = nodeRef.replace(/%~dp0/g, shimDir + path.sep).trim().replace(/"/g, '');
        const cand = path.isAbsolute(ref) ? ref : path.resolve(shimDir, ref);
        try {
          if (!fsImpl.statSync(cand).isFile()) return null;
          nodeExe = cand;
        } catch {
          return null;
        }
      }
      const jsRef = (jsInRest[1] || jsInRest[2]).replace(/%~dp0/g, shimDir + path.sep).trim().replace(/"/g, '');
      const jsPath = path.isAbsolute(jsRef) ? jsRef : path.resolve(shimDir, jsRef);
      try {
        if (fsImpl.statSync(jsPath).isFile()) {
          return { command: nodeExe, prefixArgs: [jsPath] };
        }
      } catch {
        /* JS entrypoint missing: fall through — no guessing */
      }
    }

    // Case 2: shim directly invokes a native executable that exists on disk.
    const exeRef = nodeRef;
    if (/\.(exe|com)$/i.test(exeRef) || /\.(exe|com)$/i.test(nodeRef)) {
      const ref = exeRef.replace(/%~dp0/g, shimDir).trim().replace(/"/g, '');
      const cand = path.isAbsolute(ref) ? ref : path.resolve(shimDir, ref);
      try {
        if (fsImpl.statSync(cand).isFile()) return { command: cand, prefixArgs: [] };
      } catch {
        /* fall through to sibling check */
      }
    }
  }

  // Case 2b: installer-style shim whose basename has a sibling .exe. Only
  // honored when the shim does not look like a node+js launcher (a node shim
  // with a missing cli.js must FAIL, not silently launch an unrelated exe).
  if (!looksLikeNodeShim) {
    const near = path.join(shimDir, path.basename(shimPath, path.extname(shimPath)) + '.exe');
    try {
      if (fsImpl.statSync(near).isFile()) return { command: near, prefixArgs: [] };
    } catch {
      /* no sibling exe */
    }
  }
  return null;
}

/**
 * Locate a directly-executable (non-shim) `bin` in PATH (first match wins).
 * Skips .cmd/.bat shims — those are not directly spawnable with shell:false.
 * Returns the absolute path, or null when nothing suitable is found.
 */
function findExecutableInPath(bin, platform = process.platform, env = process.env, fsImpl = fs) {
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const pats = platform === 'win32'
    ? [`${bin}.exe`, bin, `${bin}.com`]
    : [bin];
  for (const dir of dirs) {
    for (const pat of pats) {
      const cand = path.isAbsolute(pat) ? pat : path.join(dir, pat);
      if (isShimPath(cand, platform)) continue; // never resolve to a shell shim
      try {
        fsImpl.accessSync(cand, fsImpl.constants.X_OK);
        return path.resolve(cand);
      } catch {
        /* next candidate */
      }
    }
  }
  return null;
}

/**
 * Resolve CLAUDE_BIN into a LAUNCH SPECIFICATION usable with
 * spawn(command, [...prefixArgs, ...args], { shell: false }).
 *
 * Supported CLAUDE_BIN forms:
 *   - empty / bare name ('claude')  -> resolved via PATH; the resolved file
 *     must EXIST (a bare name that matches nothing fails startup)
 *   - absolute/relative path to a native executable (claude.exe, or any
 *     directly spawnable file)
 *   - path to a Windows .cmd/.bat launcher whose structure we can model
 *     (node + cli.js, or sibling native exe)
 *   - path to an explicit JavaScript CLI entrypoint (cli.js) -> launched via
 *     the current Node runtime: { command: node, prefixArgs: [cli.js] }
 *
 * Every failure mode returns { ok: false, error } — startup must refuse to
 * continue rather than guess. shell:true is never part of any resolution.
 *
 * Injectable: fsImpl (fs), platform, env, and nodeExe (for tests).
 */
function resolveClaudeLaunch(bin, { fsImpl = fs, platform = process.platform, env = process.env, nodeExe = process.execPath } = {}) {
  const fail = (error) => ({ ok: false, command: null, prefixArgs: null, error });
  const p = String(bin == null ? '' : bin).trim();

  // --- bare name or empty: resolve against PATH ---------------------------
  if (!p || !path.isAbsolute(p) && !p.includes('/') && !p.includes('\\')) {
    const name = p || 'claude';
    const found = findExecutableInPath(name, platform, env, fsImpl);
    if (found) return { ok: true, command: found, prefixArgs: [], isDefault: !p, error: null };
    // On Windows a bare name may exist only as a .cmd shim; PATH search above
    // skips shims by design, so try to model the shim we can actually launch.
    if (platform === 'win32') {
      const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
      for (const ext of ['.cmd', '.bat']) {
        for (const dir of dirs) {
          const shim = path.join(dir, name + ext);
          try {
            fsImpl.accessSync(shim, fsImpl.constants.X_OK);
          } catch {
            continue;
          }
          const spec = parseShimLaunch(shim, fsImpl);
          if (spec) {
            return { ok: true, command: spec.command, prefixArgs: spec.prefixArgs, isDefault: !p, error: null };
          }
          return fail(`Unable to safely resolve Claude from the Windows ${ext} launcher at "${shim}". Set CLAUDE_BIN to the native Claude executable or supported CLI entrypoint.`);
        }
      }
    }
    return fail(`CLAUDE_BIN "${name}" was not found on PATH (no executable file matching it exists). refusing to start: install Claude Code or set CLAUDE_BIN to its full path.`);
  }

  // --- explicit path -------------------------------------------------------
  const resolved = path.resolve(p);
  let st;
  try {
    st = fsImpl.statSync(resolved);
  } catch {
    return fail(`CLAUDE_BIN "${p}" not found. refusing to start: point CLAUDE_BIN at an existing executable or CLI entrypoint.`);
  }
  if (st.isDirectory()) {
    return fail(`CLAUDE_BIN "${p}" is a directory, not an executable file.`);
  }

  if (isShimPath(resolved, platform)) {
    const spec = parseShimLaunch(resolved, fsImpl);
    if (!spec) {
      return fail(`Unable to safely resolve Claude from the Windows .cmd launcher "${p}". Set CLAUDE_BIN to the native Claude executable or supported CLI entrypoint.`);
    }
    return { ok: true, command: spec.command, prefixArgs: spec.prefixArgs, isDefault: false, error: null };
  }

  if (/\.js$/i.test(resolved)) {
    // Explicit JS CLI entrypoint: launch via the current Node runtime.
    return { ok: true, command: nodeExe, prefixArgs: [resolved], isDefault: false, error: null };
  }

  try {
    fsImpl.accessSync(resolved, fsImpl.constants.X_OK);
  } catch {
    return fail(`CLAUDE_BIN "${p}" not found or not executable.`);
  }
  return { ok: true, command: resolved, prefixArgs: [], isDefault: false, error: null };
}

/**
 * Backwards-compatible single-path view of resolveClaudeLaunch, used by /status
 * (which must never expose the launch internals). Kept for callers that only
 * need a display string; new code should use resolveClaudeLaunch.
 */
function resolveClaudeBin(bin, fsImpl = fs, platform = process.platform) {
  const r = resolveClaudeLaunch(bin, { fsImpl, platform });
  if (!r.ok) return r;
  // A node+cli.js launch has no single "resolved path"; report the entrypoint.
  return { ok: true, resolved: r.prefixArgs.length ? r.prefixArgs[0] : r.command, isDefault: !!r.isDefault, error: null };
}

/**
 * Public-facing label for /status: never an absolute path (must not reveal
 * usernames, home dirs or install locations over Telegram).
 */
function safeClaudeLabel(resolvedPath, platform = process.platform) {
  if (!resolvedPath || resolvedPath === 'claude') return 'claude (on PATH)';
  const base = path.basename(resolvedPath);
  return base || 'claude';
}

// ---------------------------------------------------------------------------
// .env loading (must run BEFORE any config value is derived from process.env)
// ---------------------------------------------------------------------------

/**
 * Parse `<root>/.env` and set variables that are NOT already present in the
 * real environment (so process env always wins). Lines: KEY=VALUE, #/; comments,
 * optional single/double quotes, exported prefix. Blank/corrupt lines skipped.
 * Returns the list of keys actually applied (for logging/tests only).
 */
function applyEnvFile(root, processEnv = process.env, fsImpl = fs) {
  const envPath = path.join(root, '.env');
  let content;
  try {
    if (!fsImpl.existsSync(envPath)) return [];
    content = fsImpl.readFileSync(envPath, 'utf8');
  } catch {
    return [];
  }
  const applied = [];
  for (const line of String(content).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const m = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2] !== undefined ? m[2] : '';
    value = value.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in processEnv)) {
      processEnv[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

module.exports = {
  validateSessionName,
  parseAllowlist,
  intEnv,
  validateProxyUrl,
  validateBotToken,
  ensureWritableDir,
  validateBridgeCwd,
  resolveClaudeBin,
  resolveClaudeLaunch,
  parseShimLaunch,
  isShimPath,
  findExecutableInPath,
  safeClaudeLabel,
  applyEnvFile,
  SHIM_EXTS,
};
