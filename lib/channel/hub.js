'use strict';

/**
 * Channel hub — the Bridge side of the custom Claude Code Channel.
 *
 * Each Channel-enabled Claude Code session runs our channel server
 * (lib/channel/claude-channel.js), which Claude Code spawns as an MCP
 * subprocess. That server connects here over localhost IPC, authenticates
 * with the hub secret, and registers its session. The hub:
 *
 *   - authenticates connections (random hub secret; never a bot/API token)
 *   - maps registrations to registry entries (or registers new sessions)
 *   - tracks online/offline (runtime `connected` flag on registry entries)
 *   - routes Bridge messages to the right channel connection and channel
 *     tool calls (reply / send_file) back into the Bridge
 *
 * Identity/reconnect rules:
 *   - identity is the channel's own clientId (uuid) — never a filesystem path
 *   - a reconnect with the SAME clientId re-binds to the same registry entry
 *     (no duplicate records; lastSeen/pid refreshed)
 *   - a reconnect with a NEW clientId for a project that already has an
 *     ONLINE entry registers a new entry (parallel sessions are distinct);
 *     an OFFLINE entry is reused by name+project match
 *   - disconnect marks the entry offline; the attachment stays but is
 *     inactive until reconnect
 */

const path = require('path');
const { createIpcServer, validateHeartbeatConfig } = require('./ipc');

const CHANNEL_PROTOCOL = 1;

