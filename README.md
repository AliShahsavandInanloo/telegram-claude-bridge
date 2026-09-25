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
| `/new <name>` | create a fresh named session and switch to it |
| `/sessions` | list sessions; `▶️` marks the active one, `(new)` = not yet used by Claude |
| `/use <name>` | switch the active session |
| `/stop` | cancel the running job (if it belongs to this chat) and clear this chat's queued jobs |
| `/queue` | what's running and how many jobs are queued (this chat / global) |
| `/status` | Claude executable, active session, job state, queue, proxy (credentials redacted), uptime |
| any other text | becomes the prompt for the active session; the report is sent back here |

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

78 sandboxed tests (30 + 48) cover auth, prompt passing, session lifecycle,
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
