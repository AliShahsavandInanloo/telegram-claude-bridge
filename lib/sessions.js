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
  if (raw.sessions && typeof raw.sessions === 'object') {
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
  // Metadata keys ('active', 'list', ...) are only special at the TOP level of
  // a legacy file. Sessions stored INSIDE raw.list may legitimately be named
  // "active" or "list" and must survive migration (issue: sessions named
  // active/list disappearing after restart).
  const legacyMeta = new Set(['active', 'list', 'activeSession', 'sessions', 'version']);
  const hasListKey = raw.list && typeof raw.list === 'object' && !Array.isArray(raw.list);
  const list = hasListKey ? raw.list : raw;
  const metaKeys = hasListKey ? new Set(['activeSession', 'sessions', 'version']) : legacyMeta;
  if (typeof raw.active === 'string' && validateSessionName(raw.active).ok) {
    out.active = raw.active;
  }
  for (const [name, value] of Object.entries(list)) {
    if (metaKeys.has(name)) continue;
    if (!validateSessionName(name).ok) continue;
    if (typeof value === 'string') {
      // oldest schema: name -> uuid
      out.list.set(name, { id: value, initialized: true });
    } else if (value && typeof value === 'object' && typeof value.id === 'string' && /^[0-9a-fA-F-]{36}$/.test(value.id)) {
      out.list.set(name, { id: value.id, initialized: Boolean(value.initialized) });
    }
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
   */
  function save() {
    const run = writeChain.then(async () => {
      const json = serialize();
      const dir = path.dirname(file);
      await fsImpl.promises.mkdir(dir, { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      const fh = await fsImpl.promises.open(tmp, 'w');
      try {
        await fh.writeFile(json, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fsImpl.promises.rename(tmp, file);
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
