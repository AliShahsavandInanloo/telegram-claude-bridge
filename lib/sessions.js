'use strict';

/**
 * Session store: chatId -> { active, list: Map<name, {id, initialized}> }.
 *
 * - Names are validated (no prototype pollution, no path characters).
 * - State is kept in Maps internally, persisted as plain JSON.
 * - Old flat schema (name -> "uuid") is migrated on load.
 * - Crash-safe persistence: serialize -> temp file -> rename, writes
 *   serialized through a promise chain so they never interleave.
 */

const fs = require('fs');
const path = require('path');
const { validateSessionName } = require('./config');

function newSessionId() {
  return require('crypto').randomUUID();
}

function makeChatState() {
  return { active: 'default', list: new Map() };
}

/** Validate/migrate one loaded chat entry; returns null if unusable. */
function migrateChatEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = makeChatState();
  const list = raw.list && typeof raw.list === 'object' ? raw.list : raw;
  if (typeof raw.active === 'string' && validateSessionName(raw.active).ok) {
    out.active = raw.active;
  }
  for (const [name, value] of Object.entries(list)) {
    if (name === 'active' || name === 'list') continue;
    if (!validateSessionName(name).ok) continue;
    if (typeof value === 'string') {
      // old schema: name -> uuid
      out.list.set(name, { id: value, initialized: true });
    } else if (value && typeof value === 'object' && typeof value.id === 'string' && /^[0-9a-fA-F-]{36}$/.test(value.id)) {
      out.list.set(name, { id: value.id, initialized: Boolean(value.initialized) });
    }
  }
  if (!out.list.has(out.active)) {
    const first = out.list.keys().next();
    out.active = first.done ? 'default' : first.value;
  }
  if (!out.list.size) return null;
  return out;
}

/**
 * Create the store. fsImpl injectable for tests.
 * readFileSync/existsSync/unlinkSync/renameSync/writeFileSync used.
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
      for (const [chatId, entry] of Object.entries(raw)) {
        const migrated = migrateChatEntry(entry);
        if (migrated) chats.set(String(chatId), migrated);
      }
    }
  }

  function serialize() {
    const out = {};
    for (const [chatId, st] of chats) {
      const list = {};
      for (const [name, s] of st.list) list[name] = { id: s.id, initialized: !!s.initialized };
      out[chatId] = { active: st.active, list };
    }
    return JSON.stringify(out, null, 2);
  }

  function save() {
    // Serialize writes through a promise chain; atomic tmp+rename inside.
    writeChain = writeChain.then(async () => {
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
    }).catch((err) => {
      console.error('[sessions] failed to persist:', err.message);
    });
    return writeChain;
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

module.exports = { createSessionStore, newSessionId, migrateChatEntry, makeChatState };
