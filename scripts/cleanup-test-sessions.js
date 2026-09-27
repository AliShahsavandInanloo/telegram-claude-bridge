'use strict';

/**
 * One-off safe cleanup of test-polluted sessions from the REAL registry.
 * Targets only ^tgbridge-stab- and ^chanverify- names. Makes a timestamped
 * backup first, prunes dangling attachment mappings, and verifies the result.
 * NOT part of the test suite or normal runtime.
 */

const fs = require('fs');
const path = require('path');

const REG = path.join(__dirname, '..', 'state', 'claude-sessions.json');
const TEST_PAT = /^(tgbridge-stab-|chanverify-)/;

const raw = fs.readFileSync(REG, 'utf8');
const data = JSON.parse(raw);

const before = Object.keys(data.sessions).length;
const backup = `${REG}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.copyFileSync(REG, backup);
console.log('backup written:', backup);

const removed = [];
const kept = [];
for (const [id, entry] of Object.entries(data.sessions)) {
  if (TEST_PAT.test(entry.name)) removed.push(`${entry.name} (${id})`);
  else kept.push(entry.name);
}

for (const id of Object.keys(data.sessions)) {
  if (TEST_PAT.test(data.sessions[id].name)) delete data.sessions[id];
}

// Prune any attachment mappings that point at removed sessions.
let attachmentsPruned = 0;
for (const [chatId, att] of Object.entries(data.attachments || {})) {
  const attId = typeof att === 'string' ? att : (att.id || att.sessionId);
  if (attId && !data.sessions[attId]) {
    delete data.attachments[chatId];
    attachmentsPruned += 1;
  }
}

fs.writeFileSync(REG, JSON.stringify(data, null, 2) + '\n', 'utf8');

// Verify.
const verify = JSON.parse(fs.readFileSync(REG, 'utf8'));
const stillBad = Object.values(verify.sessions).filter((s) => TEST_PAT.test(s.name));
console.log(`sessions: ${before} -> ${Object.keys(verify.sessions).length}`);
console.log(`removed: ${removed.length}${removed.length ? ':\n  ' + removed.join('\n  ') : ''}`);
console.log(`kept: ${kept.join(', ')}`);
console.log(`attachments pruned: ${attachmentsPruned}`);
console.log(`verification: ${stillBad.length === 0 ? 'CLEAN — no test-pattern sessions remain' : `FAILED: ${stillBad.length} remain`}`);
process.exit(stillBad.length === 0 ? 0 : 1);
