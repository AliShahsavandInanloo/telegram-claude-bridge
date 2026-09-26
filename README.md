# Telegram ↔ Claude Code bridge

Chat with a local **Claude Code** harness from any Telegram bot you own. Built for
censored networks: where Telegram is banned, bot traffic can flow through whatever
VPN/proxy you run. **Nothing is hard-coded** — the bridge auto-detects the route:

1. `TELEGRAM_PROXY_URL` in `.env` (optional explicit override)
2. `HTTPS_PROXY` / `ALL_PROXY` / `HTTP_PROXY` environment variables
3. **Windows system proxy** (read live from the registry — what v2rayN-style clients toggle)
4. Direct connection

Bot API calls go through `https.request` (not `fetch`), so HTTP(S) and SOCKS proxy
agents actually apply. Local proxies (`127.0.0.1`, `localhost`) are fully supported.
The route is re-checked whenever a request fails (and every 60 s), so you can
start/stop your VPN whenever you like and the bridge recovers on its own.

Your model provider setup is untouched: the bridge just spawns the `claude` CLI,
which reads your own `~/.claude/settings.json` (any `ANTHROPIC_BASE_URL` relay,
custom model mappings, etc. all keep working).

## Security model (read this first)

Authorization is **fail closed**: the bridge refuses to start unless
`ALLOWED_TELEGRAM_IDS` lists your numeric Telegram user ID(s). Unknown users are
ignored and can never enqueue work, create sessions, or see status.

Every job runs `claude -p` **with `--dangerously-skip-permissions`** in the
configured working directory — that means anyone who can talk to the bot can run
arbitrary commands on this machine. The allowlist is the security boundary:
keep it to you and people you trust, and never ship a `.env` with it empty.

## One-time setup

```cmd
git clone https://github.com/AliShahsavandInanloo/telegram-claude-bridge.git
cd telegram-claude-bridge
npm install
copy .env.example .env
```

(Linux/macOS: `cp .env.example .env`)

Then edit `.env` — both variables are required:

