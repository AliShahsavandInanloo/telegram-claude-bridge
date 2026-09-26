#!/usr/bin/env node
'use strict';

/**
 * Global Channel launcher for telegram-bridge.
 *
 * Claude Code spawns this file as the `telegram-bridge` MCP server (stdio
 * transport) when a user-scope registration points at it. Its ONLY jobs are:
 *
 *   1. locate the Bridge installation (this file's parent directory)
 *   2. load the Bridge channel configuration (.env) for the hub port
 *   3. read the channel secret from a FILE (state/channel-secret by default),
 *      never from the MCP configuration or the process command line
 *   4. export CLAUDE_CHANNEL_PORT / CLAUDE_CHANNEL_SECRET internally
 *   5. run the real Channel MCP server in-process
 *
 * Design constraints (deliberate):
 *   - The secret is read from disk at runtime, so it is never stored in
 *     ~/.claude.json, never committed, and never appears in an argv list.
 *   - No subprocess is spawned: the Channel runs in THIS process, so there is
 *     no shell interpolation, no PowerShell command construction, and no extra
 *     process holding a copy of the secret environment.
 *   - stdout is reserved for the MCP JSON-RPC stream; everything diagnostic
 *     goes to stderr.
 *   - The secret is never logged. Errors name the file, never the value.
 *
 * Configuration resolution (single source of truth):
 *   port   -> <root>/.env  CLAUDE_CHANNEL_PORT   (fallback 8765, matching bridge.js)
 *   secret -> CLAUDE_CHANNEL_SECRET_FILE if set, else <root>/state/channel-secret
 *             (an explicitly exported CLAUDE_CHANNEL_SECRET still wins, so the
 *             documented manual/local mode keeps working)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULT_CHANNEL_PORT = 8765; // mirrors bridge.js intEnv(..., { def: 8765 })
const MIN_SECRET_LENGTH = 16; // mirrors the guard in lib/channel/claude-channel.js

const { applyEnvFile, intEnv } = require(path.join(ROOT, 'lib', 'config.js'));

/**
 * Where the channel secret is read from. An explicit CLAUDE_CHANNEL_SECRET_FILE
 * wins; otherwise the Bridge's own generated state file.
 */
function resolveSecretPath({ root = ROOT, env = process.env } = {}) {
  const explicit = String(env.CLAUDE_CHANNEL_SECRET_FILE || '').trim();
  if (explicit) return path.resolve(explicit);
  return path.join(root, 'state', 'channel-secret');
}

/**
 * Read + validate the secret file. The value is returned, never logged; thrown
 * errors deliberately mention only the path and the reason.
 */
function readSecretFile(file, fsImpl = fs) {
  let raw;
  try {
    raw = fsImpl.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(
      `channel secret not readable at ${file} (${err.code || err.message}) — ` +
        'start the Bridge once so it generates state/channel-secret, or set CLAUDE_CHANNEL_SECRET_FILE',
    );
  }
  const secret = String(raw).trim();
  if (!secret) throw new Error(`channel secret file ${file} is empty`);
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`channel secret file ${file} is too short (need >= ${MIN_SECRET_LENGTH} chars)`);
  }
  return secret;
}

/**
 * Resolve the complete channel configuration without mutating the environment.
 * Pure with respect to injected dependencies, so it is unit-testable.
 */
function bootstrap({ root = ROOT, env = process.env, fsImpl = fs } = {}) {
  // .env supplies the port; real environment variables keep precedence.
  applyEnvFile(root, env, fsImpl);

  const portCheck = intEnv(env.CLAUDE_CHANNEL_PORT, {
    name: 'CLAUDE_CHANNEL_PORT',
    def: DEFAULT_CHANNEL_PORT,
    min: 1024,
    max: 65535,
  });
  if (!portCheck.ok) throw new Error(`bad channel port: ${portCheck.error}`);

  const secretPath = resolveSecretPath({ root, env });
  const inline = String(env.CLAUDE_CHANNEL_SECRET || '');
  const usesInline = inline.length >= MIN_SECRET_LENGTH;
  const secret = usesInline ? inline : readSecretFile(secretPath, fsImpl);

  return {
    root,
    port: portCheck.value,
    secret,
    secretPath,
    secretSource: usesInline ? 'environment (CLAUDE_CHANNEL_SECRET)' : secretPath,
  };
}

/** Export the resolved values into a process environment. */
function applyToEnv(cfg, env = process.env) {
  env.CLAUDE_CHANNEL_PORT = String(cfg.port);
  env.CLAUDE_CHANNEL_SECRET = cfg.secret;
  return env;
}

/** Redacted description of the resolved configuration (never the secret). */
function describe(cfg) {
  return {
    ok: true,
    root: cfg.root,
    port: cfg.port,
    secretSource: cfg.secretSource,
    secretLength: cfg.secret.length,
  };
}

async function main() {
  // Our own flag: report the resolved config WITHOUT the secret and exit
  // before touching the MCP transport. Safe to run anywhere, prints to stdout.
  if (process.argv.includes('--selftest') || process.argv.includes('--check-config')) {
    const cfg = bootstrap();
    console.log(JSON.stringify({ ...describe(cfg), node: process.execPath }));
    return;
  }

  const cfg = bootstrap();
  applyToEnv(cfg);

  // Loaded AFTER the environment is set: the Channel reads CLAUDE_CHANNEL_PORT
  // / CLAUDE_CHANNEL_SECRET into module-level constants at require time.
  const channel = require(path.join(ROOT, 'lib', 'channel', 'claude-channel.js'));
  await channel.main();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`telegram-bridge channel launcher failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  ROOT,
  DEFAULT_CHANNEL_PORT,
  MIN_SECRET_LENGTH,
  resolveSecretPath,
  readSecretFile,
  bootstrap,
  applyToEnv,
  describe,
  main,
};
