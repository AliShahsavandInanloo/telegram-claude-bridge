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
4. **Execute** — `spawn(launch.command, [...launch.prefixArgs, '-p', <your text>,
   '--output-format', 'text', '--dangerously-skip-permissions',
   ('--resume'|'--session-id'), <uuid>], { shell: false })` — the prompt is
   passed as a spawn argument, never through a shell. See §10b for how
   `launch.command`/`prefixArgs` are derived from `CLAUDE_BIN`.
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
    ├── sessions.json    # { version: 2, chats: { chatId → { activeSession, sessions: { name → {id, initialized} } } } }
    └── offset.txt       # Telegram update offset (at-most-once delivery; see §Delivery)
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

## 10b. Message delivery semantics

Telegram updates are processed **at-most-once**. The bridge durably persists
the next update offset **before** executing the update: this prevents a
command from being executed twice after a crash, but a crash between
persisting and handling can cause that update to be skipped. For a bridge
that runs Claude with broad machine permissions, never re-executing an old
command is the safer trade.

**If offset persistence fails, the command is not executed.** The update is
not handled, the in-memory offset does not advance, and the poll loop retries
— so the same update is delivered again once persistence recovers. Success
is never reported without a durable save (temp file + fsync + rename).

**Offset state categories** — the offset file can be in one of four states,
and they are deliberately not interchangeable:

| State | Meaning | Behavior |
|---|---|---|
| `missing` | never persisted (true first start) | first-start backlog policy runs |
| `valid` | a saved offset exists | resume normally; never purge |
| `corrupt` | file exists, content invalid | backup `.corrupt-*.bak` + **refuse to start** (never treated as first start — that would purge pending commands) |
| `unreadable` | file exists, cannot be read | **refuse to start** with an actionable error |

**First-start backlog policy** (`PROCESS_INITIAL_BACKLOG`, default `false`):
on the very first start the bridge skips all messages sent while it was
offline, instead of executing potentially hours-old commands. With
`PROCESS_INITIAL_BACKLOG=true` the backlog is consumed normally.
**First successful initialization records state even when the backlog is
empty** (offset `0` is persisted as the marker), so a restart after an empty
first start is a normal resume — not another purge. On every later restart
the bridge resumes from the saved offset — nothing is purged and nothing is
re-executed.

### Windows Claude resolution (`CLAUDE_BIN`)

The bridge represents Claude execution as a **launch specification**
(`{ command, prefixArgs }`) and always spawns
`spawn(command, [...prefixArgs, ...args], { shell: false })` — the Telegram
prompt is a direct argv element, never shell-interpolated. `shell:true` and
`cmd.exe`/`powershell` are never used. Accepted `CLAUDE_BIN` values:

- **empty or bare name** (`claude`) — resolved via PATH; the resolved file
  must actually exist or startup fails (`… was not found on PATH`).
- **native executable** (`claude.exe` or any directly spawnable file) —
  `{ command: <that file>, prefixArgs: [] }`.
- **Windows `.cmd`/`.bat` launcher** (npm-style shim) — parsed as a *known
  launcher structure only*: `node  <path>\cli.js  %*` becomes
  `{ command: node.exe, prefixArgs: [<cli.js>] }`; a shim invoking a sibling
  `.exe` becomes that exe. Anything unparseable fails startup with
  `Unable to safely resolve Claude from the Windows .cmd launcher…` —
  the bridge never guesses (a wrong guess once produced `node.exe` with the
  entrypoint dropped, i.e. plain node instead of Claude).
- **JavaScript CLI entrypoint** (explicit path to `cli.js`) — launched via
  the current Node runtime: `{ command: node, prefixArgs: [cli.js] }`.

---

