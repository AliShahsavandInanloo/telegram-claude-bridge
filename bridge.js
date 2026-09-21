#!/usr/bin/env node
/**
 * Telegram <-> Claude Code bridge
 * --------------------------------
 * Polls Telegram for messages (long polling), forwards each allowed user's
 * message to a persistent `claude -p` session, and replies with the result.
 *
 * Designed for censored networks (no hard-coded infrastructure):
 *   1. TELEGRAM_PROXY_URL in .env (socks5://user:pass@host:port or http://...)
 *   2. HTTPS_PROXY / HTTP_PROXY / ALL_PROXY environment variables
 *   3. Windows system proxy (read live from the registry — what VPN clients set)
 *   4. Direct connection
 * Proxy is re-resolved automatically whenever requests fail, so you can turn
 * your VPN on/off at any time and the bridge recovers on its own.
 *
 * Commands: /new <name>, /sessions, /stop, /stop <name>, /queue, /status
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT = __dirname;
const STATE_DIR = path.join(ROOT, 'state');
const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnvFile();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_CLAUDE_BOT_TOKEN || '';
const EXPLICIT_PROXY = process.env.TELEGRAM_PROXY_URL || '';
const ALLOWED = new Set(
  (process.env.ALLOWED_TELEGRAM_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);
const OPEN_ACCESS = ALLOWED.size === 0; // first user to talk to the bot claims it
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const POLL_TIMEOUT_S = 50;
const CLAUDE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min per job
const MAX_QUEUE_PER_CHAT = 3;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

// ---------------------------------------------------------------------------
// Proxy resolution (no hard-coded endpoints; re-resolved on failure)
// ---------------------------------------------------------------------------

let currentAgent = null;
let currentAgentLabel = 'direct';
let needsReprobe = false;

function readWindowsSystemProxy() {
  if (process.platform !== 'win32') return null;
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const out = require('child_process')
      .execSync(`reg query "${key}" /v ProxyEnable & reg query "${key}" /v ProxyServer`, {
        encoding: 'utf8',
        timeout: 3000,
      });
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/.test(out);
    const server = (out.match(/ProxyServer\s+REG_SZ\s+(\S+)/) || [])[1];
    if (!enabled || !server) return null;
    if (server.includes(';')) {
      const httpsPart = server.split(';').find((p) => p.toLowerCase().startsWith('https='));
      if (httpsPart) server = httpsPart.split('=')[1];
      else server = server.split(';')[0].split('=').pop();
    }
    let url = server.includes('://') ? server : `http://${server}`;
    const u = new URL(url);
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return null; // local relays can't reach Telegram
    return url;
  } catch {
    return null;
  }
}

function resolveProxyUrl() {
  if (EXPLICIT_PROXY) return { url: EXPLICIT_PROXY, label: 'explicit (env)' };
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (envProxy) return { url: envProxy, label: 'environment' };
  const sysProxy = readWindowsSystemProxy();
  if (sysProxy) return { url: sysProxy, label: 'windows system proxy' };
  return null;
}

function makeAgent(proxyUrl) {
  const u = new URL(proxyUrl);
  if (u.protocol.startsWith('socks')) return new SocksProxyAgent(proxyUrl);
  return new HttpsProxyAgent(proxyUrl);
}

function refreshAgent(reason) {
  const found = resolveProxyUrl();
  const agent = found ? makeAgent(found.url) : null;
  const label = found ? `${found.url} [${found.label}]` : 'direct';
  if (label !== currentAgentLabel) {
    currentAgent = agent;
    currentAgentLabel = label;
    log(`proxy -> ${label}${reason ? ` (${reason})` : ''}`);
  }
  needsReprobe = false;
}

function agentForRequest() {
  if (needsReprobe) refreshAgent('re-probe');
  return { agent: currentAgent, label: currentAgentLabel };
}

function markConnectionFailure() {
  needsReprobe = true; // next request re-reads env + registry (VPN may have started)
}

// ---------------------------------------------------------------------------
// Telegram API
// ---------------------------------------------------------------------------

async function tgApi(method, params, attempt = 1) {
  const { agent } = agentForRequest();
  const maxAttempts = 6;
  try {
    const res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params || {}),
      agent,
      signal: AbortSignal.timeout(90_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const retryAfter = data.parameters && data.parameters.retry_after;
      const desc = data.description || `HTTP ${res.status}`;
      if (res.status === 429 && retryAfter) {
        log(`rate limited on ${method}, waiting ${retryAfter}s`);
        await sleep((retryAfter + 1) * 1000);
        return tgApi(method, params, attempt);
      }
      throw new Error(`Telegram ${method} failed: ${desc}`);
    }
    return data.result;
  } catch (err) {
    const isNetwork = err && (err.cause || /fetch failed|network|ECONN|ETIMEDOUT|ENOTFOUND|socket/i.test(String(err.message || err)));
    if (isNetwork && attempt < maxAttempts) {
      markConnectionFailure();
      const wait = Math.min(30, attempt * 5);
      log(`network error on ${method} (attempt ${attempt}/${maxAttempts}), retrying in ${wait}s via ${currentAgentLabel}`);
      await sleep(wait * 1000);
      return tgApi(method, params, attempt + 1);
    }
    throw err;
  }
}

async function sendChunk(agent, chatId, text) {
  await tgApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  }).catch(async () => {
    // Markdown parse errors: fall back to plain text
    await tgApi('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
  });
  void agent;
}

async function reply(chatId, text) {
  const { label } = agentForRequest();
  const LIMIT = 3800;
  let first = true;
  for (let i = 0; i < text.length; i += LIMIT) {
    let part = text.slice(i, i + LIMIT);
    if (first && label !== 'direct' && i === 0) part = `[_via ${label}_]\n\n${part}`;
    await sendChunk(currentAgent, chatId, part);
    first = false;
    if (i + LIMIT < text.length) await sleep(600);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Sessions (named, persistent, per chat)
// ---------------------------------------------------------------------------

function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveSessions() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

const sessions = loadSessions(); // chatId -> { active, list: {name -> sessionId} }

function getChatState(chatId) {
  if (!sessions[chatId]) sessions[chatId] = { active: 'default', list: {} };
  return sessions[chatId];
}

// ---------------------------------------------------------------------------
// Claude job queue (one claude process at a time, FIFO per arrival)
// ---------------------------------------------------------------------------

const queues = new Map(); // chatId -> array of jobs
let running = false;

function enqueue(chatId, job) {
  if (!queues.has(chatId)) queues.set(chatId, []);
  const q = queues.get(chatId);
  if (q.length >= MAX_QUEUE_PER_CHAT) {
    reply(chatId, `⚠️ Queue is full (${MAX_QUEUE_PER_CHAT}). Wait for current jobs to finish.`);
    return;
  }
  q.push(job);
  reply(chatId, `📥 Queued at position ${q.length} for session *${job.sessionName}*. You'll get the report here.`);
  drain();
}

function drain() {
  if (running) return;
  const next = [...queues.entries()].find(([, q]) => q.length > 0);
  if (!next) return;
  running = true;
  const [chatId, q] = next;
  const job = q.shift();
  runClaudeJob(chatId, job)
    .catch((err) => reply(chatId, `❌ Job failed: ${err.message}`))
    .finally(() => {
      running = false;
      setTimeout(drain, 300);
    });
}

function runClaudeJob(chatId, job) {
  return new Promise((resolve) => {
    const st = getChatState(chatId);
    const sessionId = st.list[job.sessionName];
    const args = ['-p', '--output-format', 'text', '--dangerously-skip-permissions'];
    if (sessionId) args.push('--resume', sessionId);
    else args.push('--session-id', job.sessionId);
    const started = Date.now();
    log(`job start chat=${chatId} session=${job.sessionName} resume=${!!sessionId}`);

    const child = spawn('claude', args, {
      cwd: job.cwd,
      env: process.env, // inherits ANTHROPIC_BASE_URL / agentrouter / omniroute config
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), CLAUDE_TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reply(chatId, `❌ Could not launch claude CLI: ${err.message}`);
      resolve();
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      const secs = Math.round((Date.now() - started) / 1000);
      log(`job done chat=${chatId} code=${code} in ${secs}s out=${stdout.length}B`);
      let header = `🤖 *${job.sessionName}* — done in ${secs}s`;
      if (code !== 0) header += ` (exit ${code})`;
      let body = stdout.trim();
      if (!body && stderr.trim()) body = `stderr:\n${stderr.trim().slice(0, 3000)}`;
      if (!body) body = '_(no output)_';
      try {
        await reply(chatId, `${header}\n\n${body}`);
      } catch (err) {
        log('failed to deliver report:', err.message);
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function randomSessionId() {
  return require('crypto').randomUUID();
}

function helpText(openAccess) {
  return [
    '*ShiClaude bridge* — talk to your local Claude Code harness.',
    '',
    '`/new <name>` — start a fresh named session (then just type tasks)',
    '`/sessions` — list sessions and the active one',
    '`/use <name>` — switch active session',
    '`/stop` — cancel the queued job(s) for this chat',
    '`/status` — proxy + queue status',
    '',
    'Any other text is sent to the active session as a task; the final report comes back here.',
    openAccess ? '\n⚠️ No ALLOWED_TELEGRAM_IDS set — the first person who messages claims this bot.' : '',
  ].join('\n');
}

let botUsername = '';

async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  const userId = String(msg.from && msg.from.id);
  const text = (msg.text || '').trim();

  if (!OPEN_ACCESS && !ALLOWED.has(userId)) {
    log(`rejected user ${userId} in chat ${chatId}`);
    return;
  }
  if (OPEN_ACCESS) {
    ALLOWED.add(userId);
    log(`OPEN_ACCESS: user ${userId} claimed the bot`);
  }

  log(`msg from ${userId} chat=${chatId}: ${text.slice(0, 80).replace(/\n/g, ' ')}`);

  if (text.startsWith('/')) {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ').trim();
    const st = getChatState(chatId);
    switch (cmd) {
      case '/start':
      case '/help':
        await reply(chatId, helpText(OPEN_ACCESS));
        return;
      case '/new': {
        const name = (arg || `s-${Date.now().toString(36)}`).replace(/[^\w-]/g, '-').slice(0, 32);
        st.list[name] = randomSessionId();
        st.active = name;
        saveSessions();
        await reply(chatId, `✨ New session *${name}* created and active. Send me your first task.`);
        return;
      }
      case '/use': {
        if (st.list[arg]) {
          st.active = arg;
          saveSessions();
          await reply(chatId, `🔀 Switched to *${arg}*.`);
        } else {
          await reply(chatId, `No session named *${arg}*.`);
        }
        return;
      }
      case '/sessions': {
        const lines = Object.keys(st.list).map((n) => `${n === st.active ? '▶️' : '  '} *${n}*`);
        await reply(chatId, lines.length ? `Sessions:\n${lines.join('\n')}` : 'No sessions yet. Use /new <name>.');
        return;
      }
      case '/stop': {
        const q = queues.get(chatId);
        if (arg && st.list[arg] && st.active === arg) {
          await reply(chatId, `Session *${arg}* is the active session; it will stop after the current job. Use /new to replace it.`);
        } else if (q && q.length) {
          q.length = 0;
          await reply(chatId, '🛑 Queued jobs cleared. (A job already running cannot be interrupted safely.)');
        } else {
          await reply(chatId, 'Nothing queued right now.');
        }
        return;
      }
      case '/status': {
        const { label } = agentForRequest();
        const q = queues.get(chatId) || [];
        await reply(chatId, `Proxy: *${label}*\nQueue: ${q.length} job(s)\nActive session: *${st.active}*`);
        return;
      }
      default:
        await reply(chatId, helpText(OPEN_ACCESS));
        return;
    }
  }

  if (!text) return;

  const st = getChatState(chatId);
  const sessionName = st.active;
  if (!st.list[sessionName]) {
    st.list[sessionName] = randomSessionId();
    saveSessions();
  }
  enqueue(chatId, { sessionName, sessionId: st.list[sessionName], text, cwd: ROOT });
}

// ---------------------------------------------------------------------------
// Long polling loop
// ---------------------------------------------------------------------------

async function pollLoop() {
  let offset = 0;
  while (true) {
    try {
      const updates = await tgApi('getUpdates', {
        offset,
        timeout: POLL_TIMEOUT_S,
        allowed_updates: ['message'],
      });
      for (const upd of updates || []) {
        offset = upd.update_id + 1;
        if (upd.message) handleMessage(upd.message).catch((e) => log('handler error:', e.message));
      }
    } catch (err) {
      markConnectionFailure();
      log('poll error:', err.message || err, '— retrying in 10s');
      await sleep(10_000);
    }
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

(async () => {
  if (!BOT_TOKEN) {
    console.error('Missing TELEGRAM_BOT_TOKEN. Put it in .env next to bridge.js');
    process.exit(1);
  }
  refreshAgent('startup');
  fs.mkdirSync(STATE_DIR, { recursive: true });

  let me = null;
  while (!me) {
    try {
      me = await tgApi('getMe', {});
    } catch (err) {
      log('cannot reach Telegram yet:', err.message || err, '— start your VPN; retrying in 15s');
      await sleep(15_000);
    }
  }
  botUsername = me.username || '';
  log(`authorized as @${botUsername}. Proxy: ${currentAgentLabel}`);
  log(`access: ${OPEN_ACCESS ? 'OPEN (first user claims)' : `allowlist [${[...ALLOWED].join(', ')}]`}`);
  log('listening for messages… (Ctrl+C to stop)');

  setInterval(() => { needsReprobe = true; }, 60_000); // periodically notice VPN changes even without failures
  pollLoop();
})();
