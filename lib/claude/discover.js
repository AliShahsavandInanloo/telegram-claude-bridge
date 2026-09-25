'use strict';

/**
 * Read-only discovery of RUNNING Claude processes on this machine.
 *
 * IMPORTANT: a discovered process is NOT a managed session and is NOT
 * attachable. This is an inventory view only (PID, command line, cwd, start
 * time) so the user can see what Claude is doing outside the bridge. The
 * bridge never injects input into processes it does not own.
 *
 * Implementation: tasklist + wmic-equivalent via PowerShell-free
 * `wmic process` is deprecated; we use `Get-CimInstance`-free plain
 * `tasklist` for PID/exe and derive cwd lazily where possible. To stay
 * shell-safe we spawn these helpers with shell:false and fixed argv.
 *
 * `execImpl` injectable for tests (signature: (file, args) -> {stdout}).
 */

const { spawn } = require('child_process');

/** Run a helper command with fixed argv (no shell) and capture stdout. */
function runHelper(file, args, execImpl) {
  const impl = execImpl || ((f, a) => new Promise((resolve, reject) => {
    const child = spawn(f, a, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve({ stdout }) : reject(new Error(`${f} exited ${code}: ${stderr.trim()}`))));
  }));
  return impl(file, args);
}

/**
 * List Claude processes. Returns [{ pid, name, commandLine, createdAt }].
 * Best effort: missing helpers or access-denied rows are skipped.
 */
async function discoverClaudeProcesses({ execImpl, platform = process.platform } = {}) {
  const results = [];
  if (platform === 'win32') {
    // tasklist /FO CSV gives pid + image name; filter claude images.
    try {
      const { stdout } = await runHelper('tasklist', ['/FO', 'CSV', '/NH'], execImpl);
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)","(\d+)"/);
        if (!m) continue;
        const name = m[1];
        if (!/^claude/i.test(name)) continue;
        results.push({ pid: Number(m[2]), name, commandLine: null, createdAt: null });
      }
    } catch {
      /* tasklist unavailable/failing: fall through to empty result */
    }
  } else {
    try {
      const { stdout } = await runHelper('ps', ['-eo', 'pid=,comm=,lstart='], execImpl);
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/^\s*(\d+)\s+(\S+)/);
        if (!m || !/claude/i.test(m[2])) continue;
        results.push({ pid: Number(m[1]), name: m[2], commandLine: null, createdAt: null });
      }
    } catch {
      /* ps unavailable: fall through */
    }
  }
  return results;
}

module.exports = { discoverClaudeProcesses };
