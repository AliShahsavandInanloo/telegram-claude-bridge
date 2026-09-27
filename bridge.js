#!/usr/bin/env node
/**
 * Telegram <-> Claude Code bridge
 * -------------------------------
 * Polls Telegram for messages (long polling), forwards each allowed user's
 * message as the prompt to a persistent `claude -p` session, and replies with
 * the result.
 *
 * Security: authorization is FAIL CLOSED — ALLOWED_TELEGRAM_IDS must list the
 * permitted Telegram user IDs; Claude runs with --dangerously-skip-permissions.
 *
 * Proxy support (no hard-coded infrastructure, VPN can be toggled freely):
 *   1. TELEGRAM_PROXY_URL in .env (socks5:// or http(s)://)
 *   2. HTTPS_PROXY / HTTP_PROXY / ALL_PROXY environment variables
 *   3. Windows system proxy (read live from the registry)
 *   4. Direct connection
 * Bot API calls go through https.request so http/socks proxy agents actually
 * apply (built-in fetch would silently ignore them).
 *
 * Telegram update delivery is AT-MOST-ONCE: the next offset is persisted
 * before an update is handled, so a crash can skip an update but never
 * re-execute one. First-ever start also skips stale backlog by default
 * (PROCESS_INITIAL_BACKLOG=false) instead of executing offline messages.
 *
 * Commands: /start /help /new /sessions /use /stop /queue /status
 * (registered with Telegram via setMyCommands for slash autocomplete)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { createTelegramClient } = require('./lib/telegram');
const { createSessionStore } = require('./lib/sessions');
const { createJobQueue } = require('./lib/queue');
const { createOffsetStore } = require('./lib/offset');
const { BOT_COMMANDS, parseCommand, helpText } = require('./lib/commands');
const { createRegistry } = require('./lib/claude/registry');
const { createClaudeManager } = require('./lib/claude/manager');
const { createProgressReporter } = require('./lib/claude/output');
const { discoverClaudeProcesses } = require('./lib/claude/discover');
const { createChannelHub } = require('./lib/channel/hub');
const { createDeliveryStore } = require('./lib/channel/deliveries');
const { createIpcServer, validateHeartbeatConfig } = require('./lib/channel/ipc');
const { resolveProjectFile, resolveUploadDest, ensureUploadDir } = require('./lib/claude/files');
const { spawn: spawnRaw } = require('child_process');
const {
  parseAllowlist,
  intEnv,
  validateProxyUrl,
  validateBotToken,
  ensureWritableDir,
  validateBridgeCwd,
  resolveClaudeLaunch,
  applyEnvFile,
  safeClaudeLabel,
} = require('./lib/config');

// ---------------------------------------------------------------------------
// .env loading (BEFORE any config value is derived from the environment)
// ---------------------------------------------------------------------------

const ROOT = __dirname;
applyEnvFile(ROOT); // real environment variables take precedence over .env

// ---------------------------------------------------------------------------
// Logging (levels; never log tokens, prompts, proxy credentials)
// ---------------------------------------------------------------------------

const DEBUG = /^(1|true|yes)$/i.test(process.env.BRIDGE_DEBUG || '');

function logInfo(...args) {
  console.log(new Date().toISOString(), '[info]', ...args);
}
function logWarn(...args) {
  console.error(new Date().toISOString(), '[warn]', ...args);
}
function logError(...args) {
  console.error(new Date().toISOString(), '[error]', ...args);
}
function logDebug(...args) {
  if (DEBUG) console.log(new Date().toISOString(), '[debug]', ...args);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function failStartup(message) {
  logError('refusing to start:', message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Configuration validation (fail closed, before anything else)
// ---------------------------------------------------------------------------

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_CLAUDE_BOT_TOKEN || '').trim();

const tokenCheck = validateBotToken(BOT_TOKEN);
if (!tokenCheck.ok) failStartup(tokenCheck.error);

const allowCheck = parseAllowlist(process.env.ALLOWED_TELEGRAM_IDS);
if (!allowCheck.ok) failStartup(`${allowCheck.error}. Set it to your numeric Telegram user ID(s) (comma-separated; get yours from @userinfobot). Claude runs with full machine access, so the bridge must know exactly who may talk to it.`);
const ALLOWED = allowCheck.ids; // Set<string> — never logged or echoed

const proxyCheck = validateProxyUrl(process.env.TELEGRAM_PROXY_URL);
if (!proxyCheck.ok) failStartup(proxyCheck.error);
const EXPLICIT_PROXY = proxyCheck.url || '';

const timeoutCheck = intEnv(process.env.CLAUDE_TIMEOUT_MS, { name: 'CLAUDE_TIMEOUT_MS', def: 30 * 60 * 1000, min: 5000, max: 4 * 60 * 60 * 1000 });
if (!timeoutCheck.ok) failStartup(timeoutCheck.error);
const CLAUDE_TIMEOUT_MS = timeoutCheck.value;

const queueLimitCheck = intEnv(process.env.MAX_QUEUE_PER_CHAT, { name: 'MAX_QUEUE_PER_CHAT', def: 3, min: 1, max: 100 });
if (!queueLimitCheck.ok) failStartup(queueLimitCheck.error);
const MAX_QUEUE_PER_CHAT = queueLimitCheck.value;

const maxOutCheck = intEnv(process.env.MAX_STDOUT_BYTES, { name: 'MAX_STDOUT_BYTES', def: 512 * 1024, min: 1024, max: 8 * 1024 * 1024 });
if (!maxOutCheck.ok) failStartup(maxOutCheck.error);
const MAX_STDOUT_BYTES = maxOutCheck.value;

const maxErrCheck = intEnv(process.env.MAX_STDERR_BYTES, { name: 'MAX_STDERR_BYTES', def: 64 * 1024, min: 1024, max: 1024 * 1024 });
if (!maxErrCheck.ok) failStartup(maxErrCheck.error);
const MAX_STDERR_BYTES = maxErrCheck.value;

// First-start Telegram backlog policy. Safe default: SKIP all pending updates
// on the very first run (no offset file yet) so historical messages sent while
// the bridge was offline are never executed. Set PROCESS_INITIAL_BACKLOG=true
// to opt in to consuming them on first start.
const PROCESS_INITIAL_BACKLOG = /^(1|true|yes)$/i.test(process.env.PROCESS_INITIAL_BACKLOG || '');

const STATE_DIR = process.env.BRIDGE_STATE_DIR || path.join(ROOT, 'state');
const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
const OFFSET_FILE = path.join(STATE_DIR, 'offset.txt');
const REGISTRY_FILE = path.join(STATE_DIR, 'claude-sessions.json');
const INCOMING_DIR = path.join(STATE_DIR, 'incoming');

// Managed-session task timeout and streaming cadence (distinct from the
// legacy one-shot job timeout). Defaults keep long analyses alive for hours.
const taskTimeoutCheck = intEnv(process.env.MANAGED_TASK_TIMEOUT_MS, { name: 'MANAGED_TASK_TIMEOUT_MS', def: 4 * 60 * 60 * 1000, min: 10000, max: 24 * 60 * 60 * 1000 });
if (!taskTimeoutCheck.ok) failStartup(taskTimeoutCheck.error);
const MANAGED_TASK_TIMEOUT_MS = taskTimeoutCheck.value;
const PROGRESS_MIN_INTERVAL_MS = 15_000; // anti-spam: >= 15 s between progress sends
const TELEGRAM_FILE_MAX_BYTES = 20 * 1024 * 1024; // Bot API download cap for this bridge

// Channel hub secret: random per bridge install, stored 0600 in the state dir.
// NEVER the bot token or any API credential.
const CHANNEL_SECRET_FILE = path.join(STATE_DIR, 'channel-secret');
function loadOrCreateChannelSecret() {
  try {
    const existing = fs.readFileSync(CHANNEL_SECRET_FILE, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* first run */
  }
  const secret = require('crypto').randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(CHANNEL_SECRET_FILE, secret + '\n', { mode: 0o600 });
  } catch (err) {
    failStartup(`cannot write channel secret: ${err.message}`);
  }
  return secret;
}
// STARTUP ORDER (fix 4): the secret is LOADED only AFTER ensureWritableDir
// below has created/validated STATE_DIR. The old order created channel-secret
// before the state dir existed, so a fresh clone failed at secret creation.
let CHANNEL_SECRET = null; // assigned right after the dir check
let hubPort = 0; // set when the channel hub starts listening

