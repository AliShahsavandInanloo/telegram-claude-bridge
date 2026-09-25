#!/usr/bin/env node
'use strict';

/**
 * Cross-platform `npm run check`: syntax-checks (node --check) EVERY .js file
 * in bridge.js, lib/ and test/ — discovered by glob, not a hand-written list
 * (the old list silently missed new files, e.g. test/channel-production.test.js).
 * Windows-safe (pure Node, no shell).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = [path.join(ROOT, 'bridge.js')];
files.push(...walk(path.join(ROOT, 'lib'), []));
files.push(...walk(path.join(ROOT, 'test'), []));
files.push(...walk(path.join(ROOT, 'scripts'), []));

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log(`ok  ${path.relative(ROOT, f)}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${path.relative(ROOT, f)}\n${err.stderr || err.message}`);
  }
}
console.log(`\nchecked ${files.length} files, ${failed} failed`);
process.exit(failed ? 1 : 0);
