'use strict';

/**
 * Environment/config validation for the bridge.
 * Pure logic; fs is injectable for tests.
 */

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

/** Validate that a claude executable looks usable. Returns { ok, resolved, error }. */
function resolveClaudeBin(bin, fsImpl = fs, platform = process.platform) {
  const p = String(bin || '').trim();
  if (!p) return { ok: true, resolved: 'claude', error: null };
  const ext = platform === 'win32' ? '.exe' : '';
  if (path.isAbsolute(p)) {
    const candidates = ext && !p.toLowerCase().endsWith(ext) ? [p, p + ext] : [p];
    for (const c of candidates) {
      try {
        fsImpl.accessSync(c, fsImpl.constants.X_OK);
        return { ok: true, resolved: c, error: null };
      } catch {
        /* try next */
      }
    }
    return { ok: false, resolved: null, error: `CLAUDE_BIN "${p}" not found or not executable` };
  }
  // Relative path: reject anything with separators unless file exists relative to cwd.
  if (p.includes('/') || p.includes('\\')) {
    try {
      fsImpl.accessSync(path.resolve(p), fsImpl.constants.X_OK);
      return { ok: true, resolved: path.resolve(p), error: null };
    } catch {
      return { ok: false, resolved: null, error: `CLAUDE_BIN "${p}" not found (relative to bridge dir)` };
    }
  }
  return { ok: true, resolved: p, error: null }; // bare name -> resolved via PATH at spawn time
}

const fs = require('fs');
const path = require('path');

module.exports = {
  validateSessionName,
  parseAllowlist,
  intEnv,
  validateProxyUrl,
  validateBotToken,
  ensureWritableDir,
  resolveClaudeBin,
};
