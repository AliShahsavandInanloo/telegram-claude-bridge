# ShiClaude — Telegram ↔ Claude Code bridge

Chat with your local Claude Code harness from Telegram. Built for censored networks:
Telegram is banned locally, so all bot traffic can flow through whatever VPN/proxy
you run on Windows. **No proxies are hard-coded** — the bridge auto-detects:

1. `TELEGRAM_PROXY_URL` in `.env` (optional explicit override)
2. `HTTPS_PROXY` / `ALL_PROXY` / `HTTP_PROXY` environment variables
3. **Windows system proxy** (read live from the registry — what v2rayN-style clients toggle)
4. Direct connection

It re-checks whenever a request fails (and every 60 s), so you can start/stop your
VPN whenever you like and the bridge recovers on its own.

Your agentrouter/omniroute model routing is untouched: the bridge just spawns the
`claude` CLI, which reads your own `~/.claude/settings.json` (`ANTHROPIC_BASE_URL`
→ your local omniroute relay on port 20128). Anthropic keys are never needed.

## One-time setup

```cmd
cd /d I:\Claude\telegram-claude-bridge
npm install
```

Edit `.env`:

- `TELEGRAM_BOT_TOKEN` — from @BotFather for **@ShiClaude_bot**
- `ALLOWED_TELEGRAM_IDS` — your numeric Telegram user ID(s), comma-separated
  (get it from @userinfobot; leave empty to let the first person who messages claim the bot — not recommended)

## Run

Double-click `start-bridge.cmd`, or:

```cmd
node bridge.js
```

Startup log lines show the authorized bot name, chosen proxy route, and access mode.

## Using it from Telegram

| Command | Effect |
|---|---|
| `/new <name>` | create + switch to a fresh named session |
| `/sessions` | list sessions, mark the active one |
| `/use <name>` | switch active session |
| `/stop` | clear queued jobs for this chat |
| `/status` | show proxy route, queue depth, active session |
| any text | becomes a task for the active session; the final report is sent back here |

Sessions are persistent (UUID-backed, resumed via `claude --resume`), so context
survives bridge restarts. Each message runs as one `claude -p` job with
`--dangerously-skip-permissions` in the bridge folder — treat the bot as someone
with full access to this machine: keep `ALLOWED_TELEGRAM_IDS` set to you only.

## Troubleshooting

- `poll error: fetch failed` repeating → your VPN is off; turn it on, the bridge
  re-probes within 10 s. Or set `TELEGRAM_PROXY_URL` explicitly.
- 401 from Telegram → wrong `TELEGRAM_BOT_TOKEN`.
- Job outputs nothing → check that `claude -p "hi"` works in a terminal.
- Large replies are split into chunks; Markdown that fails to parse is re-sent as plain text.

---

📖 **Full technical documentation:** [DOCUMENTATION.md](DOCUMENTATION.md) — architecture,
session lifecycle, proxy-resolution internals, security model, .env reference, and troubleshooting.
