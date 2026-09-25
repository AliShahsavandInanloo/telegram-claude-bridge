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

function createChannelHub({ reg, secret, ipcsImpl, logInfo = () => {}, logWarn = () => {}, heartbeatIntervalMs, heartbeatTimeoutMs } = {}) {
  // sessionId (registry id) -> { conn, clientId, hello }
  const online = new Map();
  // clientId -> registry entry id (stable across reconnects)
  const clientIndex = new Map();

  let onChannelMessage = null; // (entry, { content, meta }) -> void
  let onChannelTool = null; // (entry, tool, args) => Promise<any>

  function findEntryForRegistration(h) {
    // 1. exact clientId rebind (reconnect of the same channel instance)
    if (clientIndex.has(h.clientId)) {
      const id = clientIndex.get(h.clientId);
      if (reg.get(id)) return reg.get(id);
      clientIndex.delete(h.clientId); // stale
    }
    // 2. name+project match (reuse an existing OFFLINE record; avoids duplicates)
    const byName = reg.getByName(h.projectName || '');
    if (byName && byName.transport === 'channel' && !byName.connected && pathsEqual(byName.project, h.project)) {
      return byName;
    }
    // 3. otherwise register a new managed session entry
    const created = reg.create({
      name: h.projectName || `chan-${(h.clientId || '').slice(0, 6)}`,
      project: h.project,
      owner: null,
    });
    if (!created.ok) {
      // name collision with a live entry: derive a unique suffix
      const alt = reg.create({
        name: `${h.projectName || 'chan'}-${Date.now().toString(36).slice(-4)}`,
        project: h.project,
        owner: null,
      });
      if (!alt.ok) return null;
      return alt.entry;
    }
    return created.entry;
  }

  function pathsEqual(a, b) {
    try {
      return path.resolve(a) === path.resolve(b);
    } catch {
      return false;
    }
  }

  function handleRegistration(conn, hello) {
    const h = hello.registration || {};
    if (!h.project || typeof h.project !== 'string') {
      conn.send({ type: 'register_nak', reason: 'registration missing project' });
      conn.destroy();
      return;
    }
    let entry = findEntryForRegistration({ clientId: hello.clientId, project: h.project, projectName: h.projectName });
    if (!entry) {
      conn.send({ type: 'register_nak', reason: 'could not register session' });
      conn.destroy();
      return;
    }
    const previous = online.get(entry.id);
    if (previous && previous.conn !== conn) {
      // A second connection claiming the same session: the newest wins (the
      // old socket is likely a zombie) but we log it — never silently split.
      logWarn(`channel: duplicate registration for ${entry.name}; replacing older connection`);
      try {
        previous.conn.destroy();
      } catch {
        /* ignore */
      }
    }
    online.set(entry.id, { conn, clientId: hello.clientId, hello: h });
    clientIndex.set(hello.clientId, entry.id);
    reg.applyChannelIdentity(entry.id, {
      channelName: h.channelName || 'telegram-bridge',
      claudeSessionId: h.claudeSessionId,
      pid: h.pid,
      claudeVersion: h.claudeVersion,
      protocol: h.protocol,
    });
    reg.setConnected(entry.id, true);
    logInfo(`channel: session "${entry.name}" online (client ${String(hello.clientId).slice(0, 8)}…)`);
    conn.send({ type: 'register_ack', sessionId: entry.id, name: entry.name, protocol: CHANNEL_PROTOCOL });
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

  // Real IPC server (null in test-injection mode). Authenticated connections
  // are handed to the hub's connection handler below.
  const server = ipcsImpl
    ? null
    : createIpcServer({
        port: 0,
        secret,
        logInfo,
        logWarn,
        heartbeatIntervalMs: heartbeatIntervalMs || undefined,
        heartbeatTimeoutMs: heartbeatTimeoutMs || undefined,
      });

  return {
    CHANNEL_PROTOCOL,
    /**
     * Start listening. cb({ port, host }) fires when ready.
     * opts: { port (STABLE configured port), heartbeatIntervalMs,
     *         heartbeatTimeoutMs, onFatal(err) for occupied port }.
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
      if (opts.onFatal && Number.isInteger(opts.port) && opts.port > 0) {
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
      for (const [, info] of online) {
        try {
          info.conn.destroy();
        } catch {
          /* ignore */
        }
      }
      online.clear();
    },
  };
}

module.exports = { createChannelHub, CHANNEL_PROTOCOL };
