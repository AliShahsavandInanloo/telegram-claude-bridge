'use strict';

/**
 * Persistent registry of MANAGED Claude sessions (schema v1).
 *
 * A managed session is one the bridge fully owns and controls:
 *   { id, name, project, claudeSessionId, status, pid, owner, ... }
 *
 * This registry is PERSISTENT metadata only — process handles live in the
 * bridge's runtime manager and die with the bridge. On restart the registry
 * is reloaded; processes are (re)started lazily on demand.
 *
 * Persistence reuses the proven pattern from lib/sessions.js:
 *   - atomic writes (tmp + fsync + rename), save() REJECTS on failure
 *   - corrupted files are backed up (*.corrupt-*.bak) and start fresh
 *   - snapshot/restore for exact rollback of failed saves
 *   - names validated with the same rules (no prototype pollution / traversal)
 *
 * NOTE: entries in this registry are MANAGED sessions. Discovered Claude
 * processes (see lib/claude/discover.js) are a separate, read-only concept
 * and are never auto-inserted here.
 */

const fs = require('fs');
const path = require('path');
const { validateSessionName } = require('../config');

const SCHEMA_VERSION = 2; // v2: transport/connected/lastSeen/channel identity fields
const STATUSES = new Set(['idle', 'starting', 'running', 'busy', 'stopped', 'error']);
const TRANSPORTS = new Set(['channel', 'stream-json']);
const UUID_RE = /^[0-9a-fA-F-]{36}$/;

function newSessionId() {
  return require('crypto').randomUUID();
}

/** Validate a project path: absolute and an existing directory. */
function validateProjectPath(project, fsImpl = fs) {
  if (!project || typeof project !== 'string' || !project.trim()) {
    return { ok: false, error: 'project path is required' };
  }
  let resolved;
  try {
    resolved = path.resolve(project.trim());
  } catch {
    return { ok: false, error: 'project path is not a valid path' };
  }
  let st;
  try {
    st = fsImpl.statSync(resolved);
  } catch {
    return { ok: false, error: `project path "${project}" does not exist` };
  }
  if (!st.isDirectory()) {
    return { ok: false, error: `project path "${project}" is not a directory` };
  }
  return { ok: true, resolved };
}

function validOwner(o) {
  return o && typeof o.userId === 'string' && /^\d{1,20}$/.test(o.userId);
}

