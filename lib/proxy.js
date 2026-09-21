'use strict';

/**
 * Proxy resolution for Telegram traffic. No hard-coded infrastructure:
 *   1. TELEGRAM_PROXY_URL (explicit)
 *   2. HTTPS_PROXY / ALL_PROXY / HTTP_PROXY environment variables
 *   3. Windows system proxy (read live from the registry)
 *   4. direct
 *
 * The URL is re-resolved whenever the caller signals a connection failure, so
 * VPNs can be toggled freely. Loopback proxies are valid (v2rayN etc. listen
 * locally). Credentials never appear in labels or logs.
 */

const { execSync } = require('child_process');

const WIN_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function safeProxyLabel(proxyUrl) {
  if (!proxyUrl) return 'direct';
  let u;
  try {
    u = new URL(proxyUrl);
  } catch {
    return '<invalid proxy url>';
  }
  const auth = u.username || u.password ? '***:***@' : '';
  return `${u.protocol}//${auth}${u.hostname}${u.port ? ':' + u.port : ''}`;
}

/**
 * Parse a Windows ProxyServer string. Handles:
 *   host:port
 *   http=host:port;https=host:port;ftp=...
 *   http://host:port
 * Prefers the https= entry (Telegram API is HTTPS) with http= as fallback.
 * Returns a URL string or null.
 */
function parseWindowsProxyServer(server) {
  if (!server || typeof server !== 'string') return null;
  const s = server.trim();
  if (!s) return null;
  if (s.includes(';')) {
    const map = new Map();
    for (const part of s.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const scheme = part.slice(0, idx).trim().toLowerCase();
      const host = part.slice(idx + 1).trim();
      if (scheme && host) map.set(scheme, host);
    }
    const preferred = map.get('https') || map.get('http') || map.get('socks');
    if (!preferred) return null;
    return normalizeProxyUrl(preferred);
  }
  return normalizeProxyUrl(s);
}

function normalizeProxyUrl(hostPart) {
  // Windows registry values are plain "host:port" (or scheme://host:port).
  // Validate the host shape ourselves; WHATWG URL is too permissive here
  // (it happily parses "http://=junk"). IPv6 literals like [::1] allowed.
  const m = String(hostPart).match(/^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:]+\])(?::\d{1,5})?$/);
  if (!m) {
    const withScheme2 = /^[a-z][a-z0-9+.-]*:\/\//i.test(hostPart) ? hostPart : `http://${hostPart}`;
    try {
      const u2 = new URL(withScheme2);
      if (!u2.hostname || !/^[A-Za-z0-9.\-:\[\]]+$/.test(u2.hostname)) return null;
      if (u2.protocol === 'https:') u2.protocol = 'http:';
      return u2.toString();
    } catch {
      return null;
    }
  }
  try {
    const withScheme = `http://${hostPart}`;
    const u = new URL(withScheme);
    if (!u.hostname) return null;
    return u.toString(); // registry entries are plain proxy ports; CONNECT still upgrades to HTTPS end-to-end
  } catch {
    return null;
  }
}

/**
 * Read the Windows system proxy via `reg query`. Injectable exec for tests.
 * Returns a URL string or null. Malformed data never throws.
 */
function readWindowsSystemProxy(execImpl = execSync, platform = process.platform) {
  if (platform !== 'win32') return null;
  let out = '';
  try {
    out = String(
      execImpl(`reg query "${WIN_REG_KEY}" /v ProxyEnable & reg query "${WIN_REG_KEY}" /v ProxyServer`, {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      })
    );
  } catch {
    return null;
  }
  try {
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/.test(out);
    const serverMatch = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    if (!enabled || !serverMatch) return null;
    return parseWindowsProxyServer(serverMatch[1]);
  } catch {
    return null;
  }
}

/** Pick the first proxy URL from standard environment variables. */
function envProxyUrl(env = process.env) {
  const raw =
    env.HTTPS_PROXY || env.https_proxy ||
    env.ALL_PROXY || env.all_proxy ||
    env.HTTP_PROXY || env.http_proxy;
  if (!raw || !String(raw).trim()) return null;
  try {
    const u = new URL(String(raw).trim());
    if (!u.hostname) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Resolve the full precedence chain. Injectable for tests.
 * Returns { url: string|null, source: 'explicit'|'environment'|'system'|null }.
 */
function resolveProxy({ explicit, env = process.env, execImpl, platform = process.platform } = {}) {
  if (explicit) return { url: explicit, source: 'explicit' };
  const fromEnv = envProxyUrl(env);
  if (fromEnv) return { url: fromEnv, source: 'environment' };
  const fromSys = readWindowsSystemProxy(execImpl, platform);
  if (fromSys) return { url: fromSys, source: 'system' };
  return { url: null, source: null };
}

module.exports = {
  safeProxyLabel,
  parseWindowsProxyServer,
  readWindowsSystemProxy,
  envProxyUrl,
  resolveProxy,
  WIN_REG_KEY,
};
