# ShiClaude — Telegram ↔ Claude Code Bridge — Documentation

A self-hosted bridge that lets you drive a local **Claude Code** harness from
**Telegram**. You send tasks to your bot (`@ShiClaude_bot`), they are executed by
`claude` on this machine, and the final report is delivered back to your chat.

It is built specifically for **censored networks** (countries where Telegram is
blocked): all bot traffic can flow through any VPN/proxy you run on Windows, and
**no proxy or endpoint is hard-coded** — the route is auto-detected at runtime.

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
9. [Model provider (agentrouter / omniroute)](#9-model-provider-agentrouter--omniroute)
10. [Security model](#10-security-model)
11. [Configuration reference (.env)](#11-configuration-reference-env)
12. [Troubleshooting](#12-troubleshooting)
13. [Extending the bridge](#13-extending-the-bridge)

---

## 1. How it works

```
┌───────────┐   HTTPS (long polling)   ┌─────────────────┐    spawn     ┌──────────────┐
│  Telegram │ ───────────────────────► │  bridge.js      │ ───────────► │ claude -p    │
│  cloud    │ ◄─────────────────────── │  (this machine) │ ◄─────────── │ (session)    │
└───────────┘   reports back as chat   └─────────────────┘   stdout     └──────────────┘
        │                                      │                            │
        ▼                                      ▼                            ▼
  blocked locally —                    auto-detected proxy:          reads your own
  all traffic goes via                 env vars → Windows            ~/.claude/settings.json
  your VPN/proxy                       registry → direct             (agentrouter relay)
```

The message lifecycle:

1. **Receive** — the bridge long-polls Telegram (`getUpdates`, 50 s windows).
2. **Authorize** — the sender's Telegram user ID must be in the allowlist.
3. **Queue** — the text becomes a job (max 3 queued per chat; one `claude`
   process runs at a time globally).
4. **Execute** — the job spawns `claude -p --output-format text`
   `--dangerously-skip-permissions`, plus either `--resume <sessionId>` for an
   existing session or `--session-id <newUUID>` for a fresh one.
5. **Report** — the final result text is sent back to your chat, chunked at
   3,800 characters if long, with a Markdown-fallback to plain text.
6. **Persist** — session IDs are stored in `state/sessions.json`, so context
   survives bridge restarts.

Hard timeout per job: **30 minutes** (process killed, exit code reported).

---

## 2. Project layout

```
I:\Claude\telegram-claude-bridge\
├── bridge.js            # the entire bridge (single file, no build step)
├── package.json         # deps: https-proxy-agent, socks-proxy-agent
├── .env                 # bot token, allowlist, optional proxy (gitignored)
├── .gitignore
├── start-bridge.cmd     # double-click launcher (Windows)
├── README.md            # quick-start
├── DOCUMENTATION.md     # this file
├── node_modules\        # created by npm install
└── state\
    └── sessions.json    # chatId → { active, list: { name → sessionId } }
```

---

## 3. Requirements

| Component | Status on this machine |
|---|---|
| Node.js ≥ 18 | ✅ v22.23.1 |
| Claude Code CLI (`claude`) | ✅ v2.1.267 (`C:\Users\ali\.local\bin\claude.exe`) |
| Working model backend | ✅ your agentrouter/omniroute relay on `localhost:20128` |
| VPN / proxy for Telegram | needed only when Telegram is blocked (it is) |

Check headless Claude any time:

```cmd
claude -p "Reply with exactly: BRIDGE_TEST_OK"
```

> The log line `[claude-code:unrecognized_model] …agentrouter/deepseek-v4-flash`
> is a harmless warning — the model still answers through your relay.

---

## 4. One-time setup

```cmd
cd /d I:\Claude\telegram-claude-bridge
npm install
```

Then edit `.env`:

1. **`TELEGRAM_BOT_TOKEN`** — already written from your environment (46-char
   token from @BotFather for `@ShiClaude_bot`). Keep it secret.
2. **`ALLOWED_TELEGRAM_IDS`** — your numeric Telegram user ID(s), comma
   separated. Get it from **@userinfobot**. Leave empty only for first
   claiming (see [Security](#10-security-model)).

---

## 5. Running the bridge

**Option A — double-click** `start-bridge.cmd`.

**Option B — terminal:**

```cmd
cd /d I:\Claude\telegram-claude-bridge
node bridge.js
```

Expected startup (VPN already on):

```
… - proxy -> 127.0.0.1:10809 [windows system proxy]
… - authorized as @ShiClaude_bot. Proxy: …
… - access: allowlist [123456789]
… - listening for messages… (Ctrl+C to stop)
```

**Start order does not matter.** If Telegram is unreachable (VPN off) the
bridge waits and retries every 10–30 s, re-probing your proxy settings on
every attempt — turn the VPN on whenever, the bridge joins on its own.

---

## 6. Telegram commands

| Command | Effect |
|---|---|
| `/start`, `/help` | show the command summary |
| `/new <name>` | create a **fresh named session** and switch to it |
| `/sessions` | list all sessions; `▶️` marks the active one |
| `/use <name>` | switch the active session |
| `/stop` | clear queued jobs for this chat (running job finishes naturally) |
| `/status` | current proxy route, queue depth, active session |
| **any other text** | becomes a task for the active session; the report comes back here |

Example conversation:

```
you:    /new nds-indicator
bot:    ✨ New session *nds-indicator* created and active. Send me your first task.
you:    analyze the fractal indicator code in I:\Claude\NDS Indicator and
        summarize what the entry logic does
bot:    📥 Queued at position 1 for session *nds-indicator*…
bot:    🤖 *nds-indicator* — done in 74s
        The entry logic works in three stages: …
```

---

## 7. Sessions explained

- A **session** is one persistent Claude Code conversation, identified by a
  UUID (`--session-id` on first use, `--resume` afterwards).
- Sessions are **per chat and named**; you can keep several projects side by
  side (`/new work`, `/new trade`, `/use work`).
- Names are sanitized to letters/digits/`-`/`_`, max 32 chars.
- `state/sessions.json` maps names to UUIDs — **don't delete it** if you want
  to keep context. Deleting a line there simply makes the next task start a
  fresh conversation.
- The bridge folder (`I:\Claude\telegram-claude-bridge`) is the working
  directory for every job, so relative paths and tool permissions resolve
  there. Claude can still read/edit elsewhere via absolute paths
  (`I:\Claude\NDS Indicator\...`) since permissions are skipped.
- A running job **cannot be interrupted** safely: killing `claude --resume`
  mid-flight risks corrupting the session. `/stop` clears the queue instead.

---

## 8. Proxy & censorship handling

This section is the reason the bridge works where Telegram is banned.

### Resolution order (no hard-coded infrastructure)

1. `TELEGRAM_PROXY_URL` in `.env` — explicit override
   (`socks5://user:pass@host:port` or `http://host:port`)
2. `HTTPS_PROXY` / `https_proxy` / `ALL_PROXY` / `HTTP_PROXY` environment variables
3. **Windows system proxy** — read live from the registry
   (`HKCU\…\Internet Settings`, `ProxyEnable` + `ProxyServer`), which is what
   v2rayN-style VPN clients toggle. Local-only proxies (`127.0.0.1` entries
   that are part of your model relay setup) are ignored for Telegram.
4. Direct connection

### Self-healing

- Every network error triggers a re-probe on the next request.
- Even without failures, settings are re-checked **every 60 s**, so the bridge
  notices when you turn the VPN on or off.
- Retries use escalating backoff (5 s → 10 s → 15 s … max 30 s, 6 attempts per
  API call), and HTTP 429 rate limits are honored via `retry_after`.

### If your VPN does not set the Windows system proxy

Some VPNs only route traffic (TUN mode) without setting a system proxy —
that's fine, direct traffic through the tunnel just works. But if your VPN
exposes a local SOCKS/HTTP port *and* doesn't register it as system proxy,
pin it once in `.env`:

```ini
TELEGRAM_PROXY_URL=socks5://127.0.0.1:10808
# or
TELEGRAM_PROXY_URL=http://127.0.0.1:10809
```

Verify what works with curl first:

```cmd
curl.exe -s -m 8 https://api.telegram.org/ -o NUL -w "%{http_code}"
curl.exe -s -m 8 -x http://127.0.0.1:10809 https://api.telegram.org/ -o NUL -w "%{http_code}"
```

`200` on any line = that route works.

---

## 9. Model provider (agentrouter / omniroute)

The bridge **never touches provider config**. It spawns `claude` with your
full environment, so Claude Code reads your own
`C:\Users\ali\.claude\settings.json`:

- `ANTHROPIC_BASE_URL = http://localhost:20128` → your local omniroute relay
- model mappings → `agentrouter/deepseek-v4-flash` etc.

Consequences:

- No Anthropic API key is needed or used.
- If the relay on port 20128 is down, jobs fail with a provider error —
  start your router first.
- To change models, change your own settings as usual; the bridge follows.

---

## 10. Security model

| Layer | Mechanism |
|---|---|
| Who can talk | `ALLOWED_TELEGRAM_IDS` allowlist (per-user, not per-chat) |
| If allowlist is empty | **first person to message claims the bot** — then set the list! |
| What a job can do | full machine access (`--dangerously-skip-permissions`) in the bridge folder |
| Token storage | `.env`, excluded from git by `.gitignore` |
| Transport | Telegram over HTTPS, through your chosen proxy |

Treat every message you send to the bot as a shell command on this machine:

- Keep the allowlist to yourself.
- Don't paste secrets into tasks you wouldn't paste into a terminal.
- The 30-minute timeout caps runaway jobs.
- To revoke access, change `ALLOWED_TELEGRAM_IDS` and restart the bridge.

---

## 11. Configuration reference (.env)

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | from @BotFather; falls back to env `TELEGRAM_CLAUDE_BOT_TOKEN` |
| `ALLOWED_TELEGRAM_IDS` | recommended | *(empty)* | comma-separated user IDs; empty = first user claims |
| `TELEGRAM_PROXY_URL` | no | auto | explicit proxy for Telegram traffic |

Other tunables live as constants at the top of `bridge.js`:
`POLL_TIMEOUT_S` (50), `CLAUDE_TIMEOUT_MS` (30 min), `MAX_QUEUE_PER_CHAT` (3),
reply chunk size (3,800), re-probe interval (60 s).

---

## 12. Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `cannot reach Telegram yet` repeats | VPN off/broken → start it; the bridge self-recovers. Or pin `TELEGRAM_PROXY_URL`. |
| `Telegram getMe failed: 401` | wrong token in `.env` → re-copy from @BotFather |
| `Telegram getMe failed: 404` | token malformed → re-copy, keep the `:` and digits |
| Bot silent, no logs of messages | someone else claimed the bot (open-access run) → set allowlist and restart |
| `❌ Could not launch claude CLI` | `claude` not on PATH → it's at `C:\Users\ali\.local\bin\claude.exe` |
| Job fails instantly with provider error | omniroute relay on 20128 down → start it |
| Report says `(exit 124)` / timeout | job hit the 30-min cap → split the task smaller |
| Reply shows raw `*text*` | Markdown fallback kicked in — cosmetic only |
| Multiple `(_via …_)` prefixes differ | proxy changed mid-session; the tag shows the route used for the first chunk |
| 429 / flood warnings | you're sending too fast; the bridge honors `retry_after` automatically |

Diagnostics cheat sheet:

```cmd
:: 1. Claude headless works?
claude -p "say ok"

:: 2. Relay up?
curl -s -m 5 http://localhost:20128/ -o NUL -w "%{http_code}"

:: 3. Telegram reachable (some line must print 200)?
curl.exe -s -m 8 https://api.telegram.org/ -o NUL -w "%{http_code}"
curl.exe -s -m 8 -x http://127.0.0.1:10809 https://api.telegram.org/ -o NUL -w "%{http_code}"

:: 4. Bridge session state
type state\sessions.json
```

---

## 13. Extending the bridge

Natural next steps, all localized to `bridge.js`:

- **Per-session working directories** — a `/cwd <path>` command storing a
  `cwd` next to each session name, passed to `spawn`.
- **Progress streaming** — run jobs with `--output-format stream-json` and
  post interim "working on X…" edits every N seconds.
- **File delivery** — upload files Claude produces via `sendDocument`.
- **Voice notes** — download OGG voice messages and transcribe before queueing.
- **Windows auto-start** — Task Scheduler job running
  `node bridge.js` at logon, hidden, logging to `bridge.log`.

See also: [README.md](README.md) for the quick-start version of all this.
