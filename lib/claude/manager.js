'use strict';

/**
 * Claude Session Manager — the control layer between Telegram and Claude.
 *
 * Owns the lifecycle of MANAGED Claude sessions:
 *   create / start / attach / detach / stop / restart / route messages.
 *
 * Keeps registry status in sync with reality and persists metadata through
 * the registry (snapshot -> mutate -> save -> restore on failure, so a failed
 * save never leaves misleading in-memory state).
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

  /**
   * Debounced registry persist with correct transaction order:
   *   snapshot (PRE-mutation) -> mutate -> persist -> restore on failure.
   * Callers MUST take the snapshot BEFORE mutating (see withPersist below).
   * For async flows, use persistWith(snap) and pass the pre-mutation snapshot.
   */
  function persistNow(snap) {
    const s = snap || reg.snapshot();
    reg
      .save()
      .catch((err) => {
        reg.restore(s);
        logError(`registry save failed (state rolled back): ${err.message}`);
      });
  }
  function schedulePersist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persistNow(), saveDelayMs);
    if (saveTimer.unref) saveTimer.unref();
  }
  /** Helper: snapshot BEFORE the mutation runs, then persist/rollback. */
  function withPersist(mutate) {
    const snap = reg.snapshot(); // 1. pre-mutation snapshot
    const out = mutate(); // 2. mutate
    persistNow(snap); // 3-4. persist; restore snapshot on failure
    return out;
  }

  function getManaged(id) {
    return managed.get(String(id)) || null;
  }

  function setStatus(id, status) {
    reg.setStatus(id, status);
    schedulePersist();
  }

  function onSessionExit(ms) {
    return () => {
      managed.delete(ms.id);
      const entry = reg.get(ms.id);
      if (entry && entry.status !== 'stopped' && entry.status !== 'error') {
        setStatus(ms.id, 'idle'); // process gone; entry stays, restartable on demand
      }
      logInfo(`managed session ${entry ? entry.name : ms.id} process exited`);
    };
  }

  /** Create + register + start a managed session (snapshot BEFORE mutate). */
  function createSession({ name, project, owner }) {
    return withPersist(() => {
      const created = reg.create({ name, project, owner });
      if (!created.ok) return created;
      startSession(created.entry.id);
      return created;
    });
  }

  /** Ensure the underlying Claude process for an entry is running. */
  function startSession(id) {
    const entry = reg.get(id);
    if (!entry) return { ok: false, error: 'no such session' };
    if (getManaged(id)) return { ok: true, already: true };
    setStatus(id, 'starting');
    const ms = createManagedSession(entry, launch, { spawnFn, logInfo, logError });
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
    reg.touch(entry.id);
    schedulePersist();
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

  function stopAll() {
    for (const [id, ms] of [...managed]) {
      try {
        ms.kill('bridge shutdown');
      } catch {
        /* ignore */
      }
      managed.delete(id);
    }
    if (saveTimer) clearTimeout(saveTimer);
    persistNow();
  }

  return {
    createSession,
    startSession,
    stopSession,
    getManaged,
    route,
    status,
    attached: (chatId) => reg.attached(chatId),
    attach: (chatId, id) => withPersist(() => reg.attach(chatId, id)),
    detach: (chatId) => withPersist(() => reg.detach(chatId)),
    list: () => reg.list(),
    stopAll,
    _persistNow: persistNow,
    _managed: managed,
  };
}

module.exports = { createClaudeManager };
