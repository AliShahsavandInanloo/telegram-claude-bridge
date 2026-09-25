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
const HUB_HOST = process.env.CLAUDE_CHANNEL_HOST || '127.0.0.1';

// Lazy require so --selftest (no SDK usage) stays dependency-free.
let Server, StdioServerTransport, ListToolsRequestSchema, CallToolRequestSchema;

const clientId = crypto.randomUUID();
const protocol = 1;

// The IPC connection to the hub is managed in main() (see connectHub).

async function main() {
  if (process.argv.includes('--selftest')) {
    console.log(JSON.stringify({ ok: true, clientId, protocol, hasSecret: !!SECRET }));
    return;
  }
  if (!SECRET || SECRET.length < 16) {
    console.error('CLAUDE_CHANNEL_SECRET missing/short — refusing to start (hub auth required)');
    process.exit(1);
  }

  // MCP SDK imports (dynamic so --selftest works without side effects).
  ({ Server } = require('@modelcontextprotocol/sdk/server/index.js'));
  ({ StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js'));
  ({
    ListToolsRequestSchema,
    CallToolRequestSchema,
  } = require('@modelcontextprotocol/sdk/types.js'));

  const mcp = new Server(
    { name: 'telegram-bridge', version: '1.0.0' },
    {
      capabilities: {
        experimental: { 'claude/channel': {} }, // <- registers the channel listener
        tools: {}, // two-way channel: reply + send_file
      },
      instructions:
        'Messages from the Bridge arrive as <channel source="telegram-bridge" chat_id="..." from="..." path="...">. ' +
        'The chat_id attribute identifies the Telegram chat the message came from. ' +
        'Reply to the user with the reply tool, passing that chat_id and your answer text. ' +
        'To send a file from the current project to the user, use the send_file tool with that chat_id and the file path relative to the project root.',
    },
  );

  // ---- IPC connection to the Bridge hub ------------------------------------
  let sock = null;
  let connected = false;
  let pendingCalls = new Map();
  let callSeq = 0;

  function hubSend(obj) {
    if (!sock || sock.destroyed) return false;
    sock.write(JSON.stringify(obj) + '\n');
    return true;
  }

  function onHubMessage(msg, s) {
    if (msg.type === 'hello_ok') {
      connected = true;
      hubSend({
        type: 'register',
        registration: {
          channelName: 'telegram-bridge',
          project: process.cwd(),
          projectName: path.basename(process.cwd()),
          pid: process.pid,
          claudeSessionId: process.env.CLAUDE_SESSION_ID || null,
          claudeVersion: process.env.CLAUDE_CODE_VERSION || null,
          protocol,
        },
      });
      return;
    }
    if (msg.type === 'register_ack') {
      process.env.CLAUDE_CHANNEL_SESSION_ID = msg.sessionId;
      return;
    }
    if (msg.type === 'deliver') {
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
    if (msg.type === 'tool_result' && msg.callId && pendingCalls.has(msg.callId)) {
      const { resolve } = pendingCalls.get(msg.callId);
      pendingCalls.delete(msg.callId);
      resolve(msg.error ? { error: msg.error } : msg.result);
    }
  }

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

  function connectHub() {
    const net = require('net');
    let buf = '';
    let closed = false;
    function attempt() {
      if (closed) return;
      const s = net.connect(PORT, HUB_HOST);
      s.setEncoding('utf8');
      s.on('connect', () => {
        s.write(JSON.stringify({ type: 'hello', secret: SECRET, clientId, protocol }) + '\n');
      });
      s.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          try {
            onHubMessage(JSON.parse(line), s);
          } catch {
            /* bad frame — ignore line */
          }
        }
      });
      s.on('error', () => {});
      s.on('close', () => {
        connected = false;
        sock = null;
        if (!closed) setTimeout(attempt, 2000).unref?.();
      });
      sock = s;
    }
    attempt();
  }

  // ---- MCP tools (the reply path) -------------------------------------------

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reply',
        description:
          'Send a message back to the Telegram user through the Bridge. ' +
          'Use the chat_id from the <channel> tag of the conversation you are answering.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: { type: 'string', description: 'Telegram chat to reply in (from the channel tag)' },
            text: { type: 'string', description: 'The message to send (Markdown allowed)' },
          },
          required: ['chat_id', 'text'],
        },
      },
      {
        name: 'send_file',
        description:
          'Send a file from the current project directory to the Telegram user through the Bridge.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: { type: 'string', description: 'Telegram chat to send to' },
            file_path: { type: 'string', description: 'Path relative to the project root of the file to send' },
            caption: { type: 'string', description: 'Optional caption' },
          },
          required: ['chat_id', 'file_path'],
        },
      },
    ],
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (name === 'reply') {
      const { chat_id, text } = args || {};
      if (!chat_id || !text) {
        return { content: [{ type: 'text', text: 'error: chat_id and text are required' }], isError: true };
      }
      const callId = `c${++callSeq}`;
      const sent = hubSend({ type: 'tool_call', tool: 'reply', callId, args: { chat_id: String(chat_id), text: String(text) } });
      if (!sent) {
        return { content: [{ type: 'text', text: 'error: Bridge connection is down' }], isError: true };
      }
      const result = await new Promise((resolve) => {
        pendingCalls.set(callId, { resolve });
        setTimeout(() => {
          if (pendingCalls.has(callId)) {
            pendingCalls.delete(callId);
            resolve({ error: 'Bridge reply timed out' });
          }
        }, 15000);
      });
      if (result.error) {
        return { content: [{ type: 'text', text: `error: ${result.error}` }], isError: true };
      }
      return { content: [{ type: 'text', text: 'sent' }] };
    }
    if (name === 'send_file') {
      const { chat_id, file_path, caption } = args || {};
      if (!chat_id || !file_path) {
        return { content: [{ type: 'text', text: 'error: chat_id and file_path are required' }], isError: true };
      }
      const callId = `c${++callSeq}`;
      const sent = hubSend({
        type: 'tool_call',
        tool: 'send_file',
        callId,
        args: { chat_id: String(chat_id), file_path: String(file_path), caption: caption ? String(caption) : undefined },
      });
      if (!sent) {
        return { content: [{ type: 'text', text: 'error: Bridge connection is down' }], isError: true };
      }
      const result = await new Promise((resolve) => {
        pendingCalls.set(callId, { resolve });
        setTimeout(() => {
          if (pendingCalls.has(callId)) {
            pendingCalls.delete(callId);
            resolve({ error: 'Bridge file send timed out' });
          }
        }, 30000);
      });
      if (result.error) {
        return { content: [{ type: 'text', text: `error: ${result.error}` }], isError: true };
      }
      return { content: [{ type: 'text', text: 'file sent' }] };
    }
    return { content: [{ type: 'text', text: `error: unknown tool ${name}` }], isError: true };
  });

  await mcp.connect(new StdioServerTransport());
  connectHub();
  // Keep the event loop alive; stdio keeps it alive anyway.
  process.on('disconnect', () => process.exit(0));
}

main().catch((err) => {
  console.error('telegram-bridge channel failed:', err.message);
  process.exit(1);
});
