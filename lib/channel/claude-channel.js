#!/usr/bin/env node
'use strict';

/**
 * telegram-bridge channel server for Claude Code.
 *
 * This is the CUSTOM CLAUDE CODE CHANNEL: an MCP server that Claude Code
 * spawns as a subprocess (stdio transport). It:
 *
 *   - declares capabilities.experimental['claude/channel'] so Claude Code
 *     registers a notification listener (per the official channels contract,
 *     code.claude.com/docs/en/channels-reference)
 *   - emits notifications/claude/channel events so Telegram messages appear
 *     natively in the live session (rendered "← telegram-bridge · message")
 *   - exposes the standard MCP tools `reply` and `send_file` which Claude
 *     calls to answer through the Bridge's Telegram client
 *   - maintains an authenticated localhost IPC connection to the Bridge hub,
 *     receiving `deliver` frames and turning them into channel notifications
 *
 * IPC: uses THE shared framed client from lib/channel/ipc.js — one
 * authoritative protocol implementation (framing, frame cap, ping/pong,
 * bounded exponential backoff 2s→4s→8s→15s cap, reset after a healthy
 * authenticated session). It previously kept its own raw net.connect()
 * that never answered ping frames, so the hub's heartbeat timeout dropped
 * idle sessions into a reconnect loop.
 *
 * SECURITY: this process connects ONLY to the Bridge hub on 127.0.0.1 and
 * authenticates with the hub's random secret (CLAUDE_CHANNEL_SECRET,
 * delivered via the spawn environment by the bridge's launcher, or via
 * --secret for manual setups). It cannot talk to Telegram directly — every
 * outbound message goes through the Bridge, which enforces the allowlist,
 * chat mapping and chunking. No shell is ever executed.
 *
 * Usage (research preview requires the development flag):
 *   CLAUDE_CHANNEL_SECRET=<secret> CLAUDE_CHANNEL_PORT=<port> \
 *   claude --dangerously-load-development-channels server:telegram-bridge
 *
 * Registered in the project's .mcp.json as:
 *   { "mcpServers": { "telegram-bridge": {
 *       "command": "node",
 *       "args": ["<bridge>/lib/channel/claude-channel.js"] } } }
 */

const crypto = require('crypto');
const path = require('path');

const PORT = parseInt(process.env.CLAUDE_CHANNEL_PORT || '0', 10);
const SECRET = process.env.CLAUDE_CHANNEL_SECRET || '';
// Loopback only — the hub never binds publicly and this client never dials
// anything but 127.0.0.1 (the variable exists for symmetry/testing only).
const HUB_HOST = '127.0.0.1';

const clientId = crypto.randomUUID();
const protocol = 1;

/** meta keys must be identifiers ([A-Za-z0-9_]) per the channels contract. */
function sanitizeMeta(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta || {})) {
    if (/^[A-Za-z0-9_]+$/.test(k) && v !== undefined && v !== null) {
      out[k] = String(v);
    }
  }
  return out;
}

/**
 * Shared hub link — THE production IPC client (lib/channel/ipc.js).
 * Handles: hello auth, ping→pong, lastSeen, bounded exponential backoff with
 * reset after a healthy session, frame size caps, malformed-frame teardown.
 */
/**
 * Logical connection state machine (fix 6 + re-registration fix):
 *
 *   disconnected → connecting → authenticated (hello_ok)
 *   → registered (register_ack) — the ONLY "usable" state.
 *
 * Any disconnect drops straight back to disconnected. EVERY authenticated
 * (re)connect sends a fresh `register` — previously the registration callback
 * was one-shot, so after a Bridge restart the client reconnected at the
 * TCP/auth level but the hub never saw the session come back online.
 */
