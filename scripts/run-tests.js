'use strict';

/**
 * Test runner: executes every suite with NODE_ENV=test so that the
 * registry's production-state guard (assertNotProductionStateFile) is
 * active — tests must never write into the repository's real state/.
 * Cross-platform: replaces a shell "VAR=x cmd" chain that needs cross-env.
 */

const { spawnSync } = require('child_process');
const path = require('path');

process.env.NODE_ENV = 'test';

const suites = [
  'bridge.test.js',
  'regression.test.js',
  'claude-manager.test.js',
  'channel.test.js',
  'channel-stabilization.test.js',
  'channel-production.test.js',
  'channel-restart.test.js',
  'channel-registration-txn.test.js',
  'channel-concurrency.test.js',
  'channel-registry-txn-isolation.test.js',
  'global-install.test.js',
];

let failed = 0;
for (const suite of suites) {
  const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'test', suite)], {
    stdio: 'inherit',
    env: process.env,
  });
  if (res.status !== 0) {
    failed += 1;
    console.error(`\nSUITE FAILED: ${suite}`);
  }
}

if (failed) {
  console.error(`\n${failed} of ${suites.length} test suites FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${suites.length} test suites passed.`);
