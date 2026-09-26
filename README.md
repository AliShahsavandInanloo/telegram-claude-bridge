# telegram-claude-bridge

Control a local **Claude Code** installation from a Telegram bot. Send a message
in the chat, Claude works on it in one of your projects and replies — with files,
across multiple sessions, through whatever proxy your network needs. **Nothing is
hard-coded**: the bridge auto-detects the network route (`TELEGRAM_PROXY_URL` →
`HTTPS_PROXY`/`ALL_PROXY` env vars → Windows system proxy → direct), so you can
start and stop your VPN whenever you like.

## What it can do

- Control Claude Code from Telegram (with allowlist-only access)
- Talk to **live** Claude Code sessions through a custom Channel
- Run headless **one-shot** Claude jobs
- Run managed **stream** sessions (long-running background processes)
- Switch a chat between sessions, list files, download project files
- Install the Channel **once per user** — no per-project `.mcp.json`
- Use one central bot for all sessions (single Telegram poller)

## How it works

```
Telegram ↔ Bridge ↔ Claude session
```

- **CHANNEL** → a live Claude Code session (native two-way integration)
- **ONE-SHOT** → a headless Claude invocation (`claude -p`), no terminal needed
- **STREAM** → a managed background Claude process the bridge owns

Details and internals: [DOCUMENTATION.md](DOCUMENTATION.md).

## Security (read this first)

- Access is **allowlist-only**: the bridge refuses to start without
  `ALLOWED_TELEGRAM_IDS`, and unknown users are ignored.
- Jobs run Claude **with `--dangerously-skip-permissions`** — anyone who can
  talk to the bot can run arbitrary commands on your computer. Keep the
  allowlist to people you trust.
- Never commit or share `.env` or your bot token.
- Only **one** process may poll Telegram for a given bot token.
- The Channel IPC is local-only (127.0.0.1) and authenticated with a dedicated
  secret — never the bot token.

## Quick start

### 1. Prerequisites

- Windows (primary target), Git, Node.js 20+, npm
- Claude Code installed and working
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Your numeric Telegram user ID (from @userinfobot)

### 2. Clone

```cmd
git clone https://github.com/AliShahsavandInanloo/telegram-claude-bridge.git
cd telegram-claude-bridge
```

### 3. Install dependencies

```cmd
npm ci
```

### 4. Create the configuration

```cmd
copy .env.example .env
```

Then edit `.env` and fill in the two required values:

```ini
TELEGRAM_BOT_TOKEN=<token from BotFather>
ALLOWED_TELEGRAM_IDS=<your numeric Telegram user ID(s), comma-separated>
```

Never paste secrets into public chats, and never commit `.env`.

### 5. Install globally

```cmd
npm run install-global
```

This registers, for your Windows user:

- the `telegram-bridge` MCP server (user scope, visible in every project)
- the `telegram-claude-bridge` command (starts the central Bridge)
- the `claude-telegram` command (Claude Code with the Channel enabled)

The wrapper directory is verified against PATH; if the default is not on PATH
the installer uses the npm global bin directory or tells you exactly what to do.

### 6. Start the Bridge

```cmd
telegram-claude-bridge
```

The log shows the bot name, the chosen proxy route, and how many users are
authorized. Leave it running — it is the only Telegram poller.

### 7. Start Claude in any project

```cmd
cd C:\Projects\my-project
claude-telegram
```

Accept the development-channel consent prompt if Claude Code shows one.
Plain `claude` is never modified.

### 8. Connect from Telegram

In your bot's chat:

```text
/sessions
/attach <session>       (or /switch <session>)
```

Then just send a normal message — it appears inside your live Claude Code
session, and Claude replies back into Telegram.

## Install with an AI coding agent (optional)

An AI agent can perform the whole install for you — using the same supported
installer, not a second one. Open your coding agent, copy the prompt from
[AGENT_INSTALL.md](./AGENT_INSTALL.md), and follow its questions. An agent is
never required; the Quick start above always works.

## Installed PC commands

| Command | Purpose |
|---|---|
| `telegram-claude-bridge` | starts the central Bridge |
| `claude-telegram` | starts Claude Code in the current directory with the Channel enabled |
| `npm run uninstall-global` | removes the global integration owned by this installation |

Maintenance notes:

