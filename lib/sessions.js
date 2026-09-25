'use strict';

/**
 * Session store: chatId -> { active: name, list: Map<name, {id, initialized}> }.
 *
 * Persistence schema (v2) keeps METADATA out of the session namespace so
 * sessions named "active" or "list" survive restarts:
 *
 *   {
 *     "version": 2,
 *     "chats": {
 *       "<chatId>": {
 *         "activeSession": "work",
 *         "sessions": {
 *           "work": { "id": "<uuid>", "initialized": true }
 *         }
 *       }
 *     }
 *   }
 *
 * Legacy formats are migrated on load (see migrateChatEntry). Names are
 * validated (no prototype pollution, no path characters). Persistence is
 * crash-safe (serialize -> temp -> fsync -> rename), serialized through a
 * promise chain, and save() REJECTS on write failure so callers can roll
 * back in-memory mutations instead of claiming success falsely.
 */

const fs = require('fs');
const path = require('path');
const { validateSessionName } = require('./config');

const SCHEMA_VERSION = 2;

function newSessionId() {
  return require('crypto').randomUUID();
}

function makeChatState() {
  return { active: 'default', list: new Map() };
}

/**
 * Migrate one loaded chat entry from any known schema into chat state.
 * Returns null if the entry is unusable.
 *
 * v2:     { activeSession, sessions: {name: {id, initialized}} }
 * flat:   { active, list: {name: {id, initialized}}, <name>: ... }  (v1 files)
 * oldest: { active, <name>: "<uuid>" }
 */
function migrateChatEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = makeChatState();

  // --- v2 schema -----------------------------------------------------------
  // Structure-based detection: the `sessions` container is recognized ONLY by
  // its contents (entries of the {id: <uuid>} form). This cannot be fooled by
  // a stray top-level "sessions" key holding junk in an older layout, and it
  // requires no name guessing: metadata keys in legacy files are identified
  // structurally (a session is ALWAYS a uuid string or a {id, initialized}
  // object — anything else is metadata or junk).
  const looksV2 = raw.sessions && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions)
    && Object.values(raw.sessions).some(
      (v) => v && typeof v === 'object' && typeof v.id === 'string' && /^[0-9a-fA-F-]{36}$/.test(v.id),
    );
  if (looksV2) {
    out.active = typeof raw.activeSession === 'string' && validateSessionName(raw.activeSession).ok
      ? raw.activeSession
      : 'default';
    for (const [name, value] of Object.entries(raw.sessions)) {
      if (!validateSessionName(name).ok) continue;
      if (value && typeof value === 'object' && typeof value.id === 'string' && /^[0-9a-fA-F-]{36}$/.test(value.id)) {
        out.list.set(name, { id: value.id, initialized: Boolean(value.initialized) });
      }
    }
    if (!out.list.has(out.active)) {
      const first = out.list.keys().next();
      out.active = first.done ? 'default' : first.value;
    }
    return out.list.size ? out : null;
  }

  // --- legacy flat schema (v1 and oldest) ----------------------------------
  // Structure-based migration: a legacy entry is a SESSION iff its value is a
  // UUID string (oldest schema: name -> uuid) or a {id: <uuid>, initialized}
  // object. Anything else at the top level of a legacy file is metadata
  // ('active', 'activeSession', 'sessions', 'version', ...) or junk. This
  // preserves sessions legitimately named "active", "list", "sessions",
  // "activeSession" or "version" without maintaining a name blacklist.
  const hasListKey = raw.list && typeof raw.list === 'object' && !Array.isArray(raw.list);
  const list = hasListKey ? raw.list : raw;
  if (typeof raw.active === 'string' && validateSessionName(raw.active).ok) {
    out.active = raw.active;
  }
  for (const [name, value] of Object.entries(list)) {
    // 'active' is structurally metadata in legacy files: without a list
    // container it holds the active-session NAME, so a session named "active"
    // is not representable in the oldest schema (key collision).
    if (!hasListKey && name === 'active') continue;
    if (!validateSessionName(name).ok) continue;
    if (typeof value === 'string' && /^[0-9a-fA-F-]{36}$/.test(value)) {
      // oldest schema: name -> uuid
      out.list.set(name, { id: value, initialized: true });
    } else if (value && typeof value === 'object' && typeof value.id === 'string' && /^[0-9a-fA-F-]{36}$/.test(value.id)) {
      out.list.set(name, { id: value.id, initialized: Boolean(value.initialized) });
    }
    // anything else is metadata or junk — structurally not a session
  }
  if (!out.list.has(out.active)) {
    const first = out.list.keys().next();
    out.active = first.done ? 'default' : first.value;
  }
  return out.list.size ? out : null;
}

/**
 * Create the store. fsImpl injectable for tests.
 * Sync methods used at load time; async serialized writes for save().
 */
