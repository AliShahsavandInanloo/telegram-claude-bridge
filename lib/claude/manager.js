'use strict';

/**
 * Claude Session Manager — the control layer between Telegram and Claude.
 *
 * Owns the lifecycle of MANAGED Claude sessions:
 *   create / start / attach / detach / stop / restart / route messages.
 *
 * Keeps registry status in sync with reality and persists metadata through
 * the registry.
 *
 * TRANSACTION DISCIPLINE (global registry mutex):
 *   snapshot()/restore() act on the ENTIRE registry, so every persisted
 *   mutation this manager performs runs inside reg.withTransaction(...):
 *      snapshot -> mutate -> save -> restore-on-failure -> commit
 *   The lock is acquired BEFORE the snapshot, the mutation, the save and any
 *   rollback. Nothing mutates the shared registry outside that boundary —
 *   otherwise an unrelated Channel transaction holding an older whole-registry
 *   snapshot could restore it and silently erase an operation that already
 *   returned success (the confirmed /attach and session-creation lost-update).
 *
 * Coalesced, transaction-safe updates: high-frequency, low-value state
 * (session `status`, `claudeSessionId`) is queued OUTSIDE the registry and
 * applied — together with a single save — inside ONE registry transaction per
 * burst. The live registry is never mutated before acquiring the lock.
 *
 * It deliberately does NOT try to control arbitrary Claude terminals a user
 * opened manually — those processes own their own TTY; see lib/claude/discover.js
 * for the strictly read-only discovery of such processes.
 *
 * `reg` (registry), `launch` ({command, prefixArgs}) and `spawnFn` are
 * injectable for tests.
 */

const { createManagedSession } = require('./session');

