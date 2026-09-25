'use strict';

/**
 * Streaming output pipeline for managed sessions.
 *
 * Turns a chatty Claude session into Telegram-friendly progress updates:
 *   - buffers raw output chunks
 *   - emits a grouped update at most once per `minIntervalMs`
 *   - always emits when a turn completes (final result)
 *   - hard-caps message size (Telegram limits) and update frequency
 *
 * Anti-spam guarantees: between two progress messages at least
 * `minIntervalMs` elapses, and only meaningful new output (>= minChunkChars
 * since last send) triggers a send. `send` injectable; failures are swallowed
 * (progress is best-effort, never breaks the task).
 */

const CHUNK_LIMIT = 3800;

function createProgressReporter({ send, minIntervalMs = 15000, minChunkChars = 200, logWarn = () => {} } = {}) {
  let lastSentAt = 0;
  let lastSentLen = 0;
  let pending = '';
  let timer = null;
  let finished = false;

  function flush(force) {
    const now = Date.now();
    const newChars = pending.length - lastSentLen;
    if (!pending.trim() || (!force && (now - lastSentAt < minIntervalMs || newChars < minChunkChars))) {
      return;
    }
    const text = pending.slice(-CHUNK_LIMIT).trimEnd();
    lastSentAt = now;
    lastSentLen = pending.length;
    pending = '';
    Promise.resolve()
      .then(() => send(text))
      .catch((err) => logWarn(`progress send failed: ${err.message}`));
  }

  return {
    /** Raw incremental output from the session. */
    push(chunk) {
      if (finished) return;
      pending += chunk;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          flush(false);
        }, minIntervalMs);
        if (timer.unref) timer.unref();
      }
    },
    /** Turn finished: send whatever remains, then stop. */
    complete(summary) {
      if (finished) return;
      finished = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const body = summary || pending.trim();
      if (body) {
        const text = body.slice(-CHUNK_LIMIT).trimEnd();
        Promise.resolve()
          .then(() => send(text))
          .catch((err) => logWarn(`final send failed: ${err.message}`));
      }
    },
    _pending: () => pending,
  };
}

module.exports = { createProgressReporter, CHUNK_LIMIT };
