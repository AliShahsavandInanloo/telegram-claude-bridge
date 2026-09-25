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
   * PURE registration-target lookup (fix 1+7): inspects registry/clientIndex
   * state but NEVER mutates anything. Returns a decision the transaction
   * below executes:
   *   { action: 'rebind', entry }        — clientId already bound to this id
   *   { action: 'reuse', entry }         — offline record with same name+project
   *   { action: 'create', name }         — create a new record with this name
   *   { action: 'none', reason }         — cannot register
   */
  function findRegistrationTarget({ clientId, project, projectName }) {
    // 1. exact clientId rebind (reconnect of the same channel instance)
    if (clientIndex.has(clientId)) {
      const id = clientIndex.get(clientId);
      if (reg.get(id)) return { action: 'rebind', entry: reg.get(id) };
      clientIndex.delete(clientId); // stale binding — dropping it is index hygiene
    }
    // 2. name+project match (reuse an existing OFFLINE record; avoids duplicates)
    const byName = reg.getByName(projectName || '');
    if (byName && byName.transport === 'channel' && !byName.connected && pathsEqual(byName.project, project)) {
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
   * THE authoritative registration transaction (fixes 1, 2, 3, 7).
   *
   * Ordering invariant — a session becomes routable ONLY after:
   *   validate → PURE lookup → snapshot (pre-mutation) → stage registry
   *   mutation → persist → COMMIT (online ownership, old-conn replacement,
   *   clientIndex) → register_ack.
   *
   * Failure at any point before commit leaves:
   *   - registry exactly as the snapshot (no ghost records, no metadata drift)
   *   - online map untouched (a replaced old connection stays authoritative)
   *   - session NOT routable (never in onlineIds / isOnline / deliver)
   */
  function handleRegistration(conn, hello) {
    const h = hello.registration || {};
    if (!h.project || typeof h.project !== 'string') {
      conn.send({ type: 'register_nak', reason: 'registration missing project' });
      conn.destroy();
      return;
    }
    const decision = findRegistrationTarget({
      clientId: hello.clientId,
      project: h.project,
      projectName: h.projectName,
    });
    if (decision.action === 'none') {
      conn.send({ type: 'register_nak', reason: decision.reason || 'could not register session' });
      conn.destroy();
      return;
    }

    // SNAPSHOT BEFORE ANY MUTATION — create/rebind/reuse all happen after.
    const snap = reg.snapshot();

    // ---- stage registry mutation (rolled back on save failure) ----
    let entry = null;
    if (decision.action === 'create') {
      const created = reg.create({ name: decision.name, project: h.project, owner: null });
      if (!created.ok) {
        // No mutation happened (create failed atomically) — nothing to restore.
        conn.send({ type: 'register_nak', reason: `could not create session: ${created.error}` });
        conn.destroy();
        return;
      }
      entry = created.entry;
    } else {
      entry = decision.entry;
    }
    const replacedConn = decision.action === 'rebind' ? online.get(entry.id) : null;
    reg.applyChannelIdentity(entry.id, {
      channelName: h.channelName || 'telegram-bridge',
      claudeSessionId: h.claudeSessionId,
      pid: h.pid,
      claudeVersion: h.claudeVersion,
      protocol: h.protocol,
    });
    reg.setConnected(entry.id, true);

    // ---- persist, then commit ----
    Promise.resolve()
      .then(() => reg.save())
      .then(() => {
        // COMMIT: active connection ownership swaps only now. A replaced old
        // connection is destroyed AFTER the replacement is durable, so a
        // failed save can never leave the session without a healthy conn.
        online.set(entry.id, { conn, clientId: hello.clientId, hello: h });
        clientIndex.set(hello.clientId, entry.id);
        if (replacedConn && replacedConn.conn !== conn) {
          logInfo(`channel: promoting new connection for "${entry.name}"; retiring old socket`);
          try {
            replacedConn.conn.destroy(); // fires its close handler; no longer owns the entry
          } catch {
            /* ignore */
          }
        }
        logInfo(`channel: session "${entry.name}" online (client ${String(hello.clientId).slice(0, 8)}…)`);
        conn.send({ type: 'register_ack', sessionId: entry.id, name: entry.name, protocol: CHANNEL_PROTOCOL });
      })
      .catch((err) => {
        logError(`channel registration persistence failed for "${entry.name}": ${err.message}; rolling back`);
        reg.restore(snap); // exact pre-registration state — including any create
        // online map was NEVER touched: an existing healthy connection stays
        // authoritative; a new registration simply never became routable.
        conn.send({ type: 'register_nak', reason: 'registry persistence failed — registration rolled back' });
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