function createHubLink({ port, secret, id = clientId, logInfo = () => {}, logWarn = () => {}, onReady }) {
  const { createIpcClient } = require('./ipc');
  const link = createIpcClient({ port, secret, clientId: id, logInfo, logWarn });
  let state = 'disconnected'; // disconnected | connecting | authenticated | registered
  let onMessageExternal = null;
  let closeExternal = null;

  function buildRegistration() {
    return {
      channelName: 'telegram-bridge',
      project: process.cwd(),
      projectName: path.basename(process.cwd()),
      pid: process.pid,
      claudeSessionId: process.env.CLAUDE_SESSION_ID || null,
      claudeVersion: process.env.CLAUDE_CODE_VERSION || null,
      protocol,
    };
  }

  // start() fires on every hello_ok (every authenticated connection).
  link.start(() => {
    state = 'authenticated';
    link.send({ type: 'register', registration: buildRegistration() });
  });

  // Any socket loss drops the state machine back to disconnected — the
  // session is unusable from the instant the connection dies, never only
  // when close() is called locally.
  link.onClose(() => {
    state = 'disconnected';
  });

  link.onMessage((msg) => {
    if (msg && msg.type === 'register_ack') {
      state = 'registered';
      process.env.CLAUDE_CHANNEL_SESSION_ID = msg.sessionId;
      if (onReady) onReady(msg);
      return;
    }
    if (msg && msg.type === 'register_nak') {
      state = 'authenticated'; // authed but NOT registered — never treated usable
      logWarn(`hub refused registration: ${msg.reason || 'unknown reason'}`);
      return;
    }
    if (onMessageExternal) onMessageExternal(msg);
  });

  return {
    send(obj) {
      return link.send(obj);
    },
    onMessage(fn) {
      onMessageExternal = fn;
    },
    onClose(fn) {
      closeExternal = fn;
    },
    /** TCP-level socket state (NOT usable for channel traffic). */
    get socketConnected() {
      return link.isConnected();
    },
    /** hello_ok received but registration may still be pending. */
    get authenticated() {
      return state === 'authenticated' || state === 'registered';
    },
    /** register_ack received — the only state in which the channel is usable. */
    get registered() {
      return state === 'registered';
    },
    /** Usable for channel traffic: full handshake complete on the CURRENT connection. */
    get isConnected() {
      return state === 'registered' && link.isConnected();
    },
    close() {
      state = 'disconnected';
      link.close();
    },
  };
}

/**
 * MCP tool definitions + handlers. delivery_id is the PRIMARY reply route:
 * the Bridge resolves delivery_id → original chat → owning session, so a
 * delayed reply still lands after the user /switch'ed away (fix 4).
 * chat_id remains only as a DEPRECATED fallback restricted to the session's
 * CURRENT attachment.
 */
function buildToolSchemas() {
  return [
    {
      name: 'reply',
      description:
        'Send a message back to the Telegram user through the Bridge. ' +
        'PREFERRED: pass delivery_id from the <channel> tag metadata of the message you are answering — ' +
        'the Bridge resolves the destination chat and keeps the reply authorized even if the user switched sessions. ' +
        'Do NOT invent delivery IDs. The legacy chat_id argument is deprecated: it only works while your session ' +
        'is the chat\'s currently attached session.',
      inputSchema: {
        type: 'object',
        properties: {
          delivery_id: { type: 'string', description: 'Delivery ID from the channel tag meta (preferred — use this)' },
          chat_id: { type: 'string', description: 'DEPRECATED fallback: Telegram chat id; only valid while your session is currently attached to that chat' },
          text: { type: 'string', description: 'The message to send (Markdown allowed)' },
        },
        required: ['text'],
      },
    },
    {
      name: 'send_file',
      description:
        'Send a file from the current project directory to the Telegram user through the Bridge. ' +
        'Prefer delivery_id (from the channel tag meta) to address the conversation; chat_id is a deprecated fallback. ' +
        'The path must be project-relative; the Bridge rejects anything resolving outside the project.',
      inputSchema: {
        type: 'object',
        properties: {
          delivery_id: { type: 'string', description: 'Delivery ID from the channel tag meta (preferred)' },
          chat_id: { type: 'string', description: 'DEPRECATED fallback: Telegram chat id' },
          file_path: { type: 'string', description: 'Path relative to the project root of the file to send' },
          caption: { type: 'string', description: 'Optional caption' },
        },
        required: ['file_path'],
      },
    },
  ];
}

/**
 * Tool call handler used by the MCP CallTool route. `hubSend` forwards a
 * {type:'tool_call', tool, callId, args} frame to the hub and the matching
 * tool_result resolves the returned promise. Kept separate from stdio so
 * tests can exercise the REAL schema/handler wiring without a TTY.
 */