- `TELEGRAM_BOT_TOKEN` — from [@BotFather](https://t.me/BotFather) for **your** bot
- `ALLOWED_TELEGRAM_IDS` — your numeric Telegram user ID(s), comma-separated (get
  them from @userinfobot)

Optional: `TELEGRAM_PROXY_URL`, `CLAUDE_BIN`, `BRIDGE_CWD`, `CLAUDE_TIMEOUT_MS`,
`MAX_QUEUE_PER_CHAT`, `MAX_STDOUT_BYTES`, `MAX_STDERR_BYTES`, `BRIDGE_DEBUG`.

## Run

Double-click `start-bridge.cmd`, or:

```cmd
node bridge.js
```

Startup registers the commands with Telegram (`setMyCommands`), so typing `/` in
the chat shows an autocomplete menu. The log shows the bot name, chosen proxy
route, and how many users are authorized.

## Telegram commands

| Command | Effect |
|---|---|
| `/start`, `/help` | show the command summary |
| `/new <name>` | create a fresh one-shot session and switch to it |
| `/new <name> <project-path>` | create a **managed Claude session** bound to a project and attach to it |
| `/sessions` | list sessions; `▶️` marks the active one, `(new)` = not yet used by Claude |
| `/use <name>` | switch the active one-shot session |
| `/attach <name\|number>` | attach this chat to an **online Channel session** (offline targets are refused, never silently substituted) |
| `/switch <name\|number>` | switch this chat to another connected Channel session |
| `/detach` | detach from the managed session |
| `/current` | show the currently attached managed session |
| `/session-status` | process state, current task, runtime, latest output |
| `/files` | list files in the attached project |
| `/download <file>` | send a project file back here |
| `/discover` | list running Claude processes (read-only inventory — never attachable) |
| `/stop` | cancel Bridge-side work for this chat (queued jobs, one-shot job). **Channel sessions keep running** — use `/terminate-session confirm` for that |
| `/terminate-session confirm` | explicitly stop a stream-json session process |
| `/queue` | what's running and how many jobs are queued (this chat / global) |
| `/status` | Claude executable, active session, job state, queue, proxy (credentials redacted), uptime |
| any other text | a task for the attached managed session — or, if none, the one-shot active session |

### Managed vs one-shot sessions

- **Channel sessions (preferred, interactive)**: start Claude Code in a project
  with the custom channel enabled — messages from Telegram appear natively in
  the live session (`← telegram-bridge · …`) and Claude replies through the
  `reply` tool. See DOCUMENTATION.md §Channel for the exact setup.
- **stream-json sessions (legacy/automation)**: `/new <name> <project-path>`
  registers a session the bridge fully owns; each message is a queued task
  via the stream-json stdin protocol. Kept for background/automation use.
- **One-shot** (classic): each message spawns `claude -p <text>` against a
  named conversation; the process ends when the answer is done.
- **Discovered processes**: `/discover` lists Claude processes already running
  on the machine. Inventory only — not attachable (a session is attachable
  only when its Channel connection is online).

### Claude → Telegram via the Bridge

Channel sessions never talk to Telegram directly. Claude calls the Bridge's
`reply`/`send_file` tools over the authenticated localhost IPC; the Bridge
validates the session→chat mapping, applies the allowlist/chunking/size caps,
and sends with the single Telegram client. The channel secret lives in
`state/channel-secret` (0600) and is never the bot token or any API credential.

The hub binds a **stable loopback port** (`CLAUDE_CHANNEL_PORT`, default
8765) so live sessions **reconnect automatically after a bridge restart** —
no need to restart Claude Code; the full registration handshake (through
`register_ack`) runs again on every reconnect, and the session re-binds to
the same registry record (keyed by its persisted clientId). Registration is
atomic and serialized: registry transactions are GLOBALLY isolated (one
whole-registry snapshot/mutate/persist/rollback cycle at a time, so a
failed registration for one session can never corrupt another's committed
record), same-client connection ordering stays per session, a session
becomes routable only after its registry record is durably persisted, a
failed persist or a superseded candidate rolls back cleanly and retries
with backoff (rejected attempts leave no staged metadata behind), a
replacement connection never retires the old one until it is safely
committed, and stale/late socket events cannot disturb the authoritative
session. Note: the channel's clientId is generated at Channel-process
start — it survives a Bridge restart while the Claude Code session stays
alive, but a Channel process restart may generate a new clientId (the
offline name+project record is then reused, never duplicated). If the port
is occupied the bridge refuses
to start (never a silent random port). Liveness is enforced by a heartbeat
(`CLAUDE_CHANNEL_HEARTBEAT_MS` / `…_TIMEOUT_MS`); zombie connections are
dropped and cannot dispatch tools. Clients reconnect with bounded
exponential backoff (2 s → 15 s max, reset on reconnect). Replies are
delivery-scoped: Claude answers with the `delivery_id` from the channel
tag (the legacy `chat_id` tool argument is deprecated and only works while
the session is the chat's current attachment), so a reply still lands
in the right chat even after you `/switch` sessions — and delivery records
are persisted, so a task that outlives a Bridge restart can still reply.
File tools accept
project-relative nested paths; anything resolving outside the project root
(symlink/junction/`..`/UNC escapes) is rejected — including a symlinked
`incoming/` upload directory, which cannot redirect writes outside the
project.

Commands also work group-style: `/status@YourBot` is accepted, and commands
addressed to a different bot are ignored.

## Sessions

A session is one persistent Claude conversation. `/new` allocates it locally with
`--session-id`; the first successful run makes it resumable, and every later job
resumes with `--resume`. Queued jobs keep the session identity they were enqueued
with, even if you create or switch sessions meanwhile. State lives in
`state/sessions.json` (schema v2, written atomically); old formats are
migrated automatically.

## Message delivery

Updates are processed **at-most-once**: the next Telegram offset is durably
persisted (temp file + fsync + rename) **before** an update is handled, so a
command can be skipped after a crash but never executed twice.

- **If offset persistence fails, the command is not executed.** The bridge
  logs the failure, keeps its offset unchanged, and retries — the same update
  is delivered again on the next poll. It never acknowledges success without
  a durable save.
- On the **first** start, messages sent while the bridge was offline are
  skipped by default (`PROCESS_INITIAL_BACKLOG=false`) instead of executing
  stale commands; set it to `true` to consume the backlog. **First
  initialization records state even when the backlog is empty** — a restart
  is never mistaken for another first start (which would purge new messages).
- Corrupted or unreadable offset state is **not** treated as a clean first
  start: the bridge backs up the corrupt file and refuses to start rather
  than risk discarding pending commands.

Later restarts resume from the saved offset.

## Tests

```cmd
npm test
```

141 sandboxed tests (30 + 59 + 16 + 17 + 19) cover auth, prompt passing, session lifecycle,
queue fairness and close semantics, proxy parsing/redaction, atomic
persistence, first-start backlog skipping (empty and non-empty), at-most-once
offset ordering incl. persistence-failure blocking, offset state categories
(missing/valid/corrupt/unreadable), the Windows launch specification
(native exe, npm `.cmd`/`.bat` shims → node + cli.js, JS entrypoints, and
hard failures for anything unparseable), spawn-argv verification
(`shell:false`, prefix order, `--resume`), session rollback on failed saves,
structure-based legacy migration, temp-file cleanup, and `/status` privacy.
No network or `claude` process is touched.

## Troubleshooting

- `refusing to start: ALLOWED_TELEGRAM_IDS …` → set your numeric ID(s) in `.env`.
- `refusing to start: … .cmd launcher …` → the npm `claude.cmd` shim could not be
  safely modeled; point `CLAUDE_BIN` at the native `claude.exe` or the CLI's
  `cli.js` (see DOCUMENTATION.md §CLAUDE_BIN).
- `refusing to start: CLAUDE_BIN "…" was not found on PATH` → the bare name
  matches nothing executable; install Claude Code or set `CLAUDE_BIN`.
- `Unable to read Telegram offset state … refusing to treat this as first startup`
  → `state/offset.txt` is corrupt or unreadable; a `.corrupt-*.bak` backup was
  written next to it. Inspect/restore it, then start the bridge again.
- `cannot reach Telegram yet` repeating → your VPN is off; turn it on, the bridge
  re-probes within 10 s. Or pin `TELEGRAM_PROXY_URL`.
- 401 from Telegram → wrong `TELEGRAM_BOT_TOKEN`.
- `Could not run Claude` → check `claude -p "hi"` works in a terminal; set
  `CLAUDE_BIN` if `claude` isn't on PATH.
- Large replies are split into chunks; stdout/stderr capture is bounded
  (`MAX_STDOUT_BYTES`/`MAX_STDERR_BYTES`) with truncation markers.

---

📖 **Full technical documentation:** [DOCUMENTATION.md](DOCUMENTATION.md) — architecture,
session lifecycle, proxy-resolution internals, security model, .env reference, and troubleshooting.