function createClaudeManager({ reg, launch, spawnFn, logInfo = () => {}, logError = () => {}, saveDelayMs = 400 } = {}) {
  const managed = new Map(); // registry entry id -> ManagedSession
  let saveTimer = null;
  // Queued persisted mutations, applied together in ONE registry transaction.
  let pendingStatuses = new Map(); // id -> status (last write wins)
  let pendingSessionIds = new Map(); // id -> claudeSessionId (last write wins)
  const statusIntent = new Map(); // id -> latest status we requested (pending or applied)

  /**
   * Canonical mutation helper OWNING the full registry transaction boundary:
   * lock -> snapshot -> mutate -> save -> (restore on failure) -> commit.
   * Rejects if the save fails (the caller reports failure, never success).
   * async because acquiring the non-reentrant global mutex always yields.
   */
  function withPersist(mutate) {
    return reg.withTransaction(async () => {
      const snapshot = reg.snapshot();
      try {
        const result = await mutate();
        await reg.save();
        return result;
      } catch (err) {
        reg.restore(snapshot);
        throw err;
      }
    });
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flushPending();
    }, saveDelayMs);
    if (saveTimer.unref) saveTimer.unref();
  }

  /**
   * Record a status change. It is ALWAYS staged outside the registry and later
   * applied through the transaction-safe coalesced queue — the live registry
   * is never mutated here. Context is never inferred from a shared manager
   * flag: an unrelated async event (child exit, kill, completion) must never
   * be able to join whichever transaction happens to be in flight.
   */
  function setStatus(id, status) {
    const idS = String(id);
    statusIntent.set(idS, status);
    pendingStatuses.set(idS, status);
    scheduleSave();
  }

  /**
   * Record a Claude session id the same transaction-safe way as status: it is
   * always staged outside the registry (never a direct in-flight mutation).
   */
  function rememberClaudeSessionId(id, claudeSessionId) {
    pendingSessionIds.set(String(id), claudeSessionId);
    scheduleSave();
  }

  /**
   * Apply every queued status/identity update and persist in ONE registry
   * transaction (snapshot -> apply -> save -> restore on failure).
   */
  function flushPending() {
    if (!pendingStatuses.size && !pendingSessionIds.size) return Promise.resolve();
    const statuses = pendingStatuses;
    const sessionIds = pendingSessionIds;
    pendingStatuses = new Map();
    pendingSessionIds = new Map();
    return reg.withTransaction(async () => {
      const snapshot = reg.snapshot();
      try {
        for (const [id, status] of statuses) reg.setStatus(id, status);
        for (const [id, sessionId] of sessionIds) reg.setClaudeSessionId(id, sessionId);
        await reg.save();
      } catch (err) {
        reg.restore(snapshot);
        // Preserve the intent WITHOUT a retry loop: re-queue anything that has
        // not already been superseded by a newer update. The next flush (a
        // later update or shutdown) applies it; nothing self-reschedules.
        for (const [id, status] of statuses) if (!pendingStatuses.has(id)) pendingStatuses.set(id, status);
        for (const [id, sessionId] of sessionIds) if (!pendingSessionIds.has(id)) pendingSessionIds.set(id, sessionId);
        logError(`registry save failed (queued updates rolled back): ${err.message}`);
      }
    });
  }

  /** Persist any queued updates now (standalone: never called from inside a txn). */
  function persistNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    return flushPending();
  }

  function getManaged(id) {
    return managed.get(String(id)) || null;
  }

  /** The status we most recently intended for an entry (queued or applied). */
  function intendedStatus(id) {
    const idS = String(id);
    if (statusIntent.has(idS)) return statusIntent.get(idS);
    const entry = reg.get(idS);
    return entry ? entry.status : null;
  }

  function onSessionExit(ms) {
    return () => {
      managed.delete(ms.id);
      const current = intendedStatus(ms.id);
      if (current && current !== 'stopped' && current !== 'error') {
        setStatus(ms.id, 'idle'); // process gone; entry stays, restartable on demand
      }
      const entry = reg.get(ms.id);
      logInfo(`managed session ${entry ? entry.name : ms.id} process exited`);
    };
  }

  /**
   * Create + register a managed session. The registry record is committed
   * inside one transaction BEFORE the process is started, so a failed save
   * leaves no spawned orphan and reports failure (never false success).
   */
  async function createSession({ name, project, owner }) {
    let created;
    try {
      created = await withPersist(() => reg.create({ name, project, owner }));
    } catch (err) {
      logError(`registry save failed for new session (rolled back): ${err.message}`);
      return { ok: false, error: `Could not create session (failed to save): ${err.message}` };
    }
    if (!created.ok) return created;
    startSession(created.entry.id);
    return created;
  }

  /** Ensure the underlying Claude process for an entry is running. */
  function startSession(id) {
    const entry = reg.get(id);
    if (!entry) return { ok: false, error: 'no such session' };
    if (getManaged(id)) return { ok: true, already: true };
    setStatus(id, 'starting');
    const ms = createManagedSession(entry, launch, {
      spawnFn,
      logInfo,
      logError,
      onClaudeSessionId: (claudeSessionId) => rememberClaudeSessionId(entry.id, claudeSessionId),
    });
    managed.set(entry.id, ms);
    ms.on('exit', onSessionExit(ms));
    ms.start();
    return { ok: true };
  }

  /** Stop a managed session's process (entry stays in the registry). */
  function stopSession(id, reason) {
    const ms = getManaged(id);
    if (!ms) {
      setStatus(id, 'stopped');
      return { ok: true, already: true };
    }
    setStatus(id, 'stopped');
    ms.kill(reason || 'stopped');
    managed.delete(id);
    return { ok: true };
  }

  /** Route a user message to the session a chat is attached to. */
  function route(chatId, text, { onQueued, onProgress } = {}) {
    const entry = reg.attached(chatId);
    if (!entry) return { ok: false, error: 'no_session_attached' };
    const started = startSession(entry.id); // lazily (re)start if needed
    if (!started.ok) return started;
    const ms = getManaged(entry.id);
    reg.touch(entry.id); // registry-coalesced, transaction-safe activity marker
    return ms
      .submitTask(text, onProgress)
      .then((result) => {
        if (result.queued && onQueued) onQueued(result.position);
        if (!result.queued) setStatus(entry.id, result.ok ? 'idle' : 'error');
        return result;
      });
  }

  function status(id) {
    const entry = reg.get(id);
    if (!entry) return null;
    const ms = getManaged(id);
    return {
      entry,
      process: ms
        ? ms.getStatus()
        : { pid: null, running: false, starting: false, busy: false, task: null, taskStartedAt: null, queuedTasks: 0, exit: null, latestOutput: '', claudeSessionId: entry.claudeSessionId },
    };
  }

  /** Persist-owned mutation wrapper: async, and never reports false success. */
  async function persistMutation(mutate, label) {
    try {
      return await withPersist(mutate);
    } catch (err) {
      logError(`registry save failed for ${label} (rolled back): ${err.message}`);
      return { ok: false, error: `registry persistence failed: ${err.message}` };
    }
  }

  /**
   * Shut down every managed session DURABLY: process control stays immediate
   * (kill is NEVER delayed by the coalescing debounce), but the returned
   * promise does not resolve until the manager-owned pending registry
   * updates (shutdown statuses, queued claudeSessionIds) have either
   * PERSISTED or produced a logged persistence failure. A caller that exits
   * the process before awaiting this can lose queued updates — always await.
   *
   * The shutdown status is staged BEFORE the kill so the child-close
   * callback can never flip it back to idle: onSessionExit consults
   * intendedStatus(), which sees the staged 'stopped' intent.
   */
  async function stopAll() {
    for (const [id, ms] of [...managed]) {
      setStatus(id, 'stopped'); // stage shutdown intent first (immediate, outside the registry)
      try {
        ms.kill('bridge shutdown');
      } catch {
        /* ignore */
      }
      managed.delete(id);
    }
    await persistNow();
  }

  return {
    createSession,
    startSession,
    stopSession,
    getManaged,
    route,
    status,
    attached: (chatId) => reg.attached(chatId),
    attach: (chatId, id) => persistMutation(() => reg.attach(chatId, id), 'attach'),
    detach: (chatId) => persistMutation(() => reg.detach(chatId), 'detach'),
    list: () => reg.list(),
    stopAll,
    _persistNow: persistNow,
    _managed: managed,
  };
}

module.exports = { createClaudeManager };