```cmd
npm run install-global                # idempotent — replaces its own entry only
npm run uninstall-global              # checks the known default wrapper locations
npm run uninstall-global -- --force   # also remove a foreign "telegram-bridge" MCP registration
```

Uninstall never touches `.env`, `state/`, `node_modules/`, your other MCP
servers, or hand-written files; `--force` applies to the MCP registration only.

## Configuration (essentials)

| Variable | Required | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | token from BotFather |
| `ALLOWED_TELEGRAM_IDS` | yes | numeric Telegram user IDs allowed to use the bridge |
| `CLAUDE_CHANNEL_PORT` | no | Channel hub port (default 8765) |
| `TELEGRAM_PROXY_URL` | no | explicit proxy for Telegram traffic |
| `CLAUDE_BIN` | no | path to Claude Code if not resolvable from PATH |

Full reference: [DOCUMENTATION.md](DOCUMENTATION.md#configuration).

## Telegram commands

| Command | Purpose |
|---|---|
| `/help` | command summary |
| `/sessions` | list sessions; the active one is marked |
| `/new <name>` | create a one-shot session and switch to it |
| `/new <name> <project-path>` | create a managed session bound to a project |
| `/use <name>` | switch the active one-shot session |
| `/attach <name\|number>` | attach this chat to an online Channel session |
| `/switch <name\|number>` | switch to another connected session |
| `/detach` | detach from the current session |
| `/current` | show the currently attached session |
| `/session-status` | process state, current task, runtime, latest output |
| `/files` | list files in the attached project |
| `/download <file>` | send a project file back here |
| `/discover` | list running Claude processes (read-only inventory) |
| `/queue` | what's running and how many jobs are queued |
| `/stop` | cancel this chat's Bridge-side work (Channel sessions keep running) |
| `/terminate-session confirm` | explicitly stop a managed session process |
| `/status` | Claude executable, active session, queue, proxy (redacted), uptime |

Any other text is a task for the attached session — or the active one-shot
session if none is attached.

## Session types compared

| | CHANNEL | STREAM | ONE-SHOT |
|---|---|---|---|
| Who starts Claude | You | Bridge | Bridge per message |
| Process lifetime | While your live Claude Code session is open | Long-running managed process | New process for each message |
| Conversation context persists | Yes | Yes | Yes (named conversation, resumed) |
| Interactive Claude Code terminal | Yes | No | No |
| Telegram messages visible in the Claude UI | Yes | No | No |
| Good for live coding | Best fit | Not the main use | Not the main use |
| Good for background automation | Possible | Best fit | Good for occasional work |
| Idle resource usage | Claude session remains open | Worker remains running | Very low |
| Needs a new session every message | No | No | No |
| Best mental model | Remote control for live Claude Code | Persistent background worker | Lightweight headless conversation |

In short:

- **CHANNEL** = remote control for a live Claude Code workspace.
- **STREAM** = persistent background Claude worker managed by the Bridge.
- **ONE-SHOT** = headless conversation that starts Claude only when a message
  needs processing — the conversation context is kept and resumed, only the
  process is short-lived.

## Troubleshooting

- **`EADDRINUSE 127.0.0.1:<port>`** — the Channel port is taken. Find the
  owning process (`netstat -ano | findstr :<port>`), stop it, or set another
  `CLAUDE_CHANNEL_PORT` in `.env`.
- **Telegram errors about getUpdates conflict** — another process is polling
  the same bot token. Stop the other poller; only one is allowed.
- **My session never appears in `/sessions`** — start Claude with
  `claude-telegram` (not plain `claude`) so the Channel connects to the Bridge.
- **`cannot reach Telegram yet`** — your VPN/proxy is down or Telegram is
  blocked; the bridge re-probes automatically, or pin `TELEGRAM_PROXY_URL`.
- **401 from Telegram** — wrong `TELEGRAM_BOT_TOKEN`.
- **`refusing to start: ALLOWED_TELEGRAM_IDS …`** — set your numeric ID(s).
- **Claude launch/shim errors** — point `CLAUDE_BIN` at the native
  `claude.exe` or the CLI's `cli.js`.
- **Offset state errors on startup** — `state/offset.txt` was corrupt; a
  `.corrupt-*.bak` backup was written. Inspect it, then start again.

---

Need details? See [DOCUMENTATION.md](DOCUMENTATION.md) — architecture, session
lifecycle, full configuration reference, and the development/test guide.
