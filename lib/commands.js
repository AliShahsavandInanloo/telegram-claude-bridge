'use strict';

/**
 * One canonical list of Telegram bot commands: registered with setMyCommands,
 * used by /help, and matched by the dispatcher. Keep in sync.
 *
 * Telegram Bot API command names must match ^[a-z0-9_]{1,32}$ — hyphens are
 * rejected with BOT_COMMAND_INVALID, so the canonical public forms use
 * underscores. Hyphenated input from users is normalized to the canonical
 * form in parseCommand (backward compatibility; never registered with
 * Telegram).
 */

const BOT_COMMANDS = [
  { command: 'start', description: 'Show bridge help' },
  { command: 'help', description: 'Show available commands' },
  { command: 'new', description: 'Create a managed Claude session (/new <name> <project-path>)' },
  { command: 'sessions', description: 'List managed Claude sessions' },
  { command: 'use', description: 'Switch active session (/use <name>)' },
  { command: 'attach', description: 'Attach to a session (/attach <name|number>)' },
  { command: 'switch', description: 'Switch to another session (/switch <name|number>)' },
  { command: 'detach', description: 'Detach from the current session' },
  { command: 'current', description: 'Show the currently attached session' },
  { command: 'session_status', description: 'Show process, task and latest output' },
  { command: 'files', description: 'List files in the attached project' },
  { command: 'download', description: 'Send a project file here (/download <name>)' },
  { command: 'discover', description: 'List running Claude processes (read-only)' },
  { command: 'stop', description: 'Cancel queued/running bridge work (Channel sessions keep running)' },
  { command: 'terminate_session', description: 'Stop a stream-json session process (explicit)' },
  { command: 'queue', description: 'Show queue state' },
  { command: 'status', description: 'Show bridge status' },
];

/** Hyphenated legacy input -> canonical underscore command name. */
const ALIASES = {
  'session-status': 'session_status',
  'terminate-session': 'terminate_session',
};

/** Split "/cmd@BotName rest..." into { cmd, arg, addressedTo }. */
function parseCommand(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('/')) return null;
  const parts = trimmed.split(/\s+/);
  const rawCmd = parts[0].toLowerCase();
  const at = rawCmd.indexOf('@');
  let cmd = at === -1 ? rawCmd.slice(1) : rawCmd.slice(1, at);
  cmd = ALIASES[cmd] || cmd; // central normalization: legacy hyphen forms route to canonical
  const addressedTo = at === -1 ? null : rawCmd.slice(at + 1);
  const arg = parts.slice(1).join(' ').trim();
  return { cmd, arg, addressedTo };
}

function helpText(botUsername) {
  const title = botUsername ? `*@${botUsername}* — Claude session manager` : '*Claude session manager*';
  const lines = [
    `${title} — manage and drive local Claude Code sessions from Telegram.`,
    '',
  ];
  for (const c of BOT_COMMANDS) {
    const usage = c.command === 'new' ? ' <name> <project-path>' : c.command === 'use' || c.command === 'attach' ? ' <name|number>' : c.command === 'download' ? ' <filename>' : '';
    lines.push(`\`/${c.command}${usage}\` — ${c.description.replace(/ \(\/[a-z]+[^)]*\)/, '')}`);
  }
  lines.push('');
  lines.push('Attach with /attach, then any text becomes a task for that session.');
  return lines.join('\n');
}

module.exports = { BOT_COMMANDS, parseCommand, helpText };