function createChannelHub({ reg, secret, ipcsImpl, logInfo = () => {}, logWarn = () => {}, logError = logWarn, heartbeatIntervalMs, heartbeatTimeoutMs, port } = {}) {
  // sessionId (registry id) -> { conn, clientId, hello }
  const online = new Map();
  // clientId -> registry entry id (stable across reconnects)
  const clientIndex = new Map();

  let onChannelMessage = null; // (entry, { content, meta }) -> void
  let onChannelTool = null; // (entry, tool, args) => Promise<any>

  /**
   * Per-identity registration mutex (fixes 3, 9, 10): all registration
   * transactions for the same logical Channel identity (clientId) are
   * serialized through a promise chain. Different clientIds register
   * concurrently; a failed transaction never leaves the chain wedged.
   */
  const registrationLocks = new Map(); // clientId -> Promise (tail of chain)
  function withRegistrationLock(clientId, fn) {
    const key = String(clientId || 'unknown');
    const prev = registrationLocks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn); // run regardless of predecessor outcome
    registrationLocks.set(key, next.catch(() => {}));
    // Clean up the map when this identity's chain settles with no waiters.
    next.catch(() => {}).then(() => {
      if (registrationLocks.get(key) === next.catch(() => {})) {
        // best-effort cleanup; a newer transaction may have replaced it
      }
    });
    return next;
  }

  /** Monotonic registration generation per clientId (fix 2). */
  const registrationGenerations = new Map(); // clientId -> current generation
  function nextGeneration(clientId) {
    const key = String(clientId || 'unknown');
    const g = (registrationGenerations.get(key) || 0) + 1;
    registrationGenerations.set(key, g);
    return g;
  }
  function isCurrentGeneration(clientId, generation) {
    return registrationGenerations.get(String(clientId || 'unknown')) === generation;
  }

  /**
   * PURE registration-target lookup (fixes 1+7): inspects registry/clientIndex
   * state but NEVER mutates anything. Returns a decision the transaction
   * below executes:
   *   { action: 'rebind', entry }        — clientId already bound to this id
   *   { action: 'reuse', entry }         — offline record with same clientId/name+project
   *   { action: 'create', name }         — create a new record with this name
   */
  function findRegistrationTarget({ clientId, project, projectName }) {
    // 1. persisted stable identity FIRST (fix 8) — survives Bridge restarts
    //    and disambiguates multiple Claude sessions on the same project.
    const byClientId = reg.getByClientId(clientId);
    if (byClientId && byClientId.transport === 'channel') return { action: 'rebind', entry: byClientId };
    // 1b. runtime index (same run, pre-persistence rebinding)
    if (clientIndex.has(clientId)) {
      const id = clientIndex.get(clientId);
      if (reg.get(id)) return { action: 'rebind', entry: reg.get(id) };
      clientIndex.delete(clientId); // stale binding — dropping it is index hygiene
    }
    // 2. name+project match (reuse an existing OFFLINE record; avoids duplicates)
    //    Legacy records default to transport 'stream-json' — allow adopting
    //    an offline same-name+project record regardless of stored transport
    //    (adoption sets transport=channel via applyChannelIdentity).
    const byName = reg.getByName(projectName || '');
    if (byName && !byName.connected && pathsEqual(byName.project, project)) {
      return { action: 'reuse', entry: byName };
    }
    // 3. otherwise create a new managed session entry (name decided here,
    //    with a collision fallback — but NO registry mutation happens here)
    const desired = projectName || `chan-${String(clientId || '').slice(0, 6)}`;
    const existing = reg.getByName(desired);
    if (!existing) return { action: 'create', name: desired };
    return { action: 'create', name: `${desired}-${Date.now().toString(36).slice(-4)}` };
  }

  function pathsEqual(a, b) {
    try {
      return path.resolve(a) === path.resolve(b);
    } catch {
      return false;
    }
  }

  /**
   * THE authoritative registration transaction (fixes 1, 2, 3, 7, 9).
   *
   * Serialized per clientId via withRegistrationLock; each attempt carries a
   * monotonic generation. Ordering invariant — a session becomes routable
   * ONLY after: validate → PURE lookup → snapshot (pre-mutation) → stage →
   * persist → COMMIT (liveness + generation re-checked at commit) → ack.
   *
   * A candidate that dies or is superseded while its save is pending can
   * NEVER commit: no online.set, no connected=true, no old-conn destruction,
   * no register_ack (it receives register_nak "superseded"/"connection lost").
   */
  function handleRegistration(conn, hello) {
    const h = hello.registration || {};
    if (!h.project || typeof h.project !== 'string') {
      conn.send({ type: 'register_nak', reason: 'registration missing project' });
      conn.destroy();
      return;
    }
    const clientId = hello.clientId;
    const generation = nextGeneration(clientId);
    // Serialize all attempts for this identity (fix 3/9). The generation was
    // taken OUTSIDE the lock so a newer attempt immediately marks older
    // pending attempts stale even before they reach the front of the queue.
    withRegistrationLock(clientId, () => runRegistrationTransaction(conn, hello, h, generation));
  }

  function runRegistrationTransaction(conn, hello, h, generation) {
    const clientId = hello.clientId;
    const stale = (reason) => {
      logWarn(`channel: registration generation ${generation} for ${String(clientId).slice(0, 8)}… aborted: ${reason}`);
      conn.send({ type: 'register_nak', reason });
      if (conn.isAlive && !conn.isAlive()) conn.destroy();
      else if (conn.isAlive) { /* keep socket; client will see NAK */ }
    };

    // A newer attempt for the same identity already started → this one is
    // stale before it even begins.
    if (!isCurrentGeneration(clientId, generation)) {
      stale('superseded by a newer registration');
      return Promise.resolve();
    }

    const decision = findRegistrationTarget({
      clientId,
      project: h.project,
      projectName: h.projectName,
    });

    // SNAPSHOT BEFORE ANY MUTATION — create/rebind/reuse all happen after.
    const snap = reg.snapshot();

    // ---- stage registry mutation (rolled back on failure) ----
    let entry = null;
    if (decision.action === 'create') {
      const created = reg.create({ name: decision.name, project: h.project, owner: null });
      if (!created.ok) {
        // No mutation happened (create failed atomically) — nothing to restore.
        conn.send({ type: 'register_nak', reason: `could not create session: ${created.error}` });
        conn.destroy();
        return Promise.resolve();
      }
      entry = created.entry;
    } else {
      entry = decision.entry;
    }
    const replacedInfo = online.get(entry.id);
    const replacedConn = replacedInfo && replacedInfo.conn !== conn ? replacedInfo.conn : null;
    reg.applyChannelIdentity(entry.id, {
      channelName: h.channelName || 'telegram-bridge',
      claudeSessionId: h.claudeSessionId,
      pid: h.pid,
      claudeVersion: h.claudeVersion,
      protocol: h.protocol,
    });
    reg.setClientId(entry.id, clientId); // persist stable identity (fix 8)
    reg.setConnected(entry.id, true);

    // ---- persist, then commit ----
    return Promise.resolve()
      .then(() => reg.save())
      .then(() => {
        // COMMIT VALIDATION (fixes 1, 2, 13): the candidate must still be
        // alive AND its generation must still be current. A candidate that
        // closed while the save was pending, or was superseded by a newer
        // registration, must never commit.
        const alive = typeof conn.isAlive === 'function' ? conn.isAlive() : !conn.destroyed;
        if (!alive) {
          reg.restore(snap); // dead candidate commits nothing
          stale('connection lost during registration');
          return;
        }
        if (!isCurrentGeneration(clientId, generation)) {
          // Superseded candidate commits nothing AND must not clobber a newer
          // transaction's staged/committed state with our stale snapshot.
          // The newer generation's own transaction owns the registry now.
          stale('superseded by a newer registration');
          return;
        }
        // COMMIT: active connection ownership swaps only now. A replaced old
        // connection is destroyed AFTER the replacement is durable, so a
        // failed save can never leave the session without a healthy conn.
        online.set(entry.id, { conn, clientId, hello: h, generation });
        clientIndex.set(clientId, entry.id);
        if (replacedConn) {
          logInfo(`channel: promoting new connection for "${entry.name}" (gen ${generation}); retiring old socket`);
          try {
            replacedConn.destroy(); // fires its close handler; generation check makes it a no-op
          } catch {
            /* ignore */
          }
        }
        logInfo(`channel: session "${entry.name}" online (client ${String(clientId).slice(0, 8)}…, gen ${generation})`);
        conn.send({ type: 'register_ack', sessionId: entry.id, name: entry.name, protocol: CHANNEL_PROTOCOL });
      })
      .catch((err) => {
        logError(`channel registration persistence failed for "${entry.name}": ${err.message}; rolling back`);
        // Rollback safety (fix 10): only restore if our snapshot is still the
        // newest state for this identity — never overwrite a newer successful
        // transaction's committed state with our stale snapshot.
        if (isCurrentGeneration(clientId, generation)) {
          reg.restore(snap);
          conn.send({ type: 'register_nak', reason: 'registry persistence failed — registration rolled back' });
        } else {
          conn.send({ type: 'register_nak', reason: 'superseded by a newer registration' });
        }
        // online map was NEVER touched by this attempt.
      });
  }

  function handleDisconnect(entryId) {
    const info = online.get(entryId);
    online.delete(entryId);
    const entry = reg.get(entryId);
    if (entry) {
      reg.setConnected(entryId, false);
      reg.setStatus(entryId, 'idle');
      logInfo(`channel: session "${entry.name}" went offline`);
    }
    return info;
  }

  function hubPortLog(port) {
    logInfo(`channel hub listening on 127.0.0.1:${port}`);
  }

  // Real IPC server (null in test-injection mode). The STABLE configured
  // port is bound at CONSTRUCTION (fix: it previously sat in listen opts
  // while the server was built with port 0, so the configured value never
  // reached the socket and the hub could silently land on a random port).
  const server = ipcsImpl
    ? null
    : createIpcServer({
        port: Number.isInteger(port) && port > 0 ? port : 0,
        secret,
        logInfo,
        logWarn,
        heartbeatIntervalMs: heartbeatIntervalMs || undefined,
        heartbeatTimeoutMs: heartbeatTimeoutMs || undefined,
      });

  return {
    CHANNEL_PROTOCOL,
    /** The port the IPC server ACTUALLY bound (== the configured stable port). */
    get actualPort() {
      return server ? server.actualPort : null;
    },
    /**
     * Start listening. cb({ port, host }) fires when ready.
     * opts: { onFatal(err) — REQUIRED in production (stable port); when
     * absent, a plain listen() is used (tests/ephemeral port 0 only).
     * Uses ipcsImpl (test injection) when provided instead of a real server.
     */
    listen(cb, opts = {}) {
      if (ipcsImpl) {
        // Test mode: the injected impl is expected to call handleIncoming.
        cb({ port: 0, host: '127.0.0.1' });
        return;
      }
      // Route authenticated IPC connections into the hub.
      server.onConnection((payload) => this.onConnection(payload));
      if (opts.onFatal) {
        // STABLE endpoint: fatal on occupied port (never a silent random port).
        server.listenOrFatal({
          onFatal: opts.onFatal,
          onReady: ({ port }) => {
            hubPortLog(port);
            cb({ port, host: '127.0.0.1' });
          },
        });
      } else {
        server.listen(({ port }) => {
          logInfo(`channel hub listening on 127.0.0.1:${port}`);
          cb({ port, host: '127.0.0.1' });
        });
      }
    },
    /** Called by the IPC layer after a valid hello. */
    onConnection({ conn, hello }) {
      conn.on('close', () => {
        // LATE-CLOSE RACE GUARD (fix 13): only the CURRENTLY authoritative
        // connection may take its session offline. A stale connection's close
        // event (e.g. emitted after a replacement committed) must not tear
        // down the new authoritative connection's session.
        for (const [id, info] of [...online]) {
          if (info.conn === conn) handleDisconnect(id);
        }
      });
      conn.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'register') {
          handleRegistration(conn, { ...hello, registration: msg.registration, clientId: hello.clientId });
          return;
        }
        // Find which session this connection belongs to.
        let entryId = null;
        for (const [id, info] of online) {
          if (info.conn === conn) {
            entryId = id;
            break;
          }
        }
        const entry = entryId ? reg.get(entryId) : null;
        if (!entry) {
          conn.send({ type: 'error', reason: 'not registered' });
          return;
        }
        reg.touch(entry.id);
        if (msg.type === 'channel_message' && onChannelMessage) {
          onChannelMessage(entry, { content: String(msg.content || ''), meta: msg.meta || {} });
        } else if (msg.type === 'tool_call' && onChannelTool) {
          Promise.resolve()
            .then(() => onChannelTool(entry, msg.tool, msg.args || {}))
            .then((result) => conn.send({ type: 'tool_result', callId: msg.callId, result }))
            .catch((err) => conn.send({ type: 'tool_result', callId: msg.callId, error: err.message }));
        }
      });
    },
    /** Bridge -> channel: deliver a Telegram message into the session. */
    deliver(entryId, { content, meta }) {
      const info = online.get(String(entryId));
      if (!info) return { ok: false, error: 'session_offline' };
      const sent = info.conn.send({
        type: 'deliver',
        content,
        meta: meta || {},
      });
      return sent ? { ok: true } : { ok: false, error: 'send_failed' };
    },
    isOnline(entryId) {
      return online.has(String(entryId));
    },
    onlineIds: () => [...online.keys()],
    onChannelMessage(fn) {
      onChannelMessage = fn;
    },
    onChannelTool(fn) {
      onChannelTool = fn;
    },
    close() {
      if (server) server.close();
      // Mark every session offline THROUGH handleDisconnect (fix: close()
      // used to clear `online` directly, leaving registry `connected=true`.
      // A reconnecting client's name+project match then required
      // !byName.connected, failed, and created a DUPLICATE registry entry —
      // breaking reconnect identity preservation after a Bridge restart).
      for (const entryId of [...online.keys()]) {
        try {
          handleDisconnect(entryId);
        } catch {
          /* ignore */
        }
      }
      for (const [, info] of online) {
        try {
          info.conn.destroy();
        } catch {
          /* ignore */
        }
      }
      online.clear();
      clientIndex.clear();
    },
  };
}

module.exports = { createChannelHub, CHANNEL_PROTOCOL };
