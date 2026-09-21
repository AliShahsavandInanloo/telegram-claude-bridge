'use strict';

/**
 * Global FIFO job queue across chats: jobs run strictly in enqueue order,
 * one Claude process at a time. A busy chat cannot starve another chat.
 * (MAX_QUEUE_PER_CHAT bounds any single chat's share.)
 */

function createJobQueue({ maxPerChat, runJob }) {
  const items = []; // { chatId, job, seq }
  const perChatCount = new Map();
  let running = null;
  let seqCounter = 0;

  function sizeFor(chatId) {
    return perChatCount.get(chatId) || 0;
  }

  function totalQueued() {
    return items.length;
  }

  function enqueue(chatId, job, { onQueued, onRejected } = {}) {
    if (sizeFor(chatId) >= maxPerChat) {
      if (onRejected) onRejected(maxPerChat);
      return { ok: false, error: 'queue full' };
    }
    seqCounter += 1;
    const entry = { chatId, job, seq: seqCounter };
    items.push(entry);
    perChatCount.set(chatId, sizeFor(chatId) + 1);
    if (onQueued) onQueued(items.length);
    pump();
    return { ok: true, position: items.length, seq: entry.seq };
  }

  function pump() {
    if (running || items.length === 0) return;
    const next = items.shift(); // global FIFO
    perChatCount.set(next.chatId, sizeFor(next.chatId) - 1);
    running = next;
    Promise.resolve()
      .then(() => runJob(next.chatId, next.job))
      .catch((err) => {
        console.error('[queue] job error:', err && err.message ? err.message : err);
      })
      .finally(() => {
        running = null;
        setImmediate(pump);
      });
  }

  /** Remove all queued (not running) jobs for one chat. Returns count removed. */
  function clearChat(chatId) {
    const keep = items.filter((e) => e.chatId !== chatId);
    const removed = items.length - keep.length;
    if (removed > 0) {
      items.length = 0;
      items.push(...keep);
      for (const cid of perChatCount.keys()) {
        perChatCount.set(cid, keep.filter((e) => e.chatId === cid).length);
      }
    }
    return removed;
  }

  /** Info for /queue. */
  function info(chatId) {
    const mine = items.filter((e) => e.chatId === chatId);
    return {
      running: running ? { chatId: running.chatId, sessionName: running.job.sessionName } : null,
      mineQueued: mine.length,
      totalQueued: items.length,
      nextMine: mine.length ? mine[0].seq : null,
    };
  }

  /** Stop accepting new work; used during shutdown. */
  function close() {
    items.length = 0;
    perChatCount.clear();
  }

  return { enqueue, clearChat, info, totalQueued, close, isRunning: () => !!running };
}

module.exports = { createJobQueue };