## 11. Configuration reference (.env)

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | from @BotFather (fallback: `TELEGRAM_CLAUDE_BOT_TOKEN`) |
| `ALLOWED_TELEGRAM_IDS` | **yes** | — | comma-separated numeric user IDs; missing/empty/malformed = startup error |
| `TELEGRAM_PROXY_URL` | no | auto | explicit proxy for Telegram traffic (loopback hosts allowed) |
| `CLAUDE_BIN` | no | `claude` | Claude launch target: bare PATH name (must resolve), native executable, Windows `.cmd`/`.bat` launcher (parsed as node+cli.js or sibling-exe only), or explicit JS entrypoint (launched via node). Unparseable/missing targets fail startup — never a shell fallback |
| `BRIDGE_CWD` | no | bridge folder | working directory for Claude jobs (must exist **and be a directory**) |
| `BRIDGE_STATE_DIR` | no | `./state` | directory for `sessions.json` / `offset.txt` (created if missing); read from `.env` too |
| `PROCESS_INITIAL_BACKLOG` | no | `false` | `false` (safe default): on the very first start, messages sent while offline are skipped, never executed. `true`: consume them. Restarts always resume from the saved offset. |
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

78 sandboxed tests (30 + 48; no framework, no network, no spawned claude)
verify: fail-closed auth and config validation; prompt text reaching Claude's
args with `shell:false` and correct launch-spec prefix order (a unit seam
inspects command/args/options without spawning); `--session-id` vs `--resume`
semantics; at-most-once offset ordering incl. **failed persistence blocking
execution** and the in-memory offset not advancing; offset state categories
(missing/valid/corrupt/unreadable) with corrupt state refusing first-start
purge; empty-backlog initialization persisting its marker; Windows launch
forms (native exe, npm `.cmd`/`.bat` → node+cli.js, JS entrypoint, malformed
shims, missing bare executables); queue-close lifecycle; sessions named
`active`/`list`/`sessions`/`activeSession`/`version` surviving structure-based
migration (schema v2); `/new`-overwrite rollback restoring the OLD session on
save failure; temp-file cleanup; `.env` loading precedence; `BRIDGE_CWD`
directory validation; backlog logs reporting the update count (not an update
id); and `/status` path privacy.

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

## 13b. Claude Session Manager (managed sessions)

Beyond one-shot jobs, the bridge manages long-lived Claude sessions. There
are two managed transports plus two non-attachable views:

| Type | transport | Attachable | How it runs |
|---|---|---|---|
| **Channel session** | `channel` | yes, when connected | A real Claude Code session with the custom channel enabled; Telegram messages appear natively in the live conversation |
| **stream-json session** | `stream-json` | yes (queued tasks) | A headless Claude process the bridge spawns and owns; legacy/automation transport |
| Discovered process | — | **no** | `/discover` inventory of foreign Claude processes; never touched |
| Legacy one-shot | — | n/a | `claude -p` per message via the classic store |

### Channel sessions (native Claude Code integration)

A **Channel** is Claude Code's mechanism for pushing events into a running
session (research preview): an MCP server that declares
`capabilities.experimental['claude/channel']`, emits
`notifications/claude/channel` (delivered as `<channel source=… chat_id=…>`
and rendered `← source · message`), and exposes ordinary MCP tools for
replies. Verified against the official docs (code.claude.com/docs/en/channels)
and Claude Code 2.1.267.

This repo ships that channel server: `lib/channel/claude-channel.js`. It is
spawned BY Claude Code (stdio MCP subprocess) and connects to the Bridge's
**channel hub** — an authenticated, framed-JSON TCP server bound strictly to
127.0.0.1 (never 0.0.0.0), with heartbeats and auto-reconnect.

**How a Telegram message reaches the live session:**

```text
Telegram → Bridge (sole getUpdates consumer, allowlist enforced)
         → hub.deliver(session, {content, meta:{chat_id,…}})   (localhost IPC, auth'd)
         → channel server: mcp.notification(notifications/claude/channel)
         → appears in the Claude Code session as ← telegram-bridge · <text>
Claude replies with the reply tool → hub validates session↔chat mapping
         → Bridge sends via the existing Telegram client (chunking, errors)
```

