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
 * `load()` returns null when no offset has ever been persisted (first-ever
 * start), which callers use to decide whether to purge the Telegram backlog.
 */

const fs = require('fs');

function createOffsetStore(file, fsImpl = fs) {
  function load() {
    try {
      const raw = fsImpl.readFileSync(file, 'utf8').trim();
      if (!raw) return null;
      const v = parseInt(raw, 10);
      return Number.isSafeInteger(v) && v >= 0 ? v : null;
    } catch {
      return null; // missing / unreadable == never persisted
    }
  }

  /** Atomic write (tmp + rename). Returns true on success. */
  function commit(offset) {
    try {
      const tmp = `${file}.tmp`;
      fsImpl.writeFileSync(tmp, String(offset));
      fsImpl.renameSync(tmp, file);
      return true;
    } catch {
      return false;
    }
  }

  return { load, commit };
}

module.exports = { createOffsetStore };