// Stable Channel endpoint (fix 1): the hub MUST bind the same port across
// Bridge restarts, or already-running channel clients reconnect to a dead
// endpoint forever. Default 8765; configurable; ephemeral (0) is refused.
const chanPortCheck = intEnv(process.env.CLAUDE_CHANNEL_PORT, { name: 'CLAUDE_CHANNEL_PORT', def: 8765, min: 1024, max: 65535 });
if (!chanPortCheck.ok) failStartup(chanPortCheck.error);
const CHANNEL_PORT = chanPortCheck.value;

function parseOptionalInt(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
  const n = parseInt(String(raw).trim(), 10);
  return Number.isNaN(n) ? undefined : n;
}
const hbCheck = validateHeartbeatConfig(
  parseOptionalInt(process.env.CLAUDE_CHANNEL_HEARTBEAT_MS),
  parseOptionalInt(process.env.CLAUDE_CHANNEL_HEARTBEAT_TIMEOUT_MS),
);
if (!hbCheck.ok) failStartup(hbCheck.error);

const dirCheck = ensureWritableDir(STATE_DIR);
if (!dirCheck.ok) failStartup(dirCheck.error);
// State dir is writable — now (and only now) load or create the hub secret.
CHANNEL_SECRET = loadOrCreateChannelSecret();

const claudeCheck = resolveClaudeLaunch(process.env.CLAUDE_BIN || 'claude');
if (!claudeCheck.ok) failStartup(claudeCheck.error);
const CLAUDE_LAUNCH = { command: claudeCheck.command, prefixArgs: claudeCheck.prefixArgs };
const claudeDisplay = safeClaudeLabel(claudeCheck.prefixArgs.length ? claudeCheck.prefixArgs[0] : claudeCheck.command); // basename only — no paths over Telegram

const cwdCheck = validateBridgeCwd(process.env.BRIDGE_CWD || ROOT);
if (!cwdCheck.ok) failStartup(cwdCheck.error);
const DEFAULT_CWD = cwdCheck.resolved;

// ---------------------------------------------------------------------------
// Stores, queue, Telegram client
// ---------------------------------------------------------------------------

let tg = createTelegramClient({ token: BOT_TOKEN, explicitProxy: EXPLICIT_PROXY, log: logInfo });

const store = createSessionStore(SESSIONS_FILE);
const offsetStore = createOffsetStore(OFFSET_FILE);
const registry = createRegistry(REGISTRY_FILE);

// Managed-session spawn seam: tests replace this to avoid real processes.
let managedSpawnFn = spawn;
const claudeManager = createClaudeManager({
  reg: registry,
  launch: CLAUDE_LAUNCH,
  spawnFn: (...a) => managedSpawnFn(...a),
  logInfo,
  logError: logError,
});

// Channel hub: authenticated localhost IPC for Channel-enabled Claude sessions.
// The STABLE port is part of the hub's construction config (fix: it previously
// lived only in listen() opts while the server was built with port 0, so the
// configured value never reached the socket and reconnect-after-restart broke).
const channelHub = createChannelHub({
  reg: registry,
  secret: CHANNEL_SECRET,
  port: CHANNEL_PORT,
  heartbeatIntervalMs: hbCheck.intervalMs,
  heartbeatTimeoutMs: hbCheck.timeoutMs,
  logInfo,
  logWarn,
  logError,
});

// ---------------------------------------------------------------------------
// Delivery-scoped reply authorization
//
// Every Telegram message routed to a Channel session creates a delivery
// record. The reply tool resolves delivery_id -> {chatId, sessionId}; the
// session that OWNS the delivery may reply to the ORIGINAL chat even if the
// user has since /switch'ed to another session. Legacy reply(chat_id, text)
// remains only for the CURRENT attachment (deprecated, documented).
//
// The store is PERSISTED (state/deliveries.json, atomic writes, TTL purge,
// bounded size) so a delivery_id still resolves after a Bridge restart —
// the main long-running-session use case (fix 5). Only routing metadata is
// persisted; never the message text.
// ---------------------------------------------------------------------------

const DELIVERIES_FILE = path.join(STATE_DIR, 'deliveries.json');
const deliveryStore = createDeliveryStore(DELIVERIES_FILE, { ttlMs: 6 * 60 * 60 * 1000, maxEntries: 1000 });
deliveryStore.load(); // purge expired records from any previous run

function createDelivery(chatId, sessionId, telegramMessageId = null) {
  const id = deliveryStore.create({ chatId, sessionId, telegramMessageId });
  try {
    deliveryStore.save();
  } catch (err) {
    // The delivery already exists in memory; persistence failure only loses
    // post-restart replyability for THIS message, never routes it elsewhere.
    logError(`delivery persist failed (in-memory only): ${err.message}`);
  }
  return id;
}

function resolveDelivery(deliveryId, { forSessionId = null } = {}) {
  return deliveryStore.resolve(deliveryId, { forSessionId });
}

/**
 * Deliver a Telegram message to a Channel session as a channel event (the
 * message appears natively in the live Claude Code conversation).
 * Creates a delivery record and passes delivery_id in the channel meta so
 * replies stay authorized even after /switch (fix 4).
 */
function deliverToSession(chatId, entry, text, extraMeta = {}, { userId = '', messageId = null } = {}) {
  registry.touch(entry.id);
  if (entry.transport === 'channel' && channelHub.isOnline(entry.id)) {
    const deliveryId = createDelivery(chatId, entry.id);
    return channelHub.deliver(entry.id, {
      content: text,
      meta: {
        chat_id: String(chatId),
        delivery_id: deliveryId,
        from: 'telegram',
        user_id: String(userId || ''),
        ...(messageId ? { message_id: String(messageId) } : {}),
        ...extraMeta,
      },
    });
  }
  return { ok: false, error: 'session_offline' };
}

// ---------------------------------------------------------------------------
// Bounded stream capture (never let a chatty child consume memory)
// ---------------------------------------------------------------------------

function boundedCapture(limit) {
  let buf = Buffer.alloc(0);
  let truncated = false;
  return {
    push(chunk) {
      const c = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buf.length + c.length > limit) {
        truncated = true;
        const space = limit - buf.length;
        if (space > 0) buf = Buffer.concat([buf, c.subarray(0, space)]);
      } else {
        buf = Buffer.concat([buf, c]);
      }
      // NOTE: we keep consuming; excess is discarded, so the child never blocks.
    },
    get text() {
      return buf.toString('utf8');
    },
    get truncated() {
      return truncated;
    },
  };
}

// ---------------------------------------------------------------------------
// Claude job execution (one-shot completion; spawn, never shell)
// ---------------------------------------------------------------------------

let currentRun = null; // { chatId, job, child, startedAt, cancelled, cancelReason, cancel } | null

