'use strict';

/**
 * Persistent delivery store for delivery-scoped channel replies.
 *
 * Every Telegram message routed to a Channel session creates a delivery
 * record; the reply tool resolves delivery_id -> {chatId, sessionId}. The
 * store is PERSISTED (fix: it was a plain in-memory Map, so a Bridge restart
 * broke the main long-running-session use case — Claude finished its task
 * after the restart and its delivery_id resolved to nothing).
 *
 * Durability & bounds:
 *   - atomic persistence (tmp + rename), save failures are reported (never
 *     silently swallowed) so callers can decide safe semantics
 *   - bounded: oldest-expired-first eviction above `maxEntries`
 *   - expired records are purged on load and on insert
 *
 * Privacy: only routing metadata is persisted — deliveryId, chatId, owning
 * session id, timestamps, status. NEVER the message text.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 h — long analyses stay replyable
const DEFAULT_MAX_ENTRIES = 1000;

function createDeliveryStore(file, { fsImpl = fs, ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  /** deliveryId -> {deliveryId, chatId, sessionId, telegramMessageId, createdAt, expiresAt, status} */
  const records = new Map();

  function purgeExpired(now = Date.now()) {
    for (const [k, v] of [...records]) {
      if (v.expiresAt <= now) records.delete(k);
    }
  }

  function load() {
    let raw = null;
    try {
      if (fsImpl.existsSync(file)) {
        const content = fsImpl.readFileSync(file, 'utf8');
        if (content.trim()) raw = JSON.parse(content);
      }
    } catch (err) {
      // Corrupt store is not fatal — deliveries are a reply convenience.
      // Start empty; a save will overwrite the corrupt file atomically.
      try { fsImpl.copyFileSync(file, `${file}.corrupt-${Date.now()}.bak`); } catch { /* best effort */ }
      raw = null;
    }
    records.clear();
    if (raw && typeof raw === 'object') {
      const list = Array.isArray(raw.deliveries) ? raw.deliveries : [];
      const now = Date.now();
      for (const d of list) {
        if (!d || typeof d !== 'object') continue;
        if (typeof d.deliveryId !== 'string' || !d.deliveryId) continue;
        if (typeof d.chatId !== 'string' || typeof d.sessionId !== 'string') continue;
        const createdAt = Number(d.createdAt) || now;
        const expiresAt = Number(d.expiresAt) || createdAt + ttlMs;
        if (expiresAt <= now) continue; // drop expired on load
        records.set(d.deliveryId, {
          deliveryId: d.deliveryId,
          chatId: d.chatId,
          sessionId: d.sessionId,
          telegramMessageId: d.telegramMessageId == null ? null : String(d.telegramMessageId),
          createdAt,
          expiresAt,
          status: d.status === 'closed' ? 'closed' : 'open',
        });
      }
    }
    return { loaded: records.size };
  }

  function save() {
    purgeExpired();
    const payload = JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      deliveries: [...records.values()],
    });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fsImpl.writeFileSync(tmp, payload, 'utf8');
    try {
      fsImpl.renameSync(tmp, file);
    } catch (err) {
      try { fsImpl.unlinkSync(tmp); } catch { /* do not mask the original error */ }
      throw err;
    }
  }

  function create({ chatId, sessionId, telegramMessageId = null, now = Date.now() }) {
    purgeExpired(now);
    const deliveryId = require('crypto').randomBytes(12).toString('hex');
    records.set(deliveryId, {
      deliveryId,
      chatId: String(chatId),
      sessionId: String(sessionId),
      telegramMessageId: telegramMessageId == null ? null : String(telegramMessageId),
      createdAt: now,
      expiresAt: now + ttlMs,
      status: 'open',
    });
    // Bound: evict oldest expired-first, then oldest, above the cap.
    if (records.size > maxEntries) {
      const byAge = [...records.values()].sort((a, b) => a.createdAt - b.createdAt);
      for (const d of byAge) {
        if (records.size <= maxEntries) break;
        records.delete(d.deliveryId);
      }
    }
    return deliveryId;
  }

  /**
   * Resolve a delivery for a claiming session. Ownership is enforced: only
   * the session that the delivery was created FOR may use it (cross-session
   * theft, unknown ids and expired records are all rejected).
   */
  function resolve(deliveryId, { forSessionId, now = Date.now() } = {}) {
    const d = records.get(String(deliveryId || ''));
    if (!d) return { ok: false, error: 'unknown delivery' };
    if (d.status !== 'open') return { ok: false, error: `delivery ${d.status}` };
    if (d.expiresAt <= now) {
      d.status = 'expired';
      records.delete(d.deliveryId);
      return { ok: false, error: 'delivery expired' };
    }
    if (forSessionId && d.sessionId !== String(forSessionId)) {
      return { ok: false, error: 'delivery belongs to another session' };
    }
    return { ok: true, delivery: d, error: null };
  }

  function close(deliveryId, status = 'closed') {
    const d = records.get(String(deliveryId || ''));
    if (d) d.status = status;
  }

  function size() {
    return records.size;
  }

  return { load, save, create, resolve, close, size, purgeExpired };
}

module.exports = { createDeliveryStore, DEFAULT_TTL_MS, DEFAULT_MAX_ENTRIES };
