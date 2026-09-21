# Telegram ↔ Claude Code Bridge — Documentation

A self-hosted bridge that lets you drive a local **Claude Code** harness from
**Telegram**. You send tasks to **your own bot** (any name registered with
@BotFather); each message becomes the prompt for `claude -p` on this machine,
and the final report is delivered back to your chat.

Built for **censored networks** (countries where Telegram is blocked): all bot
traffic can flow through any VPN/proxy you run on Windows, and **no proxy or
endpoint is hard-coded** — the route is auto-detected at runtime.

---

## Table of contents

1. [How it works](#1-how-it-works)
2. [Project layout](#2-project-layout)
3. [Requirements](#3-requirements)
4. [One-time setup](#4-one-time-setup)
5. [Running the bridge](#5-running-the-bridge)
6. [Telegram commands](#6-telegram-commands)
7. [Sessions explained](#7-sessions-explained)
8. [Proxy & censorship handling](#8-proxy--censorship-handling)
9. [Model provider & relays](#9-model-provider--relays)
10. [Security model](#10-security-model)
11. [Configuration reference (.env)](#11-configuration-reference-env)
12. [Testing](#12-testing)
13. [Troubleshooting](#13-troubleshooting)
14. [Extending the bridge](#14-extending-the-bridge)

---

## 1. How it works

```
┌───────────┐  HTTPS long polling    ┌─────────────────┐  spawn (no shell) ┌──────────────┐
│  Telegram │ ─────────────────────► │  bridge.js      │ ─────────────────► │ claude -p    │
│  cloud    │ ◄───────────────────── │  (this machine) │ ◄───────────────── │ (session)    │
└───────────┘  reports back as chat  └─────────────────┘  stdout (bounded) └──────────────┘
        │                                    │                              │
        ▼                                    ▼                              ▼
  blocked locally —                 proxy auto-detection:            reads your own
  all traffic goes via              explicit → env → Windows         ~/.claude/settings.json
  your VPN/proxy                    registry → direct                (any provider/relay)
```

Message lifecycle:

1. **Receive** — long polling (`getUpdates`, 50 s windows). The update offset is
   persisted before handling, so a restart never re-executes an old command.
2. **Authorize** — the sender's Telegram user ID must be in `ALLOWED_TELEGRAM_IDS`;
   otherwise the message is ignored (fail closed).
3. **Queue** — the exact message text becomes a job (global FIFO across chats,
   at most `MAX_QUEUE_PER_CHAT` waiting jobs per chat, one `claude` process at a time).
4. **Execute** — `spawn('claude', ['-p', <your text>, '--output-format', 'text',
   '--dangerously-skip-permissions', ('--resume'|'--session-id'), <uuid>])` —
   the prompt is passed as a spawn argument, never through a shell.
5. **Report** — the result is sent back, chunked at 3,800 characters, with a
   plain-text fallback if Markdown fails. stdout/stderr capture is bounded
   (`MAX_STDOUT_BYTES` / `MAX_STDERR_BYTES`) with explicit truncation markers.
6. **Persist** — sessions are stored in `state/sessions.json`, written atomically
   (temp file + rename), so an interrupted write cannot corrupt state.

Hard timeout per job: `CLAUDE_TIMEOUT_MS` (default 30 min; SIGTERM then SIGKILL).
`error` and `close` child events are guarded so a job completes exactly once.

---

## 2. Project layout

```
<bridge folder>
├── bridge.js            # wiring: config, polling, commands, job runner, shutdown
├── lib/
│   ├── config.js        # env parsing/validation, session-name rules (pure, tested)
│   ├── commands.js      # canonical command list, parser, help text (pure, tested)
│   ├── proxy.js         # resolution chain, Windows parsing, redacted labels (pure, tested)
│   ├── sessions.js      # session store, migration, atomic persistence (fs-injectable)
│   ├── queue.js         # global FIFO job queue with per-chat caps (pure, tested)
│   └── telegram.js      # Bot API client over https.request with real proxy agents
├── test/bridge.test.js  # 30 sandboxed tests (npm test)
├── package.json
├── .env                 # your real config (gitignored — token lives here)
├── .env.example         # commit-safe template to copy from
├── .gitignore
├── start-bridge.cmd     # double-click launcher (Windows)
├── README.md            # quick start
├── DOCUMENTATION.md     # this file
└── state\
    ├── sessions.json    # chatId → { active, list: { name → {id, initialized} } }
    └── offset.txt       # Telegram update offset (crash-safe resume)
```

---

## 3. Requirements

| Component | Requirement |
|---|---|
| Node.js | ≥ 18 (v22 tested) |
| Claude Code CLI (`claude`) | installed and on PATH (`claude -p "hi"` works); else set `CLAUDE_BIN` |
| Working model backend | whatever your `claude` is configured for (Anthropic, or a relay via `ANTHROPIC_BASE_URL`) |
| VPN / proxy for Telegram | needed only where Telegram is blocked |
| A Telegram bot | create one with @BotFather, any name |

Check headless Claude any time:

```cmd
claude -p "Reply with exactly: BRIDGE_TEST_OK"
```

> Warnings like `[claude-code:unrecognized_model]` for custom model names
> (e.g. `provider/my-model`) are harmless — the model still answers through
> your configured backend.

---

## 4. One-time setup

```cmd
git clone https://github.com/AliShahsavandInanloo/telegram-claude-bridge.git
cd telegram-claude-bridge
npm install
copy .env.example .env
```

Then edit `.env` — **both variables are required; the bridge refuses to start
without them**:

1. **`TELEGRAM_BOT_TOKEN`** — from @BotFather for **your** bot. Keep it secret.
2. **`ALLOWED_TELEGRAM_IDS`** — your numeric Telegram user ID(s), comma-separated
   (get them from @userinfobot). There is no open-access mode: an empty or
   missing allowlist is a startup error, because Claude runs with broad
   permissions on this machine (see [Security](#10-security-model)).

---

## 5. Running the bridge

**Option A — double-click** `start-bridge.cmd`.

**Option B — terminal:**

```cmd
cd telegram-claude-bridge
node bridge.js
```

Expected startup (VPN already on):

```
… [info] allowlist: 1 authorized user(s)
… [info] authorized as @YourBot. Proxy: http://127.0.0.1:10809/ [system]
… [info] registered 8 bot commands with Telegram
… [info] listening for messages… (Ctrl+C to stop)
```

**Start order does not matter.** If Telegram is unreachable (VPN off) the
bridge waits and retries, re-probing your proxy settings on every attempt —
turn the VPN on whenever, the bridge joins on its own.

Ctrl+C / SIGTERM shuts down gracefully: polling stops, the running job is
terminated (SIGTERM → SIGKILL after 3 s), session state is flushed, exit.

---

## 6. Telegram commands

Commands are registered automatically via `setMyCommands` (and the chat menu
button is set to the commands list), so typing `/` shows an autocomplete menu.
All definitions live in one canonical list (`lib/commands.js`), which also
drives `/help`.

| Command | Effect |
|---|---|
| `/start`, `/help` | show the command summary |
| `/new <name>` | create a **fresh named session** and switch to it |
| `/sessions` | list all sessions; `▶️` marks the active one, `(new)` = Claude hasn't used it yet |
| `/use <name>` | switch the active session |
| `/stop` | cancel the running job **of this chat** (SIGTERM) and clear this chat's queued jobs; reports what was cancelled/removed |
| `/queue` | running job, queued in this chat, global queued count |
| `/status` | Claude executable, active session, running job, queue, proxy (credentials redacted), uptime |
| any other text | becomes the prompt for the active session; the report comes back here |

Group-style suffixes work: `/status@YourBot` is accepted; commands addressed to
a **different** bot are ignored. Non-text messages (photos, stickers, edits)
are ignored. `/stop` and `/queue` only ever affect the chat that issued them.

---

## 7. Sessions explained

- A **session** is one persistent Claude Code conversation identified by a UUID.
- Lifecycle: `/new` (or the first task on a fresh chat) **allocates** the session
  locally as *uninitialized*. Its first job runs with `--session-id <uuid>`.
  Only after Claude exits successfully is the session marked *initialized*;
  every later job resumes it with `--resume <uuid>`. If Claude fails before
  establishing the session, it stays uninitialized and is retried the same way.
- Sessions are **per chat and named** (`/new work`, `/new trade`, `/use work`).
- **Queue safety:** each queued job captures the session ID it targeted at
  enqueue time. If you `/new` or `/use` while jobs are waiting, older jobs still
  run against the session they were queued for.
- `state/sessions.json` maps names to `{id, initialized}` — written atomically;
  old flat-format files (name → uuid) are migrated automatically. A corrupted
  file is backed up as `sessions.json.corrupt-*.bak` and the bridge starts fresh.
- The working directory for every job is `BRIDGE_CWD` if set, otherwise the
  bridge folder. Claude can still read/edit elsewhere via absolute paths since
  permissions are skipped.
- A running job can be cancelled via `/stop` (SIGTERM, then SIGKILL after 5 s);
  a cancelled job does **not** mark its session initialized.

---

## 8. Proxy & censorship handling

This section is the reason the bridge works where Telegram is banned.

### Resolution order (no hard-coded infrastructure)

1. `TELEGRAM_PROXY_URL` in `.env` — explicit override (`socks5://…`, `http(s)://…`)
2. `HTTPS_PROXY` / `https_proxy` / `ALL_PROXY` / `HTTP_PROXY` environment variables
3. **Windows system proxy** — read live from the registry
   (`HKCU\…\Internet Settings`, `ProxyEnable` + `ProxyServer`). Semicolon forms
   like `http=127.0.0.1:10809;https=127.0.0.1:10809` are parsed, preferring the
   `https=` entry; malformed values are ignored, never fatal.
4. Direct connection

**Loopback proxies are valid** — v2rayN-style tools listen on `127.0.0.1`;
they are never rejected for being local.

### Real proxy support (not cosmetic)

Bot API calls use Node's `https.request` with `https-proxy-agent` /
`socks-proxy-agent`. (The previous implementation passed these agents to
built-in `fetch()`, which is Undici-based and silently ignores the `agent`
option — so proxies appeared configured but were never used.)

### Self-healing

- Every network error triggers a re-probe on the next request; settings are also
  re-checked every 60 s, so VPN on/off is noticed automatically.
- Retries use escalating backoff (5 s → 10 s … max 30 s, 6 attempts per call);
  HTTP 429 `retry_after` is honored.

### Credential safety

Proxy URLs may embed `user:pass@`. Labels and logs use a redacting helper
(`safeProxyLabel`): `http://***:***@127.0.0.1:8080` — credentials never appear
in startup logs, `/status`, Telegram messages, or errors. The actual connection
still uses the full URL.

### If your VPN does not set the Windows system proxy

TUN-mode VPNs need nothing (traffic just flows). If your VPN exposes a local
SOCKS/HTTP port and doesn't register it as system proxy, pin it once:

```ini
TELEGRAM_PROXY_URL=socks5://127.0.0.1:10808
```

Verify what works with curl first:

```cmd
curl.exe -s -m 8 https://api.telegram.org/ -o NUL -w "%{http_code}"
curl.exe -s -m 8 -x http://127.0.0.1:10809 https://api.telegram.org/ -o NUL -w "%{http_code}"
```

`200` on any line = that route works.

---

## 9. Model provider & relays

The bridge **never touches provider config**. It spawns `claude` with your
full environment, so Claude Code reads your own `~/.claude/settings.json`
(`%USERPROFILE%\.claude\settings.json` on Windows):

- `ANTHROPIC_BASE_URL` pointing at any relay (a local router, a gateway, etc.)
- any custom model mappings (`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`)

Consequences:

- No Anthropic API key is needed when your backend supplies its own auth.
- If your model backend/relay is down, jobs fail with a provider error —
  start it first.
- To change models, change your own settings as usual; the bridge follows.

---

## 10. Security model

| Layer | Mechanism |
|---|---|
| Who can talk | `ALLOWED_TELEGRAM_IDS` allowlist — **required**, fail closed |
| Unknown users | silently ignored; cannot enqueue, create sessions, stop jobs, or read status |
| What a job can do | full machine access (`--dangerously-skip-permissions`) in the configured working directory |
| Prompt transport | exact Telegram text passed as a spawn argument (array form, `shell: false`) — never shell-interpolated |
| Token storage | `.env`, excluded from git by `.gitignore` |
| Logs | leveled (`info/warn/error`, optional `BRIDGE_DEBUG=1`); never contain the token, prompt contents, or proxy credentials |
| Session names | validated (alphanumeric + `._-`, ≤ 32 chars, reserved names rejected) — no prototype pollution, no path traversal |

Because Claude runs with `--dangerously-skip-permissions`, the Telegram
allowlist is the security boundary: treat it like giving those people shell
access to this machine. To revoke access, remove the ID from `.env` and restart.

---

## 11. Configuration reference (.env)

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | from @BotFather (fallback: `TELEGRAM_CLAUDE_BOT_TOKEN`) |
| `ALLOWED_TELEGRAM_IDS` | **yes** | — | comma-separated numeric user IDs; missing/empty/malformed = startup error |
| `TELEGRAM_PROXY_URL` | no | auto | explicit proxy for Telegram traffic (loopback hosts allowed) |
| `CLAUDE_BIN` | no | `claude` | full path to the claude executable if not on PATH |
| `BRIDGE_CWD` | no | bridge folder | working directory for Claude jobs (must exist) |
| `CLAUDE_TIMEOUT_MS` | no | `1800000` | per-job timeout (5 s … 4 h) |
| `MAX_QUEUE_PER_CHAT` | no | `3` | max waiting jobs per chat (1 … 100) |
| `MAX_STDOUT_BYTES` | no | `524288` | captured claude stdout per job (1 KiB … 8 MiB) |
| `MAX_STDERR_BYTES` | no | `65536` | captured claude stderr per job (1 KiB … 1 MiB) |
| `BRIDGE_DEBUG` | no | off | `1` = verbose debug logging |

Invalid values **fail startup with a clear message** rather than falling back
silently. All numeric vars are range-checked; the proxy URL is syntax-checked;
the state directory must be writable; `CLAUDE_BIN` paths are existence-checked
at startup.

---

## 12. Testing

```cmd
npm test
```

30 sandboxed tests (no framework, no network, no spawned claude) verify:
fail-closed auth and config validation; prompt text reaching Claude's args;
`--session-id` vs `--resume` semantics; queued jobs keeping their session
identity; group-suffix command parsing; command-menu consistency; proxy label
redaction; Windows semicolon proxy parsing; loopback proxy acceptance;
double-completion guard; bounded capture; global FIFO queue fairness;
atomic session persistence + corruption recovery; and that the bot token
never leaks into outgoing messages.

`npm run check` runs a syntax check on `bridge.js`.

---

## 13. Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `refusing to start: ALLOWED_TELEGRAM_IDS …` | set your numeric ID(s) in `.env` (required) |
| `cannot reach Telegram yet` repeats | VPN off/broken → start it; the bridge self-recovers. Or pin `TELEGRAM_PROXY_URL`. |
| `Telegram getMe failed: 401` | wrong token in `.env` → re-copy from @BotFather |
| `refusing to start: CLAUDE_BIN …` | path doesn't exist or isn't executable |
| `refusing to start: TELEGRAM_PROXY_URL …` | invalid proxy URL syntax |
| Bot silent to a user | that user is not in `ALLOWED_TELEGRAM_IDS` (by design) |
| Job fails instantly with provider error | your model backend/relay is down → start it |
| Report says `(exit 124)` / timeout | job hit `CLAUDE_TIMEOUT_MS` → split the task smaller |
| `_(stdout truncated …)_` in reports | output exceeded `MAX_STDOUT_BYTES`; raise it if needed |
| Reply shows raw `*text*` | Markdown fallback kicked in — cosmetic only |
| 429 / flood warnings | sending too fast; the bridge honors `retry_after` automatically |

Diagnostics cheat sheet:

```cmd
:: 1. Claude headless works?
claude -p "say ok"

:: 2. Model backend/relay up? (use the address from your ANTHROPIC_BASE_URL)
curl -s -m 5 http://localhost:<relay-port>/ -o NUL -w "%{http_code}"

:: 3. Telegram reachable (some line must print 200)?
curl.exe -s -m 8 https://api.telegram.org/ -o NUL -w "%{http_code}"
curl.exe -s -m 8 -x http://127.0.0.1:10809 https://api.telegram.org/ -o NUL -w "%{http_code}"

:: 4. Bridge state
type state\sessions.json
type state\offset.txt
```

---

## 14. Extending the bridge

Natural next steps, all localized:

- **Per-session working directories** — a `/cwd <path>` command storing a `cwd`
  per session (validate against an allowed-roots list before use).
- **Progress streaming** — run jobs with `--output-format stream-json` and post
  interim updates every N seconds.
- **File delivery** — upload files Claude produces via `sendDocument`.
- **Voice notes** — transcribe OGG voice messages before queueing.
- **Windows auto-start** — Task Scheduler job running `node bridge.js` at logon.

See also: [README.md](README.md) for the quick-start version.