function createSessionStore(file, fsImpl = fs) {
  const chats = new Map(); // chatId -> state
  let writeChain = Promise.resolve();

  function load() {
    let raw = null;
    try {
      if (fsImpl.existsSync(file)) {
        const content = fsImpl.readFileSync(file, 'utf8');
        if (content.trim()) raw = JSON.parse(content);
      }
    } catch (err) {
      // corrupted: keep a backup next to the file, start fresh
      try {
        fsImpl.copyFileSync(file, `${file}.corrupt-${Date.now()}.bak`);
      } catch {
        /* best effort */
      }
      console.error(`[sessions] ${file} was unreadable (${err.message}); backed up if possible and starting fresh`);
      raw = null;
    }
    if (raw && typeof raw === 'object') {
      const entries = raw.chats && typeof raw.chats === 'object' ? raw.chats : raw;
      for (const [chatId, entry] of Object.entries(entries)) {
        const migrated = migrateChatEntry(entry);
        if (migrated) chats.set(String(chatId), migrated);
      }
    }
  }

  function serialize() {
    const chatsOut = {};
    for (const [chatId, st] of chats) {
      const sessions = {};
      for (const [name, s] of st.list) sessions[name] = { id: s.id, initialized: !!s.initialized };
      chatsOut[chatId] = { activeSession: st.active, sessions };
    }
    return JSON.stringify({ version: SCHEMA_VERSION, chats: chatsOut }, null, 2);
  }

  /**
   * Persist asynchronously. Serialized through a promise chain; REJECTS on
   * failure so callers can roll back mutations / report errors to the user.
   * The temp file is removed on any failure (cleanup errors are logged, never
   * allowed to mask the original write/rename error).
   */
  function save() {
    const run = writeChain.then(async () => {
      const json = serialize();
      const dir = path.dirname(file);
      await fsImpl.promises.mkdir(dir, { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      let fh = null;
      try {
        fh = await fsImpl.promises.open(tmp, 'w');
        await fh.writeFile(json, 'utf8');
        await fh.sync();
        await fh.close();
        fh = null;
        await fsImpl.promises.rename(tmp, file);
      } catch (err) {
        if (fh) {
          try {
            await fh.close();
          } catch {
            /* already closed */
          }
        }
        try {
          await fsImpl.promises.unlink(tmp);
        } catch (cleanupErr) {
          console.error(`[sessions] could not remove temp file ${tmp}: ${cleanupErr.message}`);
        }
        throw err; // original failure, unmasked
      }
    });
    // Keep the chain alive after a rejection, but surface the error to the
    // caller of THIS save via the returned promise.
    writeChain = run.then(() => {}, () => {});
    return run;
  }

  load();

  return {
    /** Get or create the state for a chat. */
    chat(chatId) {
      let st = chats.get(chatId);
      if (!st) {
        st = makeChatState();
        chats.set(chatId, st);
      }
      return st;
    },
    has(chatId) {
      return chats.has(chatId);
    },
    /** Allocate a fresh session under `name`; becomes active. */
    create(chatId, rawName) {
      const name = String(rawName || '').trim() || `s-${Date.now().toString(36)}`;
      const check = validateSessionName(name);
      if (!check.ok) return { ok: false, error: check.error };
      const st = this.chat(chatId);
      const sess = { id: newSessionId(), initialized: false };
      st.list.set(name, sess);
      st.active = name;
      return { ok: true, name, session: sess };
    },
    get(chatId, name) {
      const st = chats.get(chatId);
      return st ? st.list.get(name) || null : null;
    },
    /** Active session entry for a chat (auto-creates 'default' uninitialized). */
    active(chatId) {
      const st = this.chat(chatId);
      let sess = st.list.get(st.active);
      if (!sess) {
        sess = { id: newSessionId(), initialized: false };
        st.list.set(st.active, sess);
      }
      return { name: st.active, session: sess };
    },
    setActive(chatId, name) {
      const st = chats.get(chatId);
      if (!st || !st.list.has(name)) return { ok: false, error: `no session named "${name}"` };
      st.active = name;
      return { ok: true };
    },
    names(chatId) {
      const st = chats.get(chatId);
      return st ? [...st.list.keys()] : [];
    },
    /** Remove a session; if it was active, fall back to the first remaining. */
    remove(chatId, name) {
      const st = chats.get(chatId);
      if (!st || !st.list.has(name)) return { ok: false, error: `no session named "${name}"` };
      st.list.delete(name);
      if (st.active === name) {
        const first = st.list.keys().next();
        st.active = first.done ? 'default' : first.value;
      }
      return { ok: true };
    },
    /**
     * Capture the FULL chat state (active selection + deep copy of every
     * session entry) so a failed persist can be rolled back exactly.
     * Returns null when the chat has no state (restore(null) removes it).
     */
    snapshotChat(chatId) {
      const st = chats.get(chatId);
      if (!st) return null;
      const list = new Map();
      for (const [k, v] of st.list) list.set(k, { id: v.id, initialized: !!v.initialized });
      return { active: st.active, list };
    },
    /** Restore a snapshotChat() snapshot exactly (also undoes markInitialized). */
    restoreChat(chatId, snap) {
      if (!snap) {
        chats.delete(chatId);
        return;
      }
      chats.set(chatId, { active: snap.active, list: new Map(snap.list) });
    },
    /** Mark a session initialized (resumable) after a successful Claude run. */
    markInitialized(chatId, sessionId) {
      const st = chats.get(chatId);
      if (!st) return;
      for (const s of st.list.values()) {
        if (s.id === sessionId) s.initialized = true;
      }
    },
    save,
    /** Await pending persistence (used by tests and shutdown). */
    flush() {
      return writeChain;
    },
  };
}

module.exports = { createSessionStore, newSessionId, migrateChatEntry, makeChatState, SCHEMA_VERSION };
