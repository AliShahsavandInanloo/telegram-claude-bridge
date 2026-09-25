'use strict';

/**
 * Telegram update-offset persistence.
 *
 * Durability semantics (deliberate choice): the offset is committed BEFORE the
 * update is handled, giving AT-MOST-ONCE processing. A crash between commit and
 * handling loses that update; a crash after handling never re-executes it. For
 * a bridge that runs Claude with broad machine permissions, never re-executing
 * an old command is the safer trade. Callers must document this; do not change
 * the ordering without revisiting the semantics.
 *
 * load() distinguishes FOUR states (they are NOT interchangeable):
 *   - { state: 'missing' }    no offset has ever been persisted (first-ever
 *                             start) — callers may run first-start backlog
 *                             initialization.
 *   - { state: 'valid', offset } — resume normally from `offset`.
 *   - { state: 'corrupt', error } — the file exists but is not a valid offset.
 *                             NOT the same as first start: treating corruption
 *                             as "never persisted" would purge the Telegram
 *                             backlog and discard pending commands. A backup
 *                             of the corrupt file is written next to it.
 *   - { state: 'unreadable', error } — the file exists but cannot be read
 *                             (permissions, I/O error). Also never treated as
 *                             first start.
 *
 * commit(offset) writes atomically (tmp file + fsync + rename), cleaning up the
 * tmp file on failure, and returns true only when the offset is durably on disk.
 */

const fs = require('fs');

function createOffsetStore(file, fsImpl = fs) {
  function load() {
    let raw;
    try {
      raw = fsImpl.readFileSync(file, 'utf8');
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        return { state: 'missing', offset: null, error: null };
      }
      return { state: 'unreadable', offset: null, error: err };
    }
    const trimmed = String(raw).trim();
    // An empty file is treated as "never persisted" (rename() is atomic, so an
    // empty file can only come from something outside this store).
    if (!trimmed) return { state: 'missing', offset: null, error: null };
    if (!/^\d+$/.test(trimmed)) {
      // Corrupt: back the file up (best effort) so a human can inspect it
      // instead of silently purging the Telegram backlog.
      try {
        fsImpl.copyFileSync(file, `${file}.corrupt-${Date.now()}.bak`);
      } catch {
        /* backup is best effort; the error is still reported */
      }
      return {
        state: 'corrupt',
        offset: null,
        error: new Error(`offset file content is not a non-negative integer: "${trimmed.slice(0, 40)}"`),
      };
    }
    const v = Number(trimmed);
    if (!Number.isSafeInteger(v) || v < 0) {
      return { state: 'corrupt', offset: null, error: new Error('offset value out of range') };
    }
    return { state: 'valid', offset: v, error: null };
  }

  /**
   * Atomically persist `offset` (tmp + fsync + rename; tmp is removed on
   * failure). Returns true ONLY on durable success — callers MUST treat false
   * as "offset not persisted" and refuse to execute the update.
   */
  function commit(offset) {
    const tmp = `${file}.tmp`;
    let fd = null;
    try {
      fd = fsImpl.openSync(tmp, 'w');
      fsImpl.writeSync(fd, String(offset));
      fsImpl.fsyncSync(fd);
      fsImpl.closeSync(fd);
      fd = null;
      fsImpl.renameSync(tmp, file);
      return true;
    } catch {
      if (fd !== null) {
        try {
          fsImpl.closeSync(fd);
        } catch {
          /* already closed */
        }
      }
      try {
        fsImpl.unlinkSync(tmp);
      } catch {
        /* nothing to clean up */
      }
      return false;
    }
  }

  return { load, commit };
}

module.exports = { createOffsetStore };
