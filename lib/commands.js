'use strict';

/**
 * One canonical list of Telegram commands: registered with setMyCommands,
 * used by /help, and matched by the dispatcher. Keep in sync.
 */

const BOT_COMMANDS = [
  { command: 'start', description: 'Show bridge help' },
  { command: 'help', description: 'Show available commands' },
  { command: 'new', description: 'Create a new Claude session (/new <name>)' },
  { command: 'sessions', description: 'List Claude sessions' },
  { command: 'use', description: 'Switch active session (/use <name>)' },
  { command: 'stop', description: 'Cancel running job and clear this chat queue' },
  { command: 'queue', description: 'Show queue state' },
  { command: 'status', description: 'Show bridge status' },
];

const COMMAND_NAMES = new Set(BOT_COMMANDS.map((c) => c.command));

/** Split "/cmd@BotName rest..." into { cmd, arg, addressedTo }. */
function parseCommand(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('/')) return null;
  const parts = trimmed.split(/\s+/);
  const rawCmd = parts[0].toLowerCase();
  const at = rawCmd.indexOf('@');
  const cmd = at === -1 ? rawCmd.slice(1) : rawCmd.slice(1, at);
  const addressedTo = at === -1 ? null : rawCmd.slice(at + 1);
  const arg = parts.slice(1).join(' ').trim();
  return { cmd, arg, addressedTo };
}

function helpText(botUsername) {
  const title = botUsername ? `*@${botUsername}* — Claude Code bridge` : '*Claude Code bridge*';
  const lines = [
    `${title} — drive your local Claude Code harness from Telegram.`,
    '',
  ];
  for (const c of BOT_COMMANDS) {
    const usage = c.command === 'new' || c.command === 'use' ? ` <name>` : '';
    lines.push(`\`/${c.command}${usage}\` — ${c.description.replace(/ \(\/[a-z]+ <name>\)/, '')}`);
  }
  lines.push('');
  lines.push('Any other text is sent to the active session as a task; the final report comes back here.');
  return lines.join('\n');
}

module.exports = { BOT_COMMANDS, COMMAND_NAMES, parseCommand, helpText };