**Starting a Channel-enabled session** (research preview requires the dev
flag; custom channels are not yet on Anthropic's allowlist):

Preferred — **global install** (one user-scope MCP entry, no per-project
`.mcp.json`, no manually exported port or secret):

1. One-time: `npm run install-global`
2. `telegram-claude-bridge` (start the Bridge once) — then, in ANY project:
   `claude-telegram`
3. Accept the development-channels prompt on first launch.

See [Global installation](#global-installation) below for what this registers.

Alternative — **per-project `.mcp.json`** (the original explicit setup; still
supported):

1. Register the channel in the project's `.mcp.json`:
   ```json
   { "mcpServers": { "telegram-bridge": {
       "command": "node",
       "args": ["<bridge>\\lib\\channel\\claude-channel.js"] } } }
   ```
2. Export the hub coordinates (shown in the bridge log at startup):
   `CLAUDE_CHANNEL_PORT=<port>` and `CLAUDE_CHANNEL_SECRET=<contents of
   state/channel-secret>`.
3. `claude --dangerously-load-development-channels server:telegram-bridge`
   and accept the development-channels prompt.

The channel authenticates with the hub secret (random 32-byte value in
`state/channel-secret`, mode 0600). It is NOT the bot token, NOT an API key,
and never leaves the machine. The Bridge validates every `reply`/`send_file`
call against the session↔chat attachment mapping — the channel cannot
message a chat its session is not attached to, and cannot bypass the
allowlist or size caps.

**Registration/reconnect identity:** the channel instance identifies itself
with a UUID (`clientId`), never a filesystem path. A reconnect with the same
clientId re-binds to the same registry record (no duplicates); a new clientId
for an offline same-name+project record reuses it; otherwise a new session
registers. Disconnects mark the session offline; attachments persist but are
inactive until reconnect. `/attach` and `/switch` refuse offline Channel
sessions instead of falling back silently.

**Stable endpoint & reconnect:** the hub binds a STABLE configured port
(`CLAUDE_CHANNEL_PORT`, default `8765`, loopback only). If that port is
occupied at startup the bridge **refuses to start** rather than silently
picking a random port — already-running channel clients would otherwise
reconnect to a dead endpoint forever. Channel clients reconnect with bounded
exponential backoff (2 s → 4 s → 8 s → 15 s max, reset after a healthy
authenticated session), so a Bridge restart does NOT require
restarting Claude Code. The production channel server uses the SAME shared
framed client (`lib/channel/ipc.js`) as the hub — one authoritative
implementation for framing, frame caps, ping/pong and reconnect.

**Heartbeat / liveness:** the hub pings authenticated connections every
`CLAUDE_CHANNEL_HEARTBEAT_MS` (default 5000; 1000–60000). Any valid traffic
refreshes liveness; a connection silent for `CLAUDE_CHANNEL_HEARTBEAT_TIMEOUT_MS`
(default 15000; 2000–300000, must exceed the interval) is destroyed and the
session goes offline. Zombie sockets can never dispatch tools.

**Delivery-scoped replies (delayed reply after /switch):** every Telegram
message routed to a Channel session creates a delivery record and passes
`delivery_id` in the `<channel>` meta. The `reply`/`send_file` tools resolve
that id to the ORIGINAL chat, so NDS can finish answering after you've
`/switch`ed to OmniRoute. Rules: only the session that owns the delivery may
use it; unknown/expired (6 h TTL) deliveries are rejected; no channel can
name an arbitrary chat. The legacy `reply(chat_id, …)` form still works only
while the session is the chat's CURRENT attachment and is deprecated.
Deliveries are PERSISTED in `state/deliveries.json` (atomic writes, bounded
to 1000 records, expired records purged on load and insert; only routing
metadata is stored — never message text), so a `delivery_id` still resolves
after a Bridge restart — a finished long-running task can still reply.

**Registration & lifecycle:** registration happens on EVERY authenticated
reconnect (TCP connect → hello → hello_ok → register → register_ack), not
just the first connection. Registration is a single TRANSACTION in the hub,
SERIALIZED per clientId through a per-identity mutex (different Channel
sessions register concurrently): pure target lookup → pre-mutation registry
snapshot → staged mutation → persist → COMMIT VALIDATION (candidate alive,
generation still current) → commit (connection ownership + online map) →
`register_ack`. A session becomes ROUTABLE (appears in `onlineIds`/
`isOnline`, accepts deliveries and tool calls) only after the save commits —
never before. Each registration attempt carries a monotonically increasing
generation; only the current generation may commit, so a candidate that
closed or was superseded while its save was pending can never become
authoritative — it gets `register_nak` ("superseded" / "connection lost"),
the registry is repaired, and any previously healthy connection stays
authoritative. A duplicate/replacement registration retires the old healthy
connection only AFTER the replacement persists and validates. The client
treats `register_nak` as a retry signal: it drops the connection and its
bounded exponential backoff schedules a fresh attempt (backoff resets on a
successful registration). Late close events from retired connections are
ignored — only the authoritative connection's close takes the session
offline.

**Registry transaction isolation:** snapshot/restore operate on the ENTIRE
registry, so every whole-registry transactional flow — the hub's
registration transaction AND the manager's persists (create, attach,
detach, status, session id) — runs inside the SAME GLOBAL registry
transaction mutex (`reg.withTransaction`). One rule: all persisted registry
mutations, Channel and manager alike, execute inside the same global
registry transaction boundary. The manager acquires the lock BEFORE it
snapshots, mutates or saves (never lock-only-around-save), so its operations
cannot be erased by a concurrent whole-registry rollback. High-frequency,
low-value fields (session `status`, `claudeSessionId`, `lastActivity`) are
queued OUTSIDE the registry and applied — with a single save — inside ONE
registry transaction per burst; the live registry is never mutated before
the lock is held. The manager never infers transaction context from a shared
counter/flag — an unrelated async event (child exit, kill, task completion,
`system/init`) can never join whichever manager transaction happens to be in
flight; it is always staged and applied by a later flush. If a queued flush
fails to save, the registry snapshot is restored and the latest intent is
re-queued for the NEXT flush (a later update or shutdown) — there is no
automatic retry loop, so a persistently broken disk leaves the latest status /
session-id intent pending in memory rather than corrupting the registry. Only
one full-registry
snapshot → mutate → persist → commit/restore cycle may run at a time, so a
failed registration for client X can never roll back a successfully
committed transaction for client Y, and a superseded candidate restores its
OWN pre-mutation snapshot before releasing the lock — staged mutations from
rejected attempts never stay visible to later candidates. Same-client
connection ordering remains per-identity (the per-clientId mutex is kept
for generation ordering and authoritative-connection replacement); the
global transaction lock is held only around the persistent registry
transaction, never during heartbeat waits, reconnect backoff, or Telegram
network calls. The lock map is cleaned up after the last queued
registration for an identity finishes.

**clientId persistence limit:** clientId is generated by
`lib/channel/claude-channel.js` at PROCESS START. It survives a Bridge
restart while the Claude Code/Channel process stays alive (the reconnecting
process re-presents the same clientId and re-binds to its registry record),
but a Channel process restart may generate a NEW clientId — in that case
the existing reconciliation fallback applies (an offline same-name+project
record is reused; no duplicate is created). Do not assume stronger identity
persistence than that.

Channel identity is the persisted `clientId` on the registry
record (primary reconnect key; name/project are metadata), so multiple
Claude sessions on the same project keep distinct identities across Bridge
restarts; legacy records without a clientId are backfilled on first
registration. Channel state machine: `disconnected → connecting →
authenticated → registering → registered`; disconnect from any state
returns to `disconnected`; only `registered` is usable (`link.isUsable()` /
`.registered`); `link.onClose(fn)` fires once per connection loss. A hub
shutdown marks all sessions offline first, so reconnects re-bind to the
SAME registry record (no duplicates). `npm run check` syntax-checks every
project JS file via `scripts/check.js` (glob-discovered — bridge.js,
lib/**, test/**, scripts/**); `npm test` runs all ten suites (see
package.json).

**Safe file paths:** `/download`, the channel `send_file` tool, and uploads
share one resolver (`lib/claude/files.js`): `realpath(requested)` must be
inside `realpath(projectRoot)` — symlink/junction escapes, `..` traversal,
absolute and UNC paths outside the root are all rejected; safe nested paths
(e.g. `reports/result.md`) ARE supported; directories are not sendable.
Telegram uploads use the same model for the WRITE destination: the first
upload to a fresh project creates `<project>/incoming` (the created
directory is re-verified to resolve inside the project), and a symlinked/
junctioned `incoming` pointing outside the project is refused — never
overwritten or written through.
`realpath(projectRoot)` — so a symlinked/junctioned `incoming` pointing
outside the project is refused instead of silently writing outside.

**Channel wire protocol (framed JSON, one object per line):**

| Frame | Direction | Purpose |
|---|---|---|
| `hello` | client → hub | auth: `{secret, clientId, protocol}` |
| `hello_ok` | hub → client | authenticated |
| `ping` / `pong` | both | heartbeat liveness |
| `register` / `register_ack` / `register_nak` | client ↔ hub | session registration |
| `deliver` | hub → client | Telegram message → channel event |
| `channel_message` | client → hub | informational event from the session |
| `tool_call` / `tool_result` | client ↔ hub | reply / send_file dispatch |

Malformed, oversized (> 512 KiB) or non-loopback frames/connections are
dropped; everything is authenticated with the per-install secret from
`state/channel-secret` (never the bot token or any API credential).

### Global installation

Installs the Channel **once** for the current Windows user, so no project ever
needs its own `.mcp.json`, and the port and channel secret are never typed
again.

```cmd
cd <bridge>
npm run install-global
```

That single command does three things:

1. **Registers the MCP server at USER scope.** `claude mcp add -s user
   telegram-bridge -- node <bridge>\scripts\launch-channel.js` — visible in
   every project (`claude mcp get telegram-bridge` reports *"User config
   (available in all your projects)"*). The command line contains **paths
   only**: no secret, no token.
2. **Installs two wrapper commands** into a directory already on the user PATH
   (`~/.local/bin`; override with `--bin-dir`):

   | Command | Effect |
   |---|---|
   | `telegram-claude-bridge` | starts the central Bridge (the only Telegram poller) |
   | `claude-telegram` | launches Claude Code **in the current directory** with the Channel enabled |

3. **Verifies** the registration and prints the next steps.

`claude-telegram` is exactly:

```cmd
claude --dangerously-load-development-channels server:telegram-bridge
```

with the current working directory left untouched (so Claude operates on the
project you ran it in), while the plain `claude` command is not modified at all.

**Where the port and secret come from.** `scripts/launch-channel.js` is the
registered MCP entry point. At runtime it:

- loads the Bridge `.env` (`applyEnvFile`) and takes `CLAUDE_CHANNEL_PORT` from
  it — the same single source of truth the Bridge itself uses (this install
  resolves `8766`, not a hardcoded default);
- reads the hub secret **from disk**: `CLAUDE_CHANNEL_SECRET_FILE` if set, else
  `state/channel-secret`;
- exports both into its own process and runs the Channel in-process (no
  subprocess, no shell, no secret in any argv);
- prints nothing secret — `node scripts/launch-channel.js --selftest` reports
  `{port, secretSource, secretLength}` only.

So the secret stays in the same 0600 file the Bridge already generates: it is
never written to `~/.claude.json`, never committed, and never lands in a command
line. An exported `CLAUDE_CHANNEL_SECRET` still takes precedence, so the manual
per-project mode above keeps working unchanged.

**Maintenance:**

```cmd
npm run install-global      # idempotent: replaces our own entry, never duplicates
npm run uninstall-global    # removes only what this installer created
```

`install-global` refuses to overwrite a user-scope server named
`telegram-bridge` that it did not create, and both commands leave unrelated MCP
servers and project configuration alone. Uninstall deletes a wrapper only when
it carries this installer's marker, and never touches `.env`, `state/`, or
`node_modules/`.

**Verifying from an unrelated directory** (no `.mcp.json` present):

```cmd
claude mcp get telegram-bridge     # Scope: User config … Status: ✔ Connected
node <bridge>\scripts\launch-channel.js --selftest
```

### Legacy stream-json managed sessions

`/new <name> <project-path>` (without a running channel) spawns a headless
Claude via `--output-format stream-json --input-format stream-json`: tasks
are queued FIFO, each queued task resolves with its own final result, output
streams to Telegram rate-limited, `MANAGED_TASK_TIMEOUT_MS` (default 4 h)
applies. Registry entries record `transport` so `/sessions` can show which
sessions are Channel vs stream-json. `/stop` never kills a Channel session
(only Bridge-side work); `/terminate-session confirm` explicitly stops a
stream-json process.

### Files

Uploads land in `<project>/incoming/` and Claude is notified (channel event
for Channel sessions, task prompt for stream-json). `/files` lists project
files; `/download <name>` and the channel `send_file` tool share the same
path-safety logic: basename-only (traversal/symlink-safe), 20 MB cap.

### Discovery

`/discover` is a read-only inventory of running Claude processes (PID +
image name via tasklist/ps, spawned shell:false). A discovered process is
NOT attachable — only sessions with an authenticated Channel connection are.

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