function createRegistry(file, fsImpl = fs) {
  /** chatId(string) -> entry id(string) */
  const sessions = new Map(); // id -> entry
  const attachments = new Map(); // chatId -> sessionId

  function load() {
    let raw = null;
    try {
      if (fsImpl.existsSync(file)) {
        const content = fsImpl.readFileSync(file, 'utf8');
        if (content.trim()) raw = JSON.parse(content);
      }
    } catch (err) {
      try {
        fsImpl.copyFileSync(file, `${file}.corrupt-${Date.now()}.bak`);
      } catch {
        /* best effort */
      }
      console.error(`[registry] ${file} was unreadable (${err.message}); backed up if possible and starting fresh`);
      raw = null;
    }
    if (!raw || typeof raw !== 'object') return;
    const list = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
    for (const [id, e] of Object.entries(list)) {
      if (!UUID_RE.test(String(id))) continue;
      if (!e || typeof e !== 'object' || typeof e.name !== 'string' || !validateSessionName(e.name).ok) continue;
      if (!e.project || typeof e.project !== 'string') continue;
      sessions.set(String(id), {
        id: String(id),
        name: e.name,
        project: e.project,
        claudeSessionId: typeof e.claudeSessionId === 'string' && UUID_RE.test(e.claudeSessionId) ? e.claudeSessionId : null,
        initialized: !!e.initialized,
        status: STATUSES.has(e.status) ? e.status : 'idle',
        pid: Number.isInteger(e.pid) && e.pid > 0 ? e.pid : null,
        createdAt: typeof e.createdAt === 'string' ? e.createdAt : new Date().toISOString(),
        lastActivity: typeof e.lastActivity === 'string' ? e.lastActivity : e.createdAt || new Date().toISOString(),
        owner: validOwner(e.owner) ? { userId: e.owner.userId } : null,
        // v2: transport + live channel identity. `connected` is RUNTIME state
        // (true only while a channel connection is authenticated); it is
        // persisted as false and set true by the hub on hello_ok.
        transport: TRANSPORTS.has(e.transport) ? e.transport : 'stream-json',
        channelName: typeof e.channelName === 'string' ? e.channelName : null,
        claudeVersion: typeof e.claudeVersion === 'string' ? e.claudeVersion : null,
        protocol: Number.isInteger(e.protocol) ? e.protocol : 1,
        // v2: stable Channel client identity — the PRIMARY reconnect key.
        // Legacy records without one migrate safely (null); the hub backfills
        // it from the connection's clientId on first registration.
        clientId: typeof e.clientId === 'string' && e.clientId ? e.clientId : null,
        connected: false,
        lastSeen: typeof e.lastSeen === 'string' ? e.lastSeen : null,
      });
    }
    const att = raw.attachments && typeof raw.attachments === 'object' ? raw.attachments : {};
    for (const [chatId, id] of Object.entries(att)) {
      if (typeof id === 'string' && sessions.has(id)) attachments.set(String(chatId), id);
    }
  }

  function serialize() {
    const out = {};
    for (const [id, e] of sessions) out[id] = { ...e };
    const att = {};
    for (const [chatId, id] of attachments) att[chatId] = id;
    return JSON.stringify({ version: SCHEMA_VERSION, sessions: out, attachments: att }, null, 2);
  }

  let writeChain = Promise.resolve();

  /**
   * GLOBAL REGISTRY TRANSACTION MUTEX (cross-identity rollback fix).
   *
   * snapshot()/restore() operate on the ENTIRE registry, so any flow that
   * uses them (snapshot -> mutate -> save -> restore-on-failure) MUST be
   * serialized: two concurrent transactions would otherwise let a failed
   * one roll back a successful unrelated transaction's committed state
   * (reproduced: client X's failed save erased client Y's registry record
   * while Y was online).
   *
   * withTransaction(fn) runs fn() exclusively — while it runs (including
   * all awaited work: save, validation, etc.), no other registry
   * transaction can take a snapshot or mutate+persist. It never holds the
   * lock across unrelated network waits; callers keep their critical
   * section tight. The registry's own save() queue serializes disk writes.
   *
   * Deliberately NOT applied to read-only accessors (get/getByName/list…):
   * only whole-registry snapshot/mutate/persist flows need isolation.
   *
   * Fast path: a SYNCHRONOUS fn runs inline (no extra microtask hops) when
   * no transaction is active, so short transactions (manager debounced
   * persist) never delay each other by a tick. A second caller arriving
   * while one is active is queued behind the tail like any async fn.
   */
  let txnTail = Promise.resolve();
  let txnActive = false;
  function withTransaction(fn) {
    // CONTENDED path: queue behind the current tail (tail never rejects).
    // Every async fn goes through here — a "take the lock if it looks
    // free" fast path deadlocked under queued waiters: the lock flipped to
    // free while waiter 1's fn was not yet scheduled, so waiter 2 took it
    // too and the mutex stopped being exclusive. Queueing ALWAYS preserves
    // strict FIFO exclusivity.
    const wasIdle = !txnActive;
    txnActive = true;
    const run = txnTail.then(fn, fn);
    const tail = run.then(
      () => {},
      () => {},
    );
    tail.then(() => {
      // Release only if we are still the newest tail (identity check).
      if (txnTail === tail) txnActive = false;
    });
    txnTail = tail;
    return run;
  }
  /** True while a registry transaction holds the global mutex. */
  function transactionBusy() {
    return txnActive;
  }

  /** Atomic persist; REJECTS on failure (callers roll back / report). */
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
          console.error(`[registry] could not remove temp file ${tmp}: ${cleanupErr.message}`);
        }
        throw err; // original error, unmasked
      }
    });
    writeChain = run.then(() => {}, () => {});
    return run;
  }

  function flush() {
    return writeChain;
  }

  load(); // hydrate from disk at construction (corrupt files backed up here)

  function snapshot() {
    const s = new Map();
    for (const [k, v] of sessions) s.set(k, { ...v });
    return { sessions: s, attachments: new Map(attachments) };
  }

  function restore(snap) {
    if (!snap) return;
    sessions.clear();
    for (const [k, v] of snap.sessions) sessions.set(k, { ...v });
    attachments.clear();
    for (const [k, v] of snap.attachments) attachments.set(k, v);
  }

  return {
    /** Create a managed session entry. Returns {ok, entry|error}. */
    create({ name, project, owner }) {
      const check = validateSessionName(String(name || '').trim());
      if (!check.ok) return { ok: false, error: check.error };
      const proj = validateProjectPath(project, fsImpl);
      if (!proj.ok) return { ok: false, error: proj.error };
      const finalName = String(name).trim();
      for (const e of sessions.values()) {
        if (e.name.toLowerCase() === finalName.toLowerCase()) {
          return { ok: false, error: `a session named "${finalName}" already exists` };
        }
      }
      const now = new Date().toISOString();
      const entry = {
        id: newSessionId(),
        name: finalName,
        project: proj.resolved,
        claudeSessionId: null,
        initialized: false,
        status: 'idle',
        pid: null,
        createdAt: now,
        lastActivity: now,
        owner: owner && validOwner(owner) ? { userId: owner.userId } : null,
        transport: 'stream-json',
        channelName: null,
        claudeVersion: null,
        protocol: 1,
        connected: false,
        lastSeen: null,
      };
      sessions.set(entry.id, entry);
      return { ok: true, entry };
    },
    get(id) {
      return sessions.get(String(id)) || null;
    },
    getByName(name) {
      const n = String(name || '').trim().toLowerCase();
      for (const e of sessions.values()) {
        if (e.name.toLowerCase() === n) return e;
      }
      return null;
    },
    /** All entries, oldest first (stable ordering for numbered menus). */
    list() {
      return [...sessions.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    },
    remove(id) {
      const idS = String(id);
      if (!sessions.has(idS)) return { ok: false, error: 'no such session' };
      sessions.delete(idS);
      for (const [chatId, attId] of [...attachments]) {
        if (attId === idS) attachments.delete(chatId);
      }
      return { ok: true };
    },
    setStatus(id, status) {
      const e = sessions.get(String(id));
      if (!e || !STATUSES.has(status)) return false;
      e.status = status;
      return true;
    },
    setPid(id, pid) {
      const e = sessions.get(String(id));
      if (!e) return false;
      e.pid = Number.isInteger(pid) && pid > 0 ? pid : null;
      return true;
    },
    setClaudeSessionId(id, claudeSessionId) {
      const e = sessions.get(String(id));
      if (!e) return false;
      if (claudeSessionId !== null && !UUID_RE.test(String(claudeSessionId))) return false;
      e.claudeSessionId = claudeSessionId || null;
      e.initialized = !!claudeSessionId;
      return true;
    },
    touch(id) {
      const e = sessions.get(String(id));
      if (e) e.lastActivity = new Date().toISOString();
    },
    /** Runtime-only connectivity flags (persisted as false on next save). */
    setConnected(id, connected) {
      const e = sessions.get(String(id));
      if (!e) return false;
      e.connected = !!connected;
      if (connected) e.lastSeen = new Date().toISOString();
      return true;
    },
    /** Reconcile a live channel connection onto a registry entry. */
    applyChannelIdentity(id, { channelName, claudeSessionId, pid, claudeVersion, protocol } = {}) {
      const e = sessions.get(String(id));
      if (!e) return false;
      e.transport = 'channel';
      if (typeof channelName === 'string' && channelName) e.channelName = channelName;
      if (typeof claudeSessionId === 'string' && UUID_RE.test(claudeSessionId)) {
        e.claudeSessionId = claudeSessionId;
        e.initialized = true;
      }
      if (Number.isInteger(pid) && pid > 0) e.pid = pid;
      if (typeof claudeVersion === 'string' && claudeVersion) e.claudeVersion = claudeVersion;
      if (Number.isInteger(protocol)) e.protocol = protocol;
      e.connected = true;
      e.lastSeen = new Date().toISOString();
      return true;
    },
    getByClientId(clientId) {
      const c = String(clientId || '');
      if (!c) return null;
      for (const e of sessions.values()) if (e.clientId === c) return e;
      return null;
    },
    setClientId(id, clientId) {
      const e = sessions.get(String(id));
      if (!e) return false;
      if (typeof clientId === 'string' && clientId) e.clientId = clientId;
      return true;
    },
    attach(chatId, id) {
      const idS = String(id);
      if (!sessions.has(idS)) return { ok: false, error: 'no such session' };
      attachments.set(String(chatId), idS);
      return { ok: true, entry: sessions.get(idS) };
    },
    detach(chatId) {
      const had = attachments.delete(String(chatId));
      return { ok: true, wasAttached: had };
    },
    attached(chatId) {
      const id = attachments.get(String(chatId));
      return id ? sessions.get(id) || null : null;
    },
    snapshot,
    restore,
    save,
    flush,
    /** Serialize a whole-registry snapshot/mutate/persist transaction. */
    withTransaction,
    /** True while a registry transaction holds the global mutex (idle ⇒ false). */
    transactionBusy,
    load,    };
}

module.exports = { createRegistry, validateProjectPath, newSessionId, SCHEMA_VERSION, STATUSES };
