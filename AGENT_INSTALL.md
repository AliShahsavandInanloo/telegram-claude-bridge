# Install with an AI coding agent (optional)

This is an **optional** installation method. If you use Claude Code, Codex, or
another capable coding agent, you can paste the prompt below and let the agent
install and verify the Bridge for you. If you prefer to do it yourself, use the
regular [manual installation](README.md#installation) — both methods use the
**same** supported installer (`npm run install-global`); this document adds no
second installer, it only orchestrates it.

**How to use:** open your coding agent on a Windows computer, copy everything in
the prompt section below, paste it into the agent, and follow its questions. You
will only need to enter your Telegram secrets locally at the end.

---

## The prompt

Copy everything below this line into your coding agent.

---

Install telegram-claude-bridge on this Windows computer.

Repository: https://github.com/AliShahsavandInanloo/telegram-claude-bridge

Goal: install the Telegram ↔ Claude Code Bridge and its global Claude Code
Channel integration for this Windows user. Do not modify unrelated applications
or Claude configuration. Do not expose secrets.

**FIRST: CHECK PREREQUISITES**

Verify Windows, Git, Node.js, npm, and Claude Code by running:

    git --version
    node --version
    npm --version
    claude --version

If Git, Node.js, npm, or Claude Code is missing: stop and tell the user exactly
which prerequisite is missing. Do not install unrelated system software without
explicit approval.

**INSTALL LOCATION**

If telegram-claude-bridge is already installed: locate the existing repository.
If it is a valid clone of the requested repository, update it safely with Git
after checking `git status` for local changes. Do NOT destroy local
modifications and never run `git reset --hard` or any destructive cleanup
without explicit user approval.

If it is not already installed: choose a sensible user-writable installation
location, preferably `%USERPROFILE%\Claude\telegram-claude-bridge` or another
existing user development directory. Do NOT require Administrator privileges.
Clone:

    git clone https://github.com/AliShahsavandInanloo/telegram-claude-bridge.git

Enter the repository.

**DEPENDENCIES**

Run `npm ci`, then `npm run check`, then `npm test`. Do not continue with global
installation if the repository's required validation fails.

**CONFIGURATION**

If `.env` does not exist, copy `.env.example` to `.env`. Do NOT put secrets in
source-controlled files. Do NOT commit `.env`.

The required user-specific values are:

- `TELEGRAM_BOT_TOKEN` — the token issued by Telegram BotFather
- `ALLOWED_TELEGRAM_IDS` — the Telegram numeric user ID(s) permitted to control
  the Bridge (get yours from @userinfobot). The Bridge refuses to start without
  this, because every job runs Claude with full access to the target computer.

If these values are missing, tell the user exactly what is needed.

IMPORTANT SECURITY RULE: do not ask the user to paste the Telegram bot token
into the AI chat if it can be avoided. Prefer telling the user to open the local
`.env` file and enter the token directly there. Never print the full token after
it has been configured; if a token is accidentally displayed, redact it in
subsequent output.

**CHANNEL PORT**

Use the repository's existing configuration; do not invent a second Channel
configuration system. If `CLAUDE_CHANNEL_PORT` is absent in `.env`, use the
application's documented default (8765). If the configured/default port is
occupied, identify the process using it. Do NOT kill that process
automatically — tell the user what owns the port and offer these choices:
stop the conflicting application, or configure another `CLAUDE_CHANNEL_PORT`.

**WRAPPER BIN DIRECTORY**

The installer verifies that the wrapper directory is on PATH instead of
assuming it. If it reports the chosen bin directory is not on PATH (or exits
non-zero with that warning), identify a safe user-writable directory that IS
already on PATH (for example `%APPDATA%\npm`) and re-run:

    npm run install-global -- --bin-dir "<user-writable directory already on PATH>"

Never modify the user's PATH automatically without explicit user approval, and
never write wrappers into system or administrator-only directories.

**GLOBAL INSTALLATION**

Use the repository's existing supported installer:

    npm run install-global

Do NOT manually duplicate what the installer already does. The installer
establishes the `telegram-claude-bridge` and `claude-telegram` commands and
registers the Claude MCP server `telegram-bridge` at Claude Code USER scope.

**VERIFY GLOBAL MCP**

Run `claude mcp get telegram-bridge` and verify: scope is User, the server is
connected or correctly configured, the launcher points to this installation,
and no Telegram bot token or Channel secret value appears in the MCP
configuration.

**VERIFY COMMANDS**

Verify that `telegram-claude-bridge` and `claude-telegram` resolve from the
command line, using non-destructive checks where available. Do not leave
unnecessary duplicate Bridge instances running.

**START THE BRIDGE**

If configuration is complete, start the Bridge with `telegram-claude-bridge`.
Verify logs show the Channel hub listening locally, conceptually
`channel hub listening on 127.0.0.1:<port>`, and eventually
`listening for messages`.

If Telegram cannot be reached, do not rewrite networking. Explain whether the
problem is: direct Telegram connectivity, a proxy/VPN requirement, an invalid
bot token, or another Telegram getUpdates consumer. Do not confuse Telegram
"Unauthorized" (bad token) with a VPN error.

**CLAUDE CHANNEL TEST**

From an unrelated project directory, run `claude-telegram`. This must use the
globally registered `telegram-bridge` MCP server. Do not add a project-local
`.mcp.json` unless the global installation genuinely failed and the user
explicitly asks for a fallback.

Claude Code may display a development-channel consent warning because custom
Channels are experimental; tell the user to accept "I am using this for local
development" when appropriate.

**VERIFY CHANNEL REGISTRATION**

With the Bridge running and claude-telegram open in a project: verify the
Bridge logs that a Channel session became online, then tell the user to run
`/sessions` from Telegram. The live Claude project should appear marked
`[CHANNEL]`. If Telegram connectivity is available, attach/switch to that
session and send a test message. Success means the Telegram message appears
inside the live Claude Code session through the custom Channel. Do NOT count a
headless one-shot/stream process as this acceptance test.

**IMPORTANT ARCHITECTURE RULE**

There must be exactly ONE Telegram Bot API poller: the central Bridge. The
Claude Channel MCP processes connect only to the local Bridge. Do NOT configure
Anthropic's official Telegram plugin with the same bot token. If
`plugin:telegram` is already enabled, do not delete unrelated settings
automatically — warn the user that configuring it with the same bot token could
create Telegram getUpdates conflicts.

**DO NOT MODIFY**

Do not alter the Bridge architecture, Channel protocol, registry
implementation, session routing, Telegram security model, or tests unless the
installation exposes an actual repository bug. If an actual bug is found,
report it before making any product-code change.

**FINAL VALIDATION**

Run `npm run check` and `npm test`. Verify `git status` shows that
installation-generated local files such as `.env`, `state/`, and the channel
secret are NOT committed.

**SECURITY RULES (ALWAYS)**

- never commit `.env`, `state/`, or the channel secret
- never paste Telegram bot tokens into public chats or issues
- never print secrets in the final report
- never place the Telegram token in the Claude MCP configuration
- never automatically kill unknown processes occupying a port

**FINAL REPORT**

Tell the user:

- the installation directory
- the Bridge command: `telegram-claude-bridge`
- the Claude Channel command: `claude-telegram`
- the MCP status
- the Channel port
- whether Telegram connectivity was verified
- whether a live Claude Channel registered
- whether Telegram → live Claude message delivery was verified
- any remaining manual step

Do not expose the Telegram bot token, the Channel secret, or proxy credentials.
Do not commit or push anything unless the user explicitly requested development
changes to the repository.

---

*End of the copyable prompt.*

---

## What the agent will do

1. Verify Windows / Git / Node / npm / Claude Code prerequisites.
2. Clone (or safely update) the repository into a user-writable directory.
3. `npm ci` → `npm run check` → `npm test` — it stops if validation fails.
4. Copy `.env.example` → `.env` and ask **you** to enter the bot token and
   allowed user IDs locally in the file (never in the chat).
5. Run the supported installer `npm run install-global`, which registers the
   user-scope `telegram-bridge` MCP server and installs the
   `telegram-claude-bridge` and `claude-telegram` commands.
6. Verify the MCP registration, start the Bridge, and walk you through the
   live Channel test from Telegram (`/sessions` → `[CHANNEL]` → test message).
