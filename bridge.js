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
const {
  parseAllowlist,
  intEnv,
  validateProxyUrl,
  validateBotToken,
  ensureWritableDir,
  validateBridgeCwd,
  resolveClaudeBin,
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

const dirCheck = ensureWritableDir(STATE_DIR);
if (!dirCheck.ok) failStartup(dirCheck.error);

const claudeCheck = resolveClaudeBin(process.env.CLAUDE_BIN || 'claude');
if (!claudeCheck.ok) failStartup(`${claudeCheck.error}. Set CLAUDE_BIN to the full path of the native claude executable.`);
const claudeDisplay = safeClaudeLabel(claudeCheck.resolved); // basename only — no paths over Telegram

const cwdCheck = validateBridgeCwd(process.env.BRIDGE_CWD || ROOT);
if (!cwdCheck.ok) failStartup(cwdCheck.error);
const DEFAULT_CWD = cwdCheck.resolved;

// ---------------------------------------------------------------------------
// Stores, queue, Telegram client
// ---------------------------------------------------------------------------

let tg = createTelegramClient({ token: BOT_TOKEN, explicitProxy: EXPLICIT_PROXY, log: logInfo });

const store = createSessionStore(SESSIONS_FILE);
const offsetStore = createOffsetStore(OFFSET_FILE);

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

    const child = spawnFn(claudeCheck.resolved, args, {
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
          // Session is now real on Claude's side; future jobs resume it.
          store.markInitialized(chatId, job.sessionId);
          try {
            await store.save();
          } catch (err) {
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
    await dispatchCommand(chatId, parsed);
    return;
  }

  // Plain text => task for the active session.
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

async function dispatchCommand(chatId, parsed) {
  const { cmd, arg } = parsed;
  switch (cmd) {
    case 'start':
    case 'help':
      await reply(chatId, helpText(botUsername));
      return;

    case 'new': {
      const created = store.create(chatId, arg);
      if (!created.ok) {
        await reply(chatId, `❌ ${created.error}`);
        return;
      }
      try {
        await store.save();
      } catch (err) {
        // Roll back the in-memory mutation; never claim success.
        store.remove(chatId, created.name);
        await reply(chatId, `❌ Could not create session (failed to save): ${err.message}`);
        return;
      }
      await reply(chatId, `✨ New session *${created.name}* created and active. Send me your first task.`);
      return;
    }

    case 'sessions': {
      const names = store.names(chatId);
      const active = store.active(chatId);
      if (!names.length) {
        await reply(chatId, 'No sessions yet. Use /new <name>.');
        return;
      }
      const lines = names.map((n) => {
        const s = store.get(chatId, n);
        const flag = n === active.name ? '▶️' : '  ';
        return `${flag} *${n}*${s.initialized ? '' : ' (new)'}`;
      });
      await reply(chatId, `Sessions:\n${lines.join('\n')}`);
      return;
    }

    case 'use': {
      if (!arg) {
        await reply(chatId, 'Usage: /use <name>');
        return;
      }
      const previous = store.active(chatId).name;
      const res = store.setActive(chatId, arg);
      if (!res.ok) {
        await reply(chatId, `No session named *${arg}*. Use /sessions to list.`);
        return;
      }
      try {
        await store.save();
      } catch (err) {
        store.setActive(chatId, previous); // roll back
        await reply(chatId, `❌ Could not switch session (failed to save): ${err.message}`);
        return;
      }
      await reply(chatId, `🔀 Switched to *${arg}*.`);
      return;
    }

    case 'stop': {
      const removed = queue.clearChat(chatId);
      let cancelNote = 'no running job in this chat';
      if (currentRun && currentRun.chatId === chatId && !currentRun.cancelled) {
        currentRun.cancel('stopped by /stop');
        cancelNote = `running job *${currentRun.job.sessionName}* cancelled`;
      }
      await reply(chatId, `🛑 ${cancelNote}; ${removed} queued job(s) removed.`);
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
 */
function advanceOffset(current, updateId, osImpl = offsetStore) {
  const next = Math.max(current, updateId + 1);
  osImpl.commit(next); // intentionally before handling (at-most-once)
  return next;
}

/**
 * Backlog policy at startup.
 *
 * - Persisted offset exists  -> resume normally from it (never purge).
 * - No offset (first start)  -> PROCESS_INITIAL_BACKLOG=false (default):
 *   fetch once with offset = -1; Telegram's documented behavior is to skip
 *   all pending updates and return only the most recent one, moving the
 *   cursor past historical messages so offline commands are NOT executed.
 *   With PROCESS_INITIAL_BACKLOG=true the backlog is consumed normally.
 */
async function purgeBacklogIfFirstStart({ osImpl = offsetStore, tgImpl = tg } = {}) {
  const persisted = osImpl.load();
  if (persisted !== null) {
    logInfo(`resuming from persisted Telegram offset ${persisted}`);
    return persisted;
  }
  // Read at call time (not import time) so tests can exercise both branches.
  if (/^(1|true|yes)$/i.test(process.env.PROCESS_INITIAL_BACKLOG || '')) {
    logInfo('PROCESS_INITIAL_BACKLOG=true: will process any messages sent while offline');
    return 0;
  }
  let latest = null;
  try {
    const updates = await tgImpl.request('getUpdates', { offset: -1, timeout: 0, allowed_updates: ['message'] });
    if (Array.isArray(updates) && updates.length > 0) {
      latest = updates[updates.length - 1].update_id;
      logInfo(`first start: skipping ${latest + 1} backlog update(s) sent while offline (set PROCESS_INITIAL_BACKLOG=true to change)`);
      advanceOffset(-1, latest, osImpl);
    }
  } catch (err) {
    // Telegram unreachable: nothing to purge yet; normal polling will retry.
    logWarn('backlog probe skipped:', err.message);
  }
  return latest === null ? 0 : latest + 1;
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
        offset = advanceOffset(offset, upd.update_id); // persisted BEFORE handling
        try {
          if (upd.message) await handleMessage(upd.message);
        } catch (err) {
          logError('handler error:', err.message);
        }
      }
    } catch (err) {
      if (shuttingDown) break;
      tg.markFailure();
      logWarn('poll error:', err.message, '— retrying in 10s');
      await sleep(10_000);
    }
  }
  logInfo('polling stopped');
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;

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
  Promise.race([store.flush(), sleep(3000)]).then(() => { // 6-7.
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
    purgeBacklogIfFirstStart,
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
