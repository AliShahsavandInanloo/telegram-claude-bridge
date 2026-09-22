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
// Claude executable discovery (Windows-shim-aware; shell:false stays intact)
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

function dirEntries(dir, fsImpl) {
  try {
    return fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Read a .cmd/.bat shim and find the native executable it invokes. */
function resolveShimFile(shimPath, fsImpl) {
  try {
    const st = fsImpl.statSync(shimPath);
    if (!st.isFile()) return null;
    const script = fsImpl.readFileSync(shimPath, 'utf8');
    // npm/yarn shim: node "%~dp0\node_modules\@anthropic-ai\claude-code\cli.js" %*
    // Native installers: invoke a real .exe next to the shim.
    const m = script.match(/(?:^|[^%\\])\\?"?(?:%~dp0[\\\s]*)?([^"\n]*?\.(?:exe|node))\b/i);
    if (m) {
      const ref = m[1].replace(/%~dp0/g, path.dirname(shimPath)).trim().replace(/^"|"$/g, '');
      const resolved = path.isAbsolute(ref) ? ref : path.resolve(path.dirname(shimPath), ref);
      try {
        if (fsImpl.statSync(resolved).isFile()) return resolved;
      } catch {
        /* fall through */
      }
    }
    const near = path.join(path.dirname(shimPath), path.basename(shimPath, path.extname(shimPath)) + '.exe');
    try {
      if (fsImpl.statSync(near).isFile()) return near;
    } catch {
      /* fall through */
    }
  } catch {
    /* unreadable shim */
  }
  return null;
}

/** Hunt for a native claude binary inside likely npm roots. Never throws. */
function findNativeClaude(fsImpl) {
  const roots = [];
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'pnpm'));
  if (process.env.NPM_CONFIG_PREFIX) roots.push(path.join(process.env.NPM_CONFIG_PREFIX, 'node_modules'));
  for (const root of roots) {
    for (const pkg of ['@anthropic-ai', 'claude-code']) {
      const base = path.join(root, pkg);
      for (const entry of dirEntries(base, fsImpl)) {
        const inner = entry.isDirectory() || entry.isFile() ? path.join(base, entry.name) : null;
        if (!inner) continue;
        const pkgDir = entry.isDirectory() && entry.name !== 'claude-code' && pkg === '@anthropic-ai'
          ? path.join(inner, 'claude-code')
          : inner;
        for (const exeName of ['claude.exe', 'node_modules/@anthropic-ai/claude-code/vendor/claude.exe']) {
          const cand = path.join(pkgDir, exeName);
          try {
            if (fsImpl.statSync(cand).isFile()) return cand;
          } catch {
            /* keep looking */
          }
        }
      }
    }
  }
  return null;
}

/**
 * Locate the native claude executable in PATH (first match wins).
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
 * Validate that a claude executable is usable with `spawn(..., { shell: false })`.
 *
 * Windows npm installs a `claude.cmd` shim; Node cannot exec that safely (and
 * never with shell:false). We resolve the underlying native executable from
 * the shim's own script, or a sibling claude.exe, or a PATH search — and fail
 * loudly otherwise. shell:true is NOT an acceptable fallback.
 */
function resolveClaudeBin(bin, fsImpl = fs, platform = process.platform) {
  const p = String(bin || '').trim();
  if (!p) {
    const found = findExecutableInPath('claude', platform, process.env, fsImpl);
    if (found) return { ok: true, resolved: found, isDefault: true, error: null };
    // Nothing directly executable on PATH: still allow the bare name (some
    // environments provide a native launcher; spawn will surface a clear
    // error if it does not exist), unless a shim-only PATH proves otherwise.
    const shim = path.join('', 'claude');
    if (platform === 'win32' && findExecutableInPath('claude', 'linux', process.env, fsImpl) === null) {
      // Windows with no native claude anywhere: check whether only a shim exists.
      const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
      for (const dir of dirs) {
        try {
          fsImpl.accessSync(path.join(dir, 'claude.cmd'), fsImpl.constants.X_OK);
          const native = findNativeClaude(fsImpl);
          if (native) return { ok: true, resolved: native, isDefault: true, error: null };
          return {
            ok: false, resolved: null,
            error: 'claude on PATH is a Windows .cmd shim that cannot be safely executed with shell:false. Configure CLAUDE_BIN to the native Claude executable instead.',
          };
        } catch {
          /* next dir */
        }
      }
    }
    return { ok: true, resolved: shim.slice(0, 6) || 'claude', isDefault: true, error: null };
  }

  // Explicit configuration.
  if (path.isAbsolute(p) || p.includes('/') || p.includes('\\')) {
    const resolved = path.resolve(p);
    let st;
    try {
      st = fsImpl.statSync(resolved);
    } catch {
      return { ok: false, resolved: null, error: `CLAUDE_BIN "${p}" not found` };
    }
    if (st.isDirectory()) {
      return { ok: false, resolved: null, error: `CLAUDE_BIN "${p}" is a directory, not an executable file` };
    }
    if (isShimPath(resolved, platform)) {
      const native = resolveShimFile(resolved, fsImpl);
      if (native) {
        return { ok: true, resolved: native, error: null };
      }
      return {
        ok: false, resolved: null,
        error: `CLAUDE_BIN resolved to a Windows .cmd shim that cannot be safely executed with shell:false. Configure CLAUDE_BIN to the native Claude executable instead.`,
      };
    }
    try {
      fsImpl.accessSync(resolved, fsImpl.constants.X_OK);
      return { ok: true, resolved, error: null };
    } catch {
      return { ok: false, resolved: null, error: `CLAUDE_BIN "${p}" not found or not executable` };
    }
  }

  // Bare executable name: honor PATH lookup semantics, skipping shims.
  const found = findExecutableInPath(p, platform, process.env, fsImpl);
  if (found) return { ok: true, resolved: found, isDefault: false, error: null };
  const shimless = SHIM_EXTS.every((ext) => {
    try {
      const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
      for (const dir of dirs) fsImpl.accessSync(path.join(dir, `${p}${ext}`), fsImpl.constants.X_OK);
      return false;
    } catch {
      return true;
    }
  });
  if (!shimless && platform === 'win32') {
    const native = findNativeClaude(fsImpl);
    if (native) return { ok: true, resolved: native, isDefault: false, error: null };
    return {
      ok: false, resolved: null,
      error: `CLAUDE_BIN "${p}" resolves only to a Windows .cmd shim that cannot be safely executed with shell:false. Configure CLAUDE_BIN to the native Claude executable instead.`,
    };
  }
  return { ok: true, resolved: p, isDefault: false, error: null }; // unix: spawn resolves via PATH
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
  isShimPath,
  resolveShimFile,
  findNativeClaude,
  findExecutableInPath,
  safeClaudeLabel,
  applyEnvFile,
  SHIM_EXTS,
};