function buildClaudeArgs(job) {
  // The user's text IS the prompt (-p <text>). Never built via a shell string.
  const args = ['-p', job.text, '--output-format', 'text', '--dangerously-skip-permissions'];
  // Session identity (job.sessionId) is fixed at enqueue time. The initialized
  // flag may only advance, so we re-check it for this exact id just before spawn:
  // an earlier queued job may have completed and made the session resumable.
  const entry = store.get(job.chatId, job.sessionName);
  const resumable = job.initialized || (entry && entry.id === job.sessionId && entry.initialized);
  if (resumable) args.push('--resume', job.sessionId);
  else args.push('--session-id', job.sessionId);
  return args;
}

function runClaudeJob(chatId, job, { spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    const args = buildClaudeArgs(job);
    const started = Date.now();
    logInfo(`job start chat=${chatId} session=${job.sessionName} id=${job.sessionId} resume=${args.includes('--resume')} bytes=${Buffer.byteLength(job.text, 'utf8')}`);

    let finished = false;
    let cancelled = false;
    let cancelReason = null;
    let timer = null;
    let killTimer = null;

    const stdoutCap = boundedCapture(MAX_STDOUT_BYTES);
    const stderrCap = boundedCapture(MAX_STDERR_BYTES);

    const child = spawnFn(CLAUDE_LAUNCH.command, [...CLAUDE_LAUNCH.prefixArgs, ...args], {
      cwd: job.cwd,
      env: process.env, // inherits ANTHROPIC_BASE_URL / provider relay config
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    currentRun = { chatId, job, child, startedAt: started, cancelled: false, cancelReason: null };

    function cancel(reason) {
      if (finished || cancelled) return;
      cancelled = true;
      cancelReason = reason;
      currentRun.cancelled = true;
      currentRun.cancelReason = reason;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 5000);
      if (killTimer.unref) killTimer.unref();
    }
    currentRun.cancel = cancel; // /stop uses this to cancel the active job

    function finishOnce(reportFn) {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reportFn();
    }

    timer = setTimeout(() => cancel('timeout'), CLAUDE_TIMEOUT_MS);
    if (timer.unref) timer.unref();

    child.stdout.on('data', (d) => stdoutCap.push(d));
    child.stderr.on('data', (d) => stderrCap.push(d));

    // Spawn failures (ENOENT etc.) — 'close' may or may not follow; the guard
    // ensures whichever arrives first completes the job exactly once.
    child.on('error', (err) => {
      finishOnce(() => {
        logError(`job spawn error chat=${chatId}:`, err.message);
        currentRun = null;
        resolve();
        reply(chatId, `❌ Could not run Claude (${claudeDisplay}): ${err.message}`).catch(() => {});
      });
    });

    child.on('close', (code, signal) => {
      finishOnce(async () => {
        const secs = Math.round((Date.now() - started) / 1000);
        logInfo(`job done chat=${chatId} session=${job.sessionName} code=${code} signal=${signal || '-'} in ${secs}s out=${stdoutCap.text.length}B`);
        currentRun = null;

        let persistError = null;
        if (code === 0 && !cancelled) {
          // Session is now real on Claude's side. Policy: mark initialized and
          // persist; if persistence FAILS the initialized flag is rolled back
          // (targeted — unrelated session changes made while the job ran are
          // kept) so the next job re-creates the session with --session-id
          // instead of blindly resuming state that was never durably recorded.
          const entryBefore = store.get(chatId, job.sessionName);
          const prevInit = entryBefore && entryBefore.id === job.sessionId ? entryBefore.initialized : undefined;
          store.markInitialized(chatId, job.sessionId);
          try {
            await store.save();
          } catch (err) {
            const e = store.get(chatId, job.sessionName);
            if (e && e.id === job.sessionId && prevInit !== undefined) e.initialized = prevInit;
            persistError = err;
            logWarn(`could not persist session state: ${err.message}`);
          }
        }

        let header;
        if (cancelled) {
          header = `🛑 *${job.sessionName}* — job cancelled (${cancelReason}) after ${secs}s`;
        } else {
          header = `🤖 *${job.sessionName}* — done in ${secs}s`;
          if (code !== 0) header += ` (exit ${code})`;
        }
        if (persistError) header += '\n⚠️ (session state not saved to disk)';

        let body = stdoutCap.text.trim();
        if (!body && stderrCap.text.trim()) body = `stderr:\n${stderrCap.text.trim()}`;
        if (stdoutCap.truncated) body += `\n\n_(stdout truncated at ${MAX_STDOUT_BYTES} bytes)_`;
        if (stderrCap.truncated) body += `\n\n_(stderr truncated at ${MAX_STDERR_BYTES} bytes)_`;
        if (!body.trim() || body.trim() === 'stderr:') body = '_(no output)_';

        try {
          await reply(chatId, `${header}\n\n${body}`);
        } catch (err) {
          logError('failed to deliver report:', err.message);
        }
        resolve();
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Job queue (global FIFO across chats)
// ---------------------------------------------------------------------------

const claudeRunner = { run: (chatId, job) => runClaudeJob(chatId, job) }; // swappable for tests

const queue = createJobQueue({
  maxPerChat: MAX_QUEUE_PER_CHAT,
  runJob: (chatId, job) => claudeRunner.run(chatId, job),
});

// ---------------------------------------------------------------------------
// Telegram sends (centralized, chunked, safe)
// ---------------------------------------------------------------------------

const CHUNK_LIMIT = 3800;

async function sendChunk(chatId, text) {
  try {
    await tg.request('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  } catch {
    // Markdown parse errors: fall back to plain text.
    try {
      await tg.request('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
    } catch (err2) {
      logWarn(`sendMessage to chat ${chatId} failed: ${err2.message}`);
    }
  }
}

/** Chunked reply; never throws (failures are logged). */
async function reply(chatId, text) {
  const { label, source } = tg.state();
  const full = label !== 'direct' && source
    ? `[_proxy: ${label}_]\n\n${text}`
    : text;
  for (let i = 0; i < full.length; i += CHUNK_LIMIT) {
    await sendChunk(chatId, full.slice(i, i + CHUNK_LIMIT));
    if (i + CHUNK_LIMIT < full.length) await sleep(400);
  }
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function formatUptime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(s)}s`;
}

function statusText(chatId) {
  const { label, source } = tg.state();
  const active = store.active(chatId);
  const info = queue.info(chatId);
  const runningMine = currentRun && currentRun.chatId === chatId
    ? `*${currentRun.job.sessionName}* (${Math.round((Date.now() - currentRun.startedAt) / 1000)}s${currentRun.cancelled ? ', cancelling…' : ''})`
    : (currentRun ? `busy with another chat's job` : 'none');
  return [
    `Claude: *${claudeDisplay}*`,
    `Active session: *${active.name}* (${active.session.initialized ? 'initialized' : 'new'})`,
    `Running job: ${runningMine}`,
    `Queue: ${info.mineQueued} in this chat, ${info.totalQueued} total`,
    `Proxy: *${label}* [${source || 'direct'}]`,
    `Uptime: ${formatUptime(process.uptime())}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Managed-session helpers (routing, formatting, files)
// ---------------------------------------------------------------------------
// (fix 5: msgUserId global removed — Telegram user identity is passed
// explicitly through handleMessage -> routing/commands/file-upload params)

/** Privacy: project paths are shown basename-only over Telegram. */
function projectLabel(projectPath) {
  const base = path.basename(String(projectPath || ''));
  return base || '(project)';
}

/** Resolve a /attach|/switch argument: 1-based number or exact name. */
function resolveSessionArg(arg) {
  const list = claudeManager.list();
  const n = Number(String(arg || '').trim());
  if (Number.isInteger(n) && n >= 1 && n <= list.length) return list[n - 1];
  return claudeManager.list().find((e) => e.name.toLowerCase() === String(arg).trim().toLowerCase()) || null;
}

/** Numbered menu of managed sessions. */
function listNumbered(entries) {
  if (!entries.length) return '(no managed sessions yet — create one with /new <name> <project-path>)';
  return entries.map((e, i) => `${i + 1}. *${e.name}* — ${projectLabel(e.project)} [${e.status}]`).join('\n');
}

function formatSessionBlock(entry, st) {
  const p = st ? st.process : { running: false, pid: null, busy: false };
  const conn = entry.transport === 'channel' ? (channelHub.isOnline(entry.id) ? 'connected' : 'offline') : null;
  return [
    `Session: *${entry.name}*`,
    `Project: ${projectLabel(entry.project)}`,
    `Transport: ${entry.transport}${conn ? ` (${conn})` : ''}`,
    `Status: ${p.running ? (p.busy ? 'running (busy)' : 'idle') : 'stopped'}`,
    p.pid ? `PID: ${p.pid}` : null,
  ].filter(Boolean).join('\n');
}

function formatSessionStatus(st) {
  const e = st.entry;
  const p = st.process;
  const runtime = p.taskStartedAt ? formatUptime(Math.floor((Date.now() - p.taskStartedAt) / 1000)) : null;
  const lines = [
    `Session: *${e.name}* (${projectLabel(e.project)})`,
    `Process: ${p.running ? `running${p.pid ? ` (pid ${p.pid})` : ''}` : `stopped${p.exit ? `, exit ${p.exit.code}` : ''}`}`,
    `Task: ${p.task ? p.task.slice(0, 120) : 'none'}`,
    runtime ? `Runtime: ${runtime}` : null,
    `Queued tasks: ${p.queuedTasks}`,
  ].filter(Boolean);
  if (p.latestOutput) {
    lines.push('', 'Latest output:', p.latestOutput.slice(-800));
  }
  return lines.join('\n');
}

/**
 * Route a chat message into its attached session.
 *
 * Channel sessions (transport 'channel', online): the message is delivered
 * through the custom Claude Code Channel and appears natively in the live
 * session — Claude answers via the reply tool, which comes back through the
 * hub and is sent to the originating chat. No timeout/queue machinery here.
 *
 * Legacy stream-json sessions: the original submitTask path with streaming
 * progress and a hard task timeout.
 */
function routeToManaged(chatId, entry, text, { userId = '', messageId = null } = {}) {
  if (entry.transport === 'channel') {
    if (!channelHub.isOnline(entry.id)) {
      reply(chatId, `⚠️ *${entry.name}* is a Channel session but is currently offline.\nStart Claude Code in that project with the channel enabled (see DOCUMENTATION.md §Channel), then it will reconnect automatically.`).catch(() => {});
      return;
    }
    const r = deliverToSession(chatId, entry, text, {}, { userId, messageId });
    if (!r.ok) {
      reply(chatId, `❌ Could not deliver to *${entry.name}* (${r.error}).`).catch(() => {});
    }
    return;
  }

  // ---- legacy stream-json managed session --------------------------------
  const reporter = createProgressReporter({
    send: (t) => reply(chatId, `⚙️ *${entry.name}*\n${t}`),
    minIntervalMs: PROGRESS_MIN_INTERVAL_MS,
    logWarn,
  });
  const timeout = setTimeout(() => {
    claudeManager.stopSession(entry.id, 'task timeout');
    reply(chatId, `⏱️ *${entry.name}* task exceeded ${Math.round(MANAGED_TASK_TIMEOUT_MS / 60000)} min and was stopped.`).catch(() => {});
  }, MANAGED_TASK_TIMEOUT_MS);
  if (timeout.unref) timeout.unref();

  claudeManager
    .route(chatId, text, {
      onQueued: (position) => {
        reply(chatId, `📥 *${entry.name}* is busy — task queued at position ${position}.`).catch(() => {});
      },
      onProgress: (p) => reporter.push(p.text),
    })
    .then((result) => {
      clearTimeout(timeout);
      if (!result.ok && !result.queued) {
        reply(chatId, `❌ *${entry.name}*: ${result.summary || 'task failed'}`).catch(() => {});
        return;
      }
      if (result.queued) return; // queued tasks report via their own completion
      reporter.complete(result.summary || `Done in ${formatUptime(Math.floor((result.runtimeMs || 0) / 1000))}.`);
    })
    .catch((err) => {
      clearTimeout(timeout);
      logError(`managed routing error chat=${chatId}: ${err.message}`);
      reply(chatId, `❌ *${entry.name}* routing failed: ${err.message}`).catch(() => {});
    });
}

// --------------------------- file exchange ---------------------------------

/** Download a Telegram file into <project>/incoming/ (best effort, capped). */
async function handleFileUpload(chatId, document, { userId = '', messageId = null } = {}) {
  const entry = registry.attached(chatId);
  if (!entry) {
    await reply(chatId, 'Attach to a session first (/attach <name|number>) to upload files.');
    return;
  }
  const fileName = path.basename(String(document.file_name || 'upload.bin')).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'upload.bin';
  if ((document.file_size || 0) > TELEGRAM_FILE_MAX_BYTES) {
    await reply(chatId, `❌ File too large (max ${Math.round(TELEGRAM_FILE_MAX_BYTES / 1024 / 1024)} MB).`);
    return;
  }
  try {
    const fileInfo = await tg.request('getFile', { file_id: document.file_id });
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
    const res = await new Promise((resolve, reject) => {
      const { agent } = tg.state();
      const mod = require('https');
      mod.get(url, { agent: agent || undefined }, resolve).on('error', reject);
    });
    if (res.statusCode !== 200) {
      throw new Error(`download failed: HTTP ${res.statusCode}`);
    }
    const chunks = [];
    let size = 0;
    for await (const c of res) {
      size += c.length;
      if (size > TELEGRAM_FILE_MAX_BYTES) throw new Error('download exceeded size cap');
      chunks.push(c);
    }
    // SAFE WRITE DESTINATION: (1) create <project>/incoming if missing —
    // validating the REAL result stays inside the project (a symlink/junction
    // incoming pointing outside is refused, never written through); this used
    // to run resolve-before-mkdir, so the FIRST upload to a fresh project
    // failed with "upload directory does not exist". (2) resolve the final
    // destination against the canonical directory.
    const incomingDir = path.join(entry.project, 'incoming');
    const dirCheck = ensureUploadDir(entry.project, incomingDir);
    if (!dirCheck.ok) throw new Error(dirCheck.error);
    const destCheck = resolveUploadDest(entry.project, dirCheck.dir, fileName);
    if (!destCheck.ok) throw new Error(destCheck.error);
    const dest = destCheck.path;
    fs.writeFileSync(dest, Buffer.concat(chunks));
    await reply(chatId, `📎 Saved to ${projectLabel(entry.project)}/${destCheck.relativePath}. Notifying the session…`);
    // Channel sessions get a channel event with safe metadata (no file
    // contents inlined); stream-json sessions get a task prompt.
    if (entry.transport === 'channel' && channelHub.isOnline(entry.id)) {
      deliverToSession(chatId, entry, `User uploaded file: ${destCheck.relativePath}. Analyze this file.`, { file_path: destCheck.relativePath }, { userId, messageId });
    } else {
      routeToManaged(chatId, entry, `User uploaded file: ${destCheck.relativePath}. Analyze this file.`, { userId, messageId });
    }
  } catch (err) {
    logError(`file upload failed chat=${chatId}: ${err.message}`);
    await reply(chatId, `❌ Could not save the file: ${err.message}`);
  }
}

/** List files in the attached project (shallow, cap 50). */
function listProjectFiles(entry) {
  try {
    const names = fs.readdirSync(entry.project, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .filter((n) => !n.startsWith('.'))
      .slice(0, 50);
    if (!names.length) return `No files in ${projectLabel(entry.project)}.`;
    return `Files in ${projectLabel(entry.project)}:\n${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}`;
  } catch (err) {
    return `Could not list files: ${err.message}`;
  }
}

/**
 * Send one project file back to Telegram. Path safety is centralized in
 * resolveProjectFile: realpath(requested) must be inside realpath(project)
 * — symlink/junction escapes, traversal, absolute/UNC outside-root all
 * rejected. Nested project-relative paths are supported.
 */
async function sendProjectFile(chatId, nameArg) {
  const entry = registry.attached(chatId);
  if (!entry) {
    await reply(chatId, 'No Claude session selected. Use /attach <name|number>.');
    return;
  }
  const resolved = resolveProjectFile(entry.project, nameArg);
  if (!resolved.ok) {
    await reply(chatId, `❌ ${resolved.error}`);
    return;
  }
  try {
    const st = fs.statSync(resolved.path);
    if (st.size > TELEGRAM_FILE_MAX_BYTES) {
      throw new Error(`file too large (max ${Math.round(TELEGRAM_FILE_MAX_BYTES / 1024 / 1024)} MB)`);
    }
    const displayName = path.basename(resolved.path);
    await sendDocumentMultipart(chatId, resolved.path, displayName);
  } catch (err) {
    await reply(chatId, `❌ ${err.message}`);
  }
}

/** Multipart sendDocument (Bot API file upload, shell-free). */
function sendDocumentMultipart(chatId, filePath, fileName) {
  return new Promise((resolve, reject) => {
    const boundary = '----tgbridge' + Date.now();
    const fileData = fs.readFileSync(filePath);
    const part1 = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`,
      'utf8',
    );
    const part2head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      'utf8',
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([part1, part2head, fileData, tail]);
    const { agent } = tg.state();
    const req = require('https').request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${BOT_TOKEN}/sendDocument`,
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': body.length,
        },
        agent: agent || undefined,
        timeout: 120_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (data.ok) resolve(data.result);
            else reject(new Error(`sendDocument failed: ${data.description || res.statusCode}`));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

let botUsername = '';

async function handleMessage(msg) {
  const chatId = String(msg.chat && msg.chat.id);
  const userId = String((msg.from && msg.from.id) || '');

  // Fail closed: unknown users are ignored entirely (no capability probing).
  if (!ALLOWED.has(userId)) {
    logInfo(`rejected unauthorized user=${userId} chat=${chatId}`);
    return;
  }

  // Documents: route to the attached managed session's project folder.
  if (Array.isArray(msg.document) || (msg.document && typeof msg.document === 'object')) {
    await handleFileUpload(chatId, msg.document, { userId, messageId: msg.message_id });
    return;
  }

  if (typeof msg.text !== 'string' || !msg.text.trim()) {
    logDebug(`chat=${chatId}: ignoring non-text message type`);
    return; // media/ stickers/ etc. intentionally unsupported
  }
  const text = msg.text.trim();
  logInfo(`msg from user=${userId} chat=${chatId} len=${text.length}`);

  const parsed = parseCommand(text);
  if (parsed) {
    // Group-style "/cmd@SomeBot": ignore commands addressed to other bots.
    if (parsed.addressedTo && botUsername && parsed.addressedTo.toLowerCase() !== botUsername.toLowerCase()) {
      logDebug(`ignoring command addressed to @${parsed.addressedTo}`);
      return;
    }
    await dispatchCommand(chatId, parsed, { userId, messageId: msg.message_id });
    return;
  }

  // Plain text => task. Routing: if this chat is attached to a MANAGED
  // session, the text goes there (interactive managed Claude); otherwise the
  // legacy one-shot queue behavior applies. Sender identity is explicit.
  const attached = registry.attached(chatId);
  if (attached) {
    routeToManaged(chatId, attached, text, { userId, messageId: msg.message_id });
    return;
  }

  // No managed session attached: legacy one-shot behavior.
  const active = store.active(chatId);
  const job = {
    sessionName: active.name,
    sessionId: active.session.id,
    initialized: active.session.initialized,
    text, // exact Telegram text, multiline preserved; passed as spawn arg
    cwd: DEFAULT_CWD,
    chatId,
  };
  let res;
  try {
    res = queue.enqueue(chatId, job, {
      onQueued: (position) => {
        reply(chatId, `📥 Queued at position ${position} for session *${job.sessionName}*. You'll get the report here.`).catch(() => {});
      },
      onRejected: (max) => {
        reply(chatId, `⚠️ Queue is full for this chat (${max} waiting). Use /stop to clear or wait for jobs to finish.`).catch(() => {});
      },
    });
  } catch (err) {
    // Races with shutdown surface here; never an unhandled rejection.
    logWarn('enqueue failed:', err.message);
    return;
  }
  if (!res.ok) logWarn(`enqueue rejected chat=${chatId} (${res.error})`);
}

async function dispatchCommand(chatId, parsed, { userId = '', messageId = null } = {}) {
  const { cmd, arg } = parsed;
  switch (cmd) {
    case 'start':
    case 'help':
      await reply(chatId, helpText(botUsername));
      return;

    case 'new': {
      // /new <name>            -> legacy one-shot chat session (unchanged)
      // /new <name> <path>     -> managed Claude session bound to a project
      const parts = String(arg || '').trim().split(/\s+/);
      const maybePath = parts.length >= 2 ? parts[parts.length - 1] : null;
      const isManaged = maybePath !== null;
      const name = isManaged ? parts.slice(0, -1).join(' ') : arg;

      if (isManaged) {
        const created = await claudeManager.createSession({ name, project: maybePath, owner: { userId: String(userId || '') } });
        if (!created.ok) {
          await reply(chatId, `❌ ${created.error}`);
          return;
        }
        await claudeManager.attach(chatId, created.entry.id);
        await reply(chatId, `✨ Managed session *${created.entry.name}* created for project ${projectLabel(created.entry.project)} and attached.\nSend any text to task it; /detach to release; /session_status for details.`);
        return;
      }

      // Snapshot-then-mutate-then-persist: if the save fails, the FULL chat
      // state (including any pre-existing session under this name) is restored
      // exactly — removing the entry alone would lose the old session.
      const snap = store.snapshotChat(String(chatId));
      const created = store.create(chatId, name);
      if (!created.ok) {
        await reply(chatId, `❌ ${created.error}`);
        return;
      }
      try {
        await store.save();
      } catch (err) {
        store.restoreChat(String(chatId), snap);
        await reply(chatId, `❌ Could not create session (failed to save): ${err.message}`);
        return;
      }
      await reply(chatId, `✨ New session *${created.name}* created and active. Send me your first task.`);
      return;
    }

    case 'sessions': {
      // Unified view: managed sessions (channel/stream-json) first, then the
      // legacy one-shot store sessions for this chat.
      const managed = claudeManager.list();
      const attachedId = (registry.attached(chatId) || {}).id;
      const lines = [];
      managed.forEach((e, i) => {
        const flag = e.id === attachedId ? '▶️' : '  ';
        const conn = e.transport === 'channel' ? (channelHub.isOnline(e.id) ? 'Channel: connected' : 'Channel: offline') : 'transport: stream-json';
        lines.push(`${flag} ${i + 1}. *${e.name}*\n     ${conn} · Project: ${projectLabel(e.project)}`);
      });
      const legacyNames = store.names(chatId);
      if (legacyNames.length) {
        const active = store.active(chatId);
        lines.push('', 'One-shot sessions:');
        for (const n of legacyNames) {
          const s = store.get(chatId, n);
          const flag = n === active.name ? '▶️' : '  ';
          lines.push(`${flag} *${n}*${s.initialized ? '' : ' (new)'}`);
        }
      }
      if (!lines.length) {
        await reply(chatId, 'No sessions yet. Create one with /new <name> <project-path>.');
        return;
      }
      await reply(chatId, `Sessions:\n${lines.join('\n')}`);
      return;
    }

    case 'switch': {
      if (!arg) {
        await reply(chatId, 'Usage: /switch <name|number> (see /sessions)');
        return;
      }
      const target = resolveSessionArg(arg);
      if (!target) {
        await reply(chatId, `No session "${arg}". Use /sessions to list.`);
        return;
      }
      if (target.transport === 'channel' && !channelHub.isOnline(target.id)) {
        await reply(chatId, `⚠️ *${target.name}* is offline right now. Start Claude Code in that project with the channel enabled, then /switch again.\nNot switching to a different session.`);
        return;
      }
      const r = await claudeManager.attach(chatId, target.id);
      if (!r.ok) {
        await reply(chatId, `❌ ${r.error}`);
        return;
      }
      await reply(chatId, `🔀 Switched to *${target.name}* (${projectLabel(target.project)}). Next messages go there.`);
      return;
    }

    case 'use': {
      if (!arg) {
        await reply(chatId, 'Usage: /use <name>');
        return;
      }
      const snap = store.snapshotChat(String(chatId));
      const res = store.setActive(chatId, arg);
      if (!res.ok) {
        await reply(chatId, `No session named *${arg}*. Use /sessions to list.`);
        return;
      }
      try {
        await store.save();
      } catch (err) {
        store.restoreChat(String(chatId), snap); // roll back active selection
        await reply(chatId, `❌ Could not switch session (failed to save): ${err.message}`);
        return;
      }
      await reply(chatId, `🔀 Switched to *${arg}*.`);
      return;
    }

    case 'stop': {
      // /stop is scoped by transport: for Channel sessions it only cancels
      // Bridge-side work — the interactive Claude Code process is NEVER killed
      // here (use /terminate_session for that).
      const removed = queue.clearChat(chatId);
      let cancelNote = 'no running job in this chat';
      if (currentRun && currentRun.chatId === chatId && !currentRun.cancelled) {
        currentRun.cancel('stopped by /stop');
        cancelNote = `running job *${currentRun.job.sessionName}* cancelled`;
      }
      let channelNote = '';
      const att = registry.attached(chatId);
      if (att && att.transport === 'channel') {
        channelNote = ' Channel session left running (use /terminate_session to stop it).';
      }
      await reply(chatId, `🛑 ${cancelNote}; ${removed} queued job(s) removed.${channelNote}`);
      return;
    }

    case 'terminate_session': {
      const cur = registry.attached(chatId);
      if (!cur) {
        await reply(chatId, 'No session attached.');
        return;
      }
      if (cur.transport !== 'stream-json') {
        await reply(chatId, `⚠️ *${cur.name}* is a Channel session. /stop never kills it — /terminate_session stops the Claude Code process. Send /terminate_session confirm to proceed.`);
        return;
      }
      if (arg !== 'confirm') {
        await reply(chatId, `Send /terminate_session confirm to stop *${cur.name}*'s Claude process.`);
        return;
      }
      claudeManager.stopSession(cur.id, 'terminated by /terminate_session');
      await reply(chatId, `🛑 Stopped the stream-json process for *${cur.name}*. The registry entry remains for restart.`);
      return;
    }

    case 'queue': {
      const info = queue.info(chatId);
      const parts = [];
      parts.push(info.running
        ? `Running: *${info.running.sessionName}*${currentRun && currentRun.chatId === chatId ? '' : ' (other chat)'}`
        : 'Running: none');
      parts.push(`Queued in this chat: ${info.mineQueued}`);
      parts.push(`Global queued: ${info.totalQueued}`);
      await reply(chatId, parts.join('\n'));
      return;
    }

    case 'status':
      await reply(chatId, statusText(chatId));
      return;

    // ------------------------- managed sessions -------------------------

    case 'attach': {
      if (!arg) {
        await reply(chatId, 'Usage: /attach <name|number> (see /sessions)');
        return;
      }
      const target = resolveSessionArg(arg);
      if (!target) {
        await reply(chatId, `No session "${arg}". Use /sessions to list.`);
        return;
      }
      if (target.transport === 'channel' && !channelHub.isOnline(target.id)) {
        await reply(chatId, `⚠️ *${target.name}* is a Channel session but is currently OFFLINE.\nStart Claude Code in that project with the channel enabled, then try again.\n(Not falling back to another session.)`);
        return;
      }
      const r = await claudeManager.attach(chatId, target.id);
      if (!r.ok) {
        await reply(chatId, `❌ ${r.error}`);
        return;
      }
      await reply(chatId, `🔗 Attached to *${target.name}* (${projectLabel(target.project)}).\nSend any text — it appears live in that Claude Code session; /detach to let go.`);
      return;
    }

    case 'detach': {
      const d = await claudeManager.detach(chatId);
      await reply(chatId, d.wasAttached ? '🔌 Detached. Plain text now uses the classic one-shot flow (/new <name>).' : 'Nothing to detach from.');
      return;
    }

    case 'current': {
      const cur = claudeManager.attached(chatId);
      if (!cur) {
        await reply(chatId, 'No Claude session selected.\nAvailable sessions:\n' + listNumbered(claudeManager.list()) + '\nUse /attach <name|number>');
        return;
      }
      const st = claudeManager.status(cur.id);
      const conn = cur.transport === 'channel' ? (channelHub.isOnline(cur.id) ? 'connected' : 'offline') : 'n/a (stream-json)';
      const base = formatSessionBlock(cur, st);
      await reply(chatId, `${base}\nTransport: ${cur.transport}\nChannel: ${conn}\nLast activity: ${cur.lastActivity || 'unknown'}`);
      return;
    }

    case 'session_status': {
      const cur = claudeManager.attached(chatId);
      if (!cur) {
        await reply(chatId, 'No Claude session selected. Use /attach <name|number>.');
        return;
      }
      await reply(chatId, formatSessionStatus(claudeManager.status(cur.id)));
      return;
    }

    case 'files': {
      const cur = claudeManager.attached(chatId);
      if (!cur) {
        await reply(chatId, 'No Claude session selected. Use /attach <name|number>.');
        return;
      }
      await reply(chatId, listProjectFiles(cur));
      return;
    }

    case 'download': {
      if (!arg) {
        await reply(chatId, 'Usage: /download <filename> (see /files)');
        return;
      }
      await sendProjectFile(chatId, arg);
      return;
    }

    case 'discover': {
      const procs = await discoverClaudeProcesses({});
      if (!procs.length) {
        await reply(chatId, 'No running Claude processes found (or discovery unavailable).');
        return;
      }
      const lines = procs.map((p, i) => `${i + 1}. PID ${p.pid} — ${p.name}`);
      await reply(chatId, `Running Claude processes (read-only inventory — the bridge never touches processes it does not own):\n${lines.join('\n')}\n\nTo control Claude from here, create a MANAGED session: /new <name> <project-path>`);
      return;
    }

    default:
      // Unknown command (not in BOT_COMMANDS): show help.
      await reply(chatId, helpText(botUsername));
      return;
  }
}

// ---------------------------------------------------------------------------
// Long polling
//
// Update durability: AT-MOST-ONCE. The next offset is committed to disk
// BEFORE the update is handled (centralized in advanceOffset), so a crash
// can lose an update but can never re-execute one. Backlog policy: on the
// very first start (no persisted offset) pending updates are skipped via a
// negative getUpdates offset unless PROCESS_INITIAL_BACKLOG=true.
// ---------------------------------------------------------------------------

/**
 * THE single place the update offset advances. Commits the next offset to
 * disk BEFORE the caller handles the update — deliberate AT-MOST-ONCE
 * semantics (see header comment). `osImpl` injectable for tests.
 *
 * If the durable commit FAILS this throws: the caller must not handle the
 * update and must not advance its in-memory offset, so a restart (or the
 * polling retry) re-delivers the same update instead of executing a command
 * whose offset was never persisted. False "success" would break at-most-once.
 */
function advanceOffset(current, updateId, osImpl = offsetStore) {
  const next = Math.max(current, updateId + 1);
  let persisted = false;
  try {
    persisted = Boolean(osImpl.commit(next));
  } catch (err) {
    throw new Error(`Failed to persist Telegram offset ${next}: ${err.message}`);
  }
  if (!persisted) {
    throw new Error(`Failed to persist Telegram offset ${next}; update NOT handled (at-most-once)`);
  }
  return next;
}

/**
 * Backlog policy at startup.
 *
 * Offset-state semantics (from the offset store's categorized load()):
 * - missing  -> true first-ever start: PROCESS_INITIAL_BACKLOG=false (default)
 *   fetches once with offset = -1; Telegram's documented behavior is to skip
 *   all pending updates and return only the most recent one. The resulting
 *   state is then persisted — even when the backlog was EMPTY — so a restart
 *   is never mistaken for another first start (which would purge new
 *   messages). With PROCESS_INITIAL_BACKLOG=true the backlog is consumed
 *   normally and offset 0 is persisted as the initialization marker.
 * - corrupt / unreadable -> NOT first start. Refusing to treat corrupted
 *   state as "never persisted" is essential: doing so would purge the
 *   Telegram backlog and silently discard pending commands. The store backs
 *   the corrupt file up; startup fails with an actionable error instead.
 * - valid    -> resume normally from the persisted offset (never purge).
 */
async function purgeBacklogIfFirstStart({ osImpl = offsetStore, tgImpl = tg } = {}) {
  const loaded = osImpl.load();
  const persisted = loaded && typeof loaded === 'object' && 'state' in loaded
    ? loaded
    : { state: loaded === null || loaded === undefined ? 'missing' : 'valid', offset: loaded }; // legacy stubs
  if (persisted.state === 'corrupt' || persisted.state === 'unreadable') {
    throw new Error(
      `Unable to read Telegram offset state (${persisted.state}${persisted.error ? `: ${persisted.error.message}` : ''}). ` +
      'Refusing to treat this as first startup because doing so could discard pending updates. ' +
      `Inspect/restore ${OFFSET_FILE} (a .corrupt-*.bak backup was written next to it if possible), then start the bridge again.`
    );
  }
  if (persisted.state === 'valid') {
    logInfo(`resuming from persisted Telegram offset ${persisted.offset}`);
    return persisted.offset;
  }
  // state === 'missing': genuine first-ever start.
  // Read at call time (not import time) so tests can exercise both branches.
  if (/^(1|true|yes)$/i.test(process.env.PROCESS_INITIAL_BACKLOG || '')) {
    logInfo('PROCESS_INITIAL_BACKLOG=true: will process any messages sent while offline');
    advanceOffset(-1, -1, osImpl); // persist initialization marker (offset 0); throws on failure
    return 0;
  }
  let latest = null;
  try {
    const updates = await tgImpl.request('getUpdates', { offset: -1, timeout: 0, allowed_updates: ['message'] });
    if (Array.isArray(updates) && updates.length > 0) {
      latest = updates[updates.length - 1].update_id;
      logInfo(`first start: skipping ${updates.length} pending Telegram update(s) sent while offline (set PROCESS_INITIAL_BACKLOG=true to change)`);
      advanceOffset(-1, latest, osImpl);
    } else {
      logInfo('first start: no pending Telegram updates; recording initialization state');
      advanceOffset(-1, -1, osImpl); // persist marker 0 so a restart is NOT another first start
    }
  } catch (err) {
    if (err && /^Failed to persist Telegram offset/.test(err.message)) throw err; // durability failure is fatal
    // Telegram unreachable: nothing to purge yet; normal polling will retry.
    logWarn('backlog probe skipped:', err.message);
  }
  return latest === null ? 0 : latest + 1;
}

/**
 * Process one batch of updates: persist each next offset BEFORE handling its
 * update (at-most-once). If offset persistence fails, the update is NOT
 * handled, the in-memory offset stays put, and the error propagates to the
 * poll loop — which logs it clearly and retries, so Telegram re-delivers the
 * same update. Injectable (`osImpl`, `handle`) for tests.
 */
async function processUpdates(updates, { osImpl = offsetStore, handle = handleMessage } = {}) {
  let offset = null;
  for (const upd of updates || []) {
    offset = advanceOffset(offset === null ? -1 : offset, upd.update_id, osImpl);
    try {
      if (upd.message) await handle(upd.message);
    } catch (err) {
      logError('handler error:', err.message);
    }
  }
  return offset;
}

async function pollLoop(startOffset) {
  let offset = startOffset;
  while (!shuttingDown) {
    try {
      const updates = await tg.request('getUpdates', {
        offset,
        timeout: 50,
        allowed_updates: ['message'],
      });
      for (const upd of updates || []) {
        // advanceOffset persists BEFORE handling and throws when persistence
        // fails: the update is not executed and `offset` stays put, so the
        // next poll re-delivers the same update (at-most-once preserved).
        offset = advanceOffset(offset, upd.update_id);
        try {
          if (upd.message) await handleMessage(upd.message);
        } catch (err) {
          logError('handler error:', err.message);
        }
      }
    } catch (err) {
      if (shuttingDown) break;
      tg.markFailure();
      const backoff = /^Failed to persist Telegram offset/.test(err.message)
        ? 'offset persistence failed — update NOT executed; retrying in 10s'
        : 'retrying in 10s';
      logWarn('poll error:', err.message, '—', backoff);
      await sleep(10_000);
    }
  }
  logInfo('polling stopped');
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;

/** Final persistence budget: a broken/slow disk must not hang Ctrl+C forever. */
const SHUTDOWN_FLUSH_TIMEOUT_MS = 5000;

/**
 * Bounded registry shutdown flush: settles queued transactions, flushes
 * coalesced touches, performs ONE final save (Channel-offline / manager
 * state) and awaits its disk writes. A broken/slow disk must not hang
 * Ctrl+C forever — on timeout a warning is logged and the caller exits.
 * (Exported for tests; injected with a small timeout there.)
 */
async function shutdownRegistryFlush(regLike, timeoutMs, warn = logWarn) {
  await Promise.race([
    (async () => {
      await regLike.awaitTransactions(); // barrier: queued txns settled before the final save
      await regLike.flushTouches(); // coalesced lastActivity (resolves immediately if empty)
      await regLike.save(); // final Channel-offline/manager state — never exit mid-atomic-write
      await regLike.flush(); // the save's disk writes are durable
    })(),
    sleep(timeoutMs).then(() => {
      warn(`registry shutdown flush timed out after ${timeoutMs}ms — exiting anyway`);
    }),
  ]);
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true; // 1. mark shutting down (poll loop + handlers check this)
  logInfo(`${signal} received, shutting down…`);
  queue.close(); // 2-4. stop accepting/clear queued work — no new Claude can start
  if (currentRun && currentRun.child && currentRun.child.exitCode === null) { // 5.
    try {
      currentRun.child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        if (currentRun && currentRun.child.exitCode === null) currentRun.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 3000);
  }

  /**
   * BOUNDED DURABLE SHUTDOWN (6-10):
   *
   * flush legacy store -> stop managed Claude processes and AWAIT their
   * pending registry updates -> close the Channel hub (marks sessions
   * offline) -> settle queued registry transactions -> flush coalesced
   * touches -> one final registry save (Channel-offline state) -> await
   * disk writes -> exit. Never exits mid-atomic-write: we either await the
   * persistence (or its logged failure) or hit the bounded timeout.
   */
  (async () => {
    await Promise.race([store.flush(), sleep(3000)]); // 6-7. legacy store, existing 3s policy
    try {
      await claudeManager.stopAll(); // 8. kill processes immediately; awaited pending flush
    } catch (err) {
      logWarn('managed-session shutdown flush failed:', err.message || err);
    }
    channelHub.close(); // 9. mark Channel sessions offline (in-memory + registry mutation)
    // 10-12. settle queued transactions, flush touches, final save + disk writes.
    await shutdownRegistryFlush(registry, SHUTDOWN_FLUSH_TIMEOUT_MS);
    logInfo('bye');
    process.exit(0);
  })().catch((err) => {
    logWarn('shutdown persistence error:', err.message || err);
    logInfo('bye');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

if (require.main === module) (async () => {
  logInfo(`starting bridge; claude=${claudeDisplay}; state dir=${STATE_DIR}`);

  // Channel hub: authenticated localhost IPC for Channel-enabled sessions.
  channelHub.onChannelMessage((entry, { content, meta }) => {
    // Inbound channel events are Bridge-gated already (only authenticated
    // channel connections reach here); log at debug level.
    logDebug(`channel event from ${entry.name}: ${String(content).length}B meta=${JSON.stringify(Object.keys(meta || {}))}`);
  });
  channelHub.onChannelTool(async (entry, tool, args) => {
    if (tool === 'reply') {
      // PREFERRED: delivery-scoped reply. The channel passes the delivery_id
      // from the <channel> tag meta; the Bridge resolves it to the original
      // chat. This stays valid even after the user /switch'ed away.
      if (args.delivery_id) {
        const r = resolveDelivery(args.delivery_id, { forSessionId: entry.id });
        if (!r.ok) throw new Error(r.error);
        await reply(r.delivery.chatId, String(args.text || ''));
        return { sent: true, delivery: true };
      }
      // DEPRECATED legacy form: reply(chat_id, text) — allowed ONLY while the
      // session is the chat's current attachment. Documented for removal.
      const chatId = String(args.chat_id || '');
      if (!chatId || !/^-?\d+$/.test(chatId)) throw new Error('invalid chat_id');
      const attached = registry.attached(chatId);
      if (!attached || attached.id !== entry.id) {
        throw new Error('session is not attached to that chat (use delivery_id from the channel tag)');
      }
      await reply(chatId, String(args.text || '')); // existing chunking/error handling
      return { sent: true, delivery: false };
    }
    if (tool === 'send_file') {
      // Resolve chat: delivery-scoped preferred, current-attachment fallback.
      let chatId = null;
      if (args.delivery_id) {
        const r = resolveDelivery(args.delivery_id, { forSessionId: entry.id });
        if (!r.ok) throw new Error(r.error);
        chatId = r.delivery.chatId;
      } else {
        const cand = String(args.chat_id || '');
        if (!cand || !/^-?\d+$/.test(cand)) throw new Error('invalid chat_id');
        const attached = registry.attached(cand);
        if (!attached || attached.id !== entry.id) {
          throw new Error('session is not attached to that chat (use delivery_id from the channel tag)');
        }
        chatId = cand;
      }
      // Centralized path safety: realpath inside realpath(project) — symlink/
      // junction/UNC/absolute escapes all rejected; nested paths supported.
      const resolved = resolveProjectFile(entry.project, args.file_path);
      if (!resolved.ok) throw new Error(resolved.error);
      const st = fs.statSync(resolved.path);
      if (st.size > TELEGRAM_FILE_MAX_BYTES) {
        throw new Error(`file too large (max ${Math.round(TELEGRAM_FILE_MAX_BYTES / 1024 / 1024)} MB)`);
      }
      await sendDocumentMultipart(chatId, resolved.path, path.basename(resolved.path));
      return { sent: true, file: resolved.relativePath };
    }
    throw new Error(`unknown tool: ${tool}`);
  });
  channelHub.listen(({ port }) => {
    hubPort = port;
    logInfo(`channel hub ready on 127.0.0.1:${port} (secret: state/channel-secret)`);
  }, { onFatal: (err) => failStartup(err.message) });
  logInfo(`allowlist: ${ALLOWED.size} authorized user(s); backlog on first start: ${PROCESS_INITIAL_BACKLOG ? 'process' : 'skip'}`);

  let me = null;
  while (!me) {
    try {
      me = await tg.request('getMe', {});
    } catch (err) {
      logWarn('cannot reach Telegram yet:', err.message, '— start your VPN; retrying in 15s');
      await sleep(15_000);
    }
  }
  botUsername = me.username || '';
  const { label, source } = tg.state();
  logInfo(`authorized as @${botUsername}. Proxy: ${label} [${source || 'direct'}]`);

  // Register slash-command autocomplete / menu (non-fatal on failure).
  try {
    await tg.request('setMyCommands', { commands: BOT_COMMANDS });
    logInfo(`registered ${BOT_COMMANDS.length} bot commands with Telegram`);
  } catch (err) {
    logWarn('setMyCommands failed (bridge continues):', err.message);
  }
  try {
    await tg.request('setChatMenuButton', { menu_button: { type: 'commands' } });
  } catch (err) {
    logWarn('setChatMenuButton failed (bridge continues):', err.message);
  }

  // First-start backlog policy: skip historical updates unless opted in.
  const startOffset = await purgeBacklogIfFirstStart();
  logInfo('listening for messages… (Ctrl+C to stop)');

  // Periodically re-resolve the proxy so VPN changes are noticed even without errors.
  const reprobe = setInterval(() => {
    if (!shuttingDown) tg.refresh('periodic');
  }, 60_000);
  if (reprobe.unref) reprobe.unref();

  await pollLoop(startOffset);
})().catch((err) => {
  logError('fatal:', err.message || err);
  process.exit(1);
});

// Exported for tests; no side effects beyond config validation at require time.
module.exports = {
  __test: {
    handleMessage,
    dispatchCommand,
    buildClaudeArgs,
    boundedCapture,
    statusText,
    runClaudeJob,
    store,
    queue,
    offsetStore,
    claudeRunner,
    advanceOffset,
    processUpdates,
    purgeBacklogIfFirstStart,
    registry,
    claudeManager,
    shutdownRegistryFlush,
    resolveSessionArg,
    listNumbered,
    routeToManaged,
    setManagedSpawnFn(fn) {
      managedSpawnFn = fn;
    },
    setStore(fake) {
      // Tests inject a store-backed stub (see test/bridge.test.js).
      Object.assign(store, fake);
    },
    setTelegram(fake) {
      tg = fake; // tests inject a no-network client
    },
    getTelegram: () => tg,
    STATE_DIR,
  },
};
