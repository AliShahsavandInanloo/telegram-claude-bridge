'use strict';

/**
 * Managed Claude launcher — process lifecycle only.
 *
 * Responsibilities (single-responsibility adapter):
 *   - spawn a Claude process with the proven launch spec
 *   - expose stdin/stdout/stderr
 *   - kill (SIGTERM -> SIGKILL escalation)
 *   - report exit
 *
 * It deliberately knows nothing about sessions, Telegram or persistence.
 * Security invariants preserved: launch spec {command, prefixArgs},
 * shell:false, argv-only input, windowsHide. The prompt/task text is NEVER
 * part of the command string — it is either a spawn argument (one-shot mode)
 * or data written to the child's stdin (managed mode).
 *
 * spawnFn injectable for tests: (command, args, options) -> child-like object
 * with .stdin/.stdout/.stderr streams and .on/.kill.
 */

const { spawn } = require('child_process');

const SIGKILL_ESCALATION_MS = 5000;

/**
 * Spawn Claude in ONE-SHOT mode (`-p <prompt>`), exactly like the existing
 * bridge job runner. Returns the child process handle.
 *
 * launch:  { command, prefixArgs }
 * claudeArgs: the full argument list AFTER prefixArgs (already validated)
 */
function spawnOneShot(launch, claudeArgs, { cwd, spawnFn = spawn } = {}) {
  return spawnFn(launch.command, [...launch.prefixArgs, ...claudeArgs], {
    cwd,
    env: process.env, // inherits ANTHROPIC_BASE_URL / provider relay config
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
}

/**
 * Spawn Claude as a MANAGED INTERACTIVE process (session management mode).
 *
 * Design: instead of driving the interactive TUI (which expects a TTY and a
 * user), we keep an idling managed process per session ready to run one-shot
 * jobs against a FIXED --session-id. The manager tracks the live child so the
 * bridge can kill/restart it and route jobs without re-resolving the launch
 * spec. All spawn options are identical to the proven one-shot path.
 *
 * launch:  { command, prefixArgs }
 * claudeArgs: argument list AFTER prefixArgs
 */
function spawnManaged(launch, claudeArgs, { cwd, spawnFn = spawn } = {}) {
  const child = spawnFn(launch.command, [...launch.prefixArgs, ...claudeArgs], {
    cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  return child;
}

/**
 * Kill a child with SIGTERM -> SIGKILL escalation.
 * Returns a cleanup function that cancels the escalation timer.
 */
function killProcess(child, { escalationMs = SIGKILL_ESCALATION_MS } = {}) {
  if (!child) return () => {};
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  const t = setTimeout(() => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, escalationMs);
  if (t.unref) t.unref();
  return () => clearTimeout(t);
}

module.exports = { spawnOneShot, spawnManaged, killProcess, SIGKILL_ESCALATION_MS };
