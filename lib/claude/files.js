'use strict';

/**
 * Centralized, symlink-safe project file resolution.
 *
 * ONE helper for every file path that crosses the Bridge boundary:
 * /download, the channel send_file tool, Telegram uploads, future tools.
 *
 * Security rule: realpath(requested) MUST be inside realpath(projectRoot).
 * This defeats:
 *   - ../ traversal                (normalized before realpath)
 *   - symlink escape               link inside project -> file outside
 *   - Windows junction escape      same mechanism as symlinks
 *   - absolute / UNC outside-root  rejected unless they realpath into root
 *   - basename-only smuggling      full resolution, no path.assembly tricks
 *
 * Windows handled correctly: case-insensitive prefix comparison and
 * backslash/forward-slash normalization (Node's realpath already returns the
 * canonical casing from the filesystem).
 *
 * Nested project-relative paths ARE supported (e.g. reports/result.md) when
 * every component of the REAL resolved path stays inside the real root —
 * a nested path that resolves outside is rejected with a clear error, never
 * silently rewritten.
 */

const fs = require('fs');
const path = require('path');

/** Windows path comparison ignores case and slash direction. */
function sameWindowsPath(a, b, platform) {
  if (platform === 'win32') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/** Is `child` equal to or strictly inside `root`? (both already canonical) */
function isInside(child, root, platform) {
  if (sameWindowsPath(child, root, platform)) return true;
  const sep = platform === 'win32' ? '\\' : path.sep;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return sameWindowsPath(child.slice(0, prefix.length), prefix, platform);
}

/**
 * Resolve a project file request safely.
 *
 * @param {string} projectRoot  absolute project directory (from the registry)
 * @param {string} requested    user/channel-supplied path (relative or absolute)
 * @param {object} opts         { fsImpl, platform, allowNested (default true), mustBeFile (default true) }
 * @returns {ok, path|error, relativePath}
 */
function resolveProjectFile(projectRoot, requested, opts = {}) {
  const {
    fsImpl = fs,
    platform = process.platform,
    allowNested = true,
    mustBeFile = true,
  } = opts;

  const fail = (error) => ({ ok: false, path: null, relativePath: null, error });
  const root = String(projectRoot || '');
  const req = String(requested == null ? '' : requested).trim();

  if (!root) return fail('project root is not set');
  if (!req) return fail('file path is required');

  // 1. Lexical normalization first (no filesystem): reject obvious traversal
  //    and absolute paths outright, before any symlink resolution.
  if (req.includes('\0')) return fail('invalid file path');
  const isAbsoluteReq = path.isAbsolute(req) || /^[A-Za-z]:[\\/]/.test(req) || /^\\\\/.test(req);
  if (isAbsoluteReq) {
    return fail('absolute paths are not allowed — use a path relative to the project root');
  }
  const parts = req.split(/[\\/]+/).filter((p) => p && p !== '.');
  if (parts.length === 0) return fail('invalid file path');
  if (parts.some((p) => p === '..')) {
    return fail('path traversal (..) is not allowed');
  }
  if (parts.some((p) => /^[A-Za-z]:$/.test(p) || p === '')) {
    return fail('invalid file path');
  }
  if (!allowNested && parts.length > 1) {
    return fail('nested paths are not supported here — use a file in the project root (see /files)');
  }
  // Windows reserved/UNC smuggles: a segment like "C:" or a leading \\ is
  // already excluded by the absolute check above; drive-colon segments too.
  if (parts.some((p) => p.includes(':'))) {
    return fail('invalid file path');
  }

  // 2. Canonicalize the root and the candidate.
  let realRoot;
  try {
    realRoot = fsImpl.realpathSync.native(root);
  } catch (err) {
    return fail(`project root is not accessible: ${err.message}`);
  }

  const joined = path.join(root, ...parts);
  let realFile;
  try {
    // realpath resolves symlinks/junctions fully — this is the security anchor.
    realFile = fsImpl.realpathSync.native(joined);
  } catch (err) {
    if (err && err.code === 'ENOENT') return fail(`file "${req}" not found (see /files)`);
    if (err && (err.code === 'ELOOP' || err.code === 'EMFILE')) {
      return fail(`file "${req}" could not be resolved (symlink loop?)`);
    }
    return fail(`file "${req}" could not be accessed: ${err.message}`);
  }

  // 3. The REAL path must be inside the REAL root (Windows casing aware).
  if (!isInside(realFile, realRoot, platform)) {
    return fail(`"${req}" resolves outside the project — refused`);
  }

  // 4. Type check: files only (directories are not sendable).
  let st;
  try {
    st = fsImpl.statSync(realFile);
  } catch (err) {
    return fail(`file "${req}" could not be read: ${err.message}`);
  }
  if (mustBeFile && !st.isFile()) {
    return fail(`"${req}" is not a file`);
  }

  // Relative path for display, computed from the REAL location.
  const rel = path.relative(realRoot, realFile);
  return { ok: true, path: realFile, relativePath: rel.split(path.sep).join('/'), error: null };
}

module.exports = { resolveProjectFile, isInside, sameWindowsPath };
