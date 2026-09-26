'use strict';

/**
 * Managed interactive Claude session.
 *
 * A ManagedSession owns ONE long-lived Claude child process running in
 * interactive mode (`claude` reading stdin line-JSON, `--output-format
 * stream-json`) plus the bridge-side state needed to drive it:
 *
 *   - pending prompt queue (one task at a time, FIFO)
 *   - bounded output capture + incremental emission (streaming)
 *   - turn completion detection (Claude prints a `result` JSON line at the
 *     end of every turn in stream-json mode)
 *   - kill/restart lifecycle
 *
 * Security: the user text is written to the child's STDIN as a JSON line —
 * it is never part of a command string and never passes through a shell.
 * All Claude arguments are fixed at spawn time from the registry entry.
 *
 * `stream-json --input-format stream-json` is the documented headless
 * bidirectional protocol; each user message is one JSON line:
 *   {type:"user", message:{role:"user", content:[{type:"text", text}]}}
 * and the turn ends with a line {type:"result", ...}. See:
 * https://docs.claude.com/en/docs/claude-code/sdk (headless/stream-json).
 */

const { spawnManaged, killProcess } = require('./launcher');

const TAIL_LIMIT = 8000; // rolling tail kept for /session-status

function createManagedSession(entry, launch, { spawnFn, logInfo = () => {}, logError = () => {}, onClaudeSessionId } = {}) {
  const args = [
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ];
  if (entry.initialized && entry.claudeSessionId) {
    args.push('--resume', entry.claudeSessionId);
  }

  let child = null;
  let sessionId = entry.claudeSessionId || null;
  let starting = true;
  let killed = false;
  let exitInfo = null; // { code, signal }
  let currentTask = null; // { text, startedAt, output, onProgress }
  let currentProgressListener = null;
  let taskQueue = [];
  let stdoutBuf = '';
  let tail = ''; // rolling recent output for /session-status
  const listeners = { progress: [], result: [], exit: [] };

  function pushTail(chunk) {
    tail += chunk;
    if (tail.length > TAIL_LIMIT) tail = tail.slice(-TAIL_LIMIT);
  }

  function emit(event, data) {
    for (const fn of listeners[event] || []) {
      try {
        fn(data);
      } catch (err) {
        logError(`managed session listener error: ${err.message}`);
      }
    }
  }

  function processLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg = null;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      pushTail(trimmed + '\n');
      if (currentTask) currentTask.output += trimmed + '\n';
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'system' && msg.subtype === 'init') {
      // First response after spawn: the session is live.
      starting = false;
      if (msg.session_id) {
        sessionId = msg.session_id;
        // Persist through the owner (manager) INSIDE its registry transaction.
        // Only when no owner callback exists (direct unit use) fall back to
        // updating the entry reference.
        if (typeof onClaudeSessionId === 'function') onClaudeSessionId(msg.session_id);
        else {
          entry.claudeSessionId = msg.session_id;
          entry.initialized = true;
        }
      }
      pushTail(`[init session_id=${msg.session_id || '?'}]\n`);
      return;
    }
    if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block && block.type === 'text' && block.text) {
          pushTail(block.text + '\n');
          if (currentTask) {
            currentTask.output += block.text + '\n';
            emit('progress', { text: block.text });
          }
        }
      }
      return;
    }
    if (msg.type === 'result') {
      const summary = typeof msg.result === 'string' ? msg.result : '';
      pushTail(`[result ${msg.subtype || ''}]\n`);
      finishTask({ ok: msg.subtype !== 'error_max_turns' && msg.subtype !== 'error_during_execution', summary, is_error: !!msg.is_error });
    }
  }

  function finishTask({ ok, summary, is_error }) {
    const task = currentTask;
    currentTask = null;
    if (currentProgressListener) {
      const i = listeners.progress.indexOf(currentProgressListener);
      if (i !== -1) listeners.progress.splice(i, 1);
      currentProgressListener = null;
    }
    if (task) emit('result', { ok, summary, is_error, runtimeMs: Date.now() - task.startedAt, output: task.output });
    const next = taskQueue.shift();
    if (next) startTask(next.text, next.onProgress, next.onResult);
  }

  function startTask(text, onProgress, onResult) {
    currentTask = { text, startedAt: Date.now(), output: '' };
    if (onProgress) {
      currentProgressListener = onProgress;
      listeners.progress.push(onProgress);
    }
    if (onResult) listeners.result.push(onResult);
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
    try {
      child.stdin.write(line + '\n');
    } catch (err) {
      logError(`managed session stdin write failed: ${err.message}`);
      finishTask({ ok: false, summary: `failed to send task: ${err.message}`, is_error: true });
    }
  }

  function attachChild(c) {
    child = c;
    c.stdout && c.stdout.on('data', (d) => {
      stdoutBuf += d.toString('utf8');
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        processLine(line);
      }
    });
    c.stderr && c.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      pushTail(s);
      if (currentTask) currentTask.output += s;
    });
    c.on('error', (err) => {
      logError(`managed session process error: ${err.message}`);
      if (currentTask) finishTask({ ok: false, summary: `process error: ${err.message}`, is_error: true });
      emit('exit', { code: null, signal: null, error: err.message });
    });
    c.on('close', (code, signal) => {
      exitInfo = { code, signal };
      if (currentTask) finishTask({ ok: false, summary: `claude exited (code ${code}${signal ? `, signal ${signal}` : ''})`, is_error: true });
      emit('exit', { code, signal });
    });
  }

  return {
    entry,
    id: entry.id,
    /** Start the underlying Claude process. */
    start() {
      killed = false;
      exitInfo = null;
      starting = true;
      const c = spawnManaged(launch, args, { cwd: entry.project, spawnFn });
      attachChild(c);
      return c;
    },
    /**
     * Queue a user task; resolves with {ok, summary, output, runtimeMs} when
     * THIS task finishes. A task queued behind another resolves with its own
     * eventual result (never a throwaway "queued" ack that loses the reply).
     * {queued: true, position} is still included so callers can show "queued"
     * immediately via the separate onQueued notification in the manager.
     */
    submitTask(text, onProgress) {
      return new Promise((resolve) => {
        const onResult = (r) => {
          const idx = listeners.result.indexOf(onResult);
          if (idx !== -1) listeners.result.splice(idx, 1);
          const pIdx = onProgress ? listeners.progress.indexOf(onProgress) : -1;
          if (pIdx !== -1) listeners.progress.splice(pIdx, 1);
          resolve(r);
        };
        if (!child || exitInfo) {
          resolve({ ok: false, summary: 'claude process is not running', is_error: true });
          return;
        }
        if (currentTask) {
          // Park the resolver WITH the task so it fires when THIS task's turn
          // completes (fix: queued callers previously lost the final result).
          taskQueue.push({ text, onProgress, onResult, submittedAt: Date.now() });
          return;
        }
        listeners.result.push(onResult);
        startTask(text, onProgress);
      });
    },
    isRunning() {
      return !!child && !exitInfo && child.exitCode === null;
    },
    isStarting() {
      return starting && this.isRunning();
    },
    getStatus() {
      return {
        pid: child && child.pid ? child.pid : null,
        running: this.isRunning(),
        starting: this.isStarting(),
        busy: !!currentTask,
        task: currentTask ? currentTask.text : null,
        taskStartedAt: currentTask ? currentTask.startedAt : null,
        queuedTasks: taskQueue.length,
        exit: exitInfo,
        latestOutput: tail.trimEnd(),
        claudeSessionId: sessionId,
      };
    },
    /** Cancel the current task by killing the process (restart handled by manager). */
    kill(reason) {
      killed = true;
      // Queued waiters must not hang: fail them BEFORE the current task's
      // finishTask drains the queue into a dying process.
      const waiters = taskQueue;
      taskQueue = [];
      for (const t of waiters) {
        if (t.onResult) t.onResult({ ok: false, summary: `cancelled before start (${reason || 'stopped'})`, is_error: false });
      }
      if (currentTask) finishTask({ ok: false, summary: `cancelled (${reason || 'stopped'})`, is_error: false });
      return killProcess(child);
    },
    /** Subscribe to 'progress' | 'result' | 'exit'. Returns an unsubscribe fn. */
    on(event, fn) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
      return () => {
        const i = listeners[event].indexOf(fn);
        if (i !== -1) listeners[event].splice(i, 1);
      };
    },
    /** Aggregate stdout listeners for tests. */
    _processLine: processLine,
    _child: () => child,
  };
}

module.exports = { createManagedSession };