function createToolHandler({ hubSend }) {
  const pendingCalls = new Map();
  let callSeq = 0;

  function callHub(tool, args, timeoutMs, timeoutError) {
    const callId = `c${++callSeq}`;
    const sent = hubSend({ type: 'tool_call', tool, callId, args });
    if (!sent) return Promise.resolve({ error: 'Bridge connection is down' });
    return new Promise((resolve) => {
      pendingCalls.set(callId, { resolve });
      setTimeout(() => {
        if (pendingCalls.has(callId)) {
          pendingCalls.delete(callId);
          resolve({ error: timeoutError });
        }
      }, timeoutMs);
    });
  }

  function handleHubResult(msg) {
    if (msg && msg.type === 'tool_result' && msg.callId && pendingCalls.has(msg.callId)) {
      const { resolve } = pendingCalls.get(msg.callId);
      pendingCalls.delete(msg.callId);
      resolve(msg.error ? { error: msg.error } : msg.result);
      return true;
    }
    return false;
  }

  async function callTool(name, args) {
    args = args || {};
    if (name === 'reply') {
      const { delivery_id: deliveryId, chat_id: chatId, text } = args;
      if (!text) {
        return { content: [{ type: 'text', text: 'error: text is required' }], isError: true };
      }
      if (!deliveryId && !chatId) {
        return {
          content: [{ type: 'text', text: 'error: delivery_id is required (take it from the channel tag meta of the message you are answering)' }],
          isError: true,
        };
      }
      const fwd = { text: String(text) };
      if (deliveryId) fwd.delivery_id = String(deliveryId);
      if (chatId) fwd.chat_id = String(chatId); // deprecated fallback — Bridge restricts it
      const result = await callHub('reply', fwd, 15000, 'Bridge reply timed out');
      if (result.error) {
        return { content: [{ type: 'text', text: `error: ${result.error}` }], isError: true };
      }
      return { content: [{ type: 'text', text: 'sent' }] };
    }
    if (name === 'send_file') {
      const { delivery_id: deliveryId, chat_id: chatId, file_path: filePath, caption } = args;
      if (!filePath) {
        return { content: [{ type: 'text', text: 'error: file_path is required' }], isError: true };
      }
      if (!deliveryId && !chatId) {
        return {
          content: [{ type: 'text', text: 'error: delivery_id is required (take it from the channel tag meta)' }],
          isError: true,
        };
      }
      const fwd = { file_path: String(filePath) };
      if (deliveryId) fwd.delivery_id = String(deliveryId);
      if (chatId) fwd.chat_id = String(chatId);
      if (caption) fwd.caption = String(caption);
      const result = await callHub('send_file', fwd, 30000, 'Bridge file send timed out');
      if (result.error) {
        return { content: [{ type: 'text', text: `error: ${result.error}` }], isError: true };
      }
      return { content: [{ type: 'text', text: 'file sent' }] };
    }
    return { content: [{ type: 'text', text: `error: unknown tool ${name}` }], isError: true };
  }

  return { callTool, handleHubResult };
}

const CHANNEL_INSTRUCTIONS =
  'Messages from the Bridge arrive as <channel source="telegram-bridge" chat_id="..." delivery_id="..." from="..." path="...">. ' +
  'To reply, call the reply tool with the delivery_id from that tag\'s metadata and your answer text — the Bridge resolves ' +
  'the destination and keeps the reply authorized even if the user switched sessions. Do NOT invent delivery IDs. ' +
  'The chat_id attribute is a deprecated fallback that only works while your session is the chat\'s currently attached session. ' +
  'To send a file from the current project, use the send_file tool with delivery_id and a project-relative file path.';

async function main() {
  if (process.argv.includes('--selftest')) {
    console.log(JSON.stringify({ ok: true, clientId, protocol, hasSecret: !!SECRET }));
    return;
  }
  if (!SECRET || SECRET.length < 16) {
    console.error('CLAUDE_CHANNEL_SECRET missing/short — refusing to start (hub auth required)');
    process.exit(1);
  }
  if (!PORT) {
    console.error('CLAUDE_CHANNEL_PORT missing — refusing to start (need the hub\'s stable loopback port)');
    process.exit(1);
  }

  // MCP SDK imports (dynamic so --selftest works without side effects).
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  const {
    ListToolsRequestSchema,
    CallToolRequestSchema,
  } = require('@modelcontextprotocol/sdk/types.js');

  const mcp = new Server(
    { name: 'telegram-bridge', version: '1.0.0' },
    {
      capabilities: {
        experimental: { 'claude/channel': {} }, // <- registers the channel listener
        tools: {}, // two-way channel: reply + send_file
      },
      instructions: CHANNEL_INSTRUCTIONS,
    },
  );

  // ---- IPC connection to the Bridge hub (shared client) ---------------------
  const hub = createHubLink({
    port: PORT,
    host: HUB_HOST,
    secret: SECRET,
    logInfo: (m) => console.error(`[channel] ${m}`),
    logWarn: (m) => console.error(`[channel] ${m}`),
  });

  const tools = createToolHandler({
    hubSend: (obj) => hub.send(obj),
  });
  hub.onMessage((msg) => {
    if (msg && msg.type === 'deliver') {
      // Push the Telegram message into the live session as a channel event.
      mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: String(msg.content || ''),
          meta: sanitizeMeta(msg.meta || {}),
        },
      }).catch(() => {});
      return;
    }
    tools.handleHubResult(msg);
  });

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: buildToolSchemas() }));
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => tools.callTool(req.params.name, req.params.arguments));

  await mcp.connect(new StdioServerTransport());
  // Keep the event loop alive; stdio keeps it alive anyway.
  process.on('disconnect', () => process.exit(0));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('telegram-bridge channel failed:', err.message);
    process.exit(1);
  });
}

module.exports = {
  sanitizeMeta,
  createHubLink,
  buildToolSchemas,
  createToolHandler,
  CHANNEL_INSTRUCTIONS,
};
