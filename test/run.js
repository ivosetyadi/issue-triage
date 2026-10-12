// Offline test suite for Issue Triage. No network.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { tokenize, similarityText, cosineVec, classifyLabels, rankDuplicates, pickAssignees, loadConfig, DEFAULT_LABELS } = require('../dist/index.js');

let pass = 0;
const ok = (c, m) => {
  assert.ok(c, m);
  pass++;
};

// --- tokenize ----------------------------------------------------------------
ok(!tokenize('The app is broken').includes('the'), 'stopwords removed');
ok(tokenize('```code here```extra').includes('extra') && !tokenize('```code```').includes('code'), 'code fences dropped');

// --- similarity --------------------------------------------------------------
ok(similarityText('login button broken on mobile', 'login button broken on mobile') > 0.99, 'identical text ~1.0');
ok(similarityText('login button broken', 'dark mode theme request') < 0.2, 'unrelated text low');
const s = similarityText('app crashes when saving a file', 'the application crashes while saving files');
ok(s > 0.3 && s < 1, `paraphrase mid similarity (got ${s.toFixed(2)})`);

// --- cosineVec ---------------------------------------------------------------
ok(Math.abs(cosineVec([1, 0, 1], [1, 0, 1]) - 1) < 1e-9, 'identical vectors = 1');
ok(cosineVec([1, 0], [0, 1]) === 0, 'orthogonal vectors = 0');

// --- classifyLabels ----------------------------------------------------------
ok(classifyLabels('App throws an exception on login', DEFAULT_LABELS).includes('bug'), 'bug label');
ok(classifyLabels('Please add support for dark mode', DEFAULT_LABELS).includes('enhancement'), 'enhancement label');
ok(classifyLabels('Found an XSS vulnerability', DEFAULT_LABELS).includes('security'), 'security label');
ok(classifyLabels('Just saying hello', DEFAULT_LABELS).length === 0, 'no keyword → no label');

// --- rankDuplicates ----------------------------------------------------------
const cands = [
  { number: 1, text: 'login button is broken on mobile devices' },
  { number: 2, text: 'add dark mode theme support' },
  { number: 3, text: 'mobile login button broken' },
];
const dupes = rankDuplicates('the login button broken on mobile', cands, 0.3, similarityText);
ok(dupes.length >= 1 && (dupes[0].number === 1 || dupes[0].number === 3), 'top duplicate is a login-button issue');
ok(!dupes.some((d) => d.number === 2), 'unrelated issue not flagged');

// --- pickAssignees -----------------------------------------------------------
ok(pickAssignees(['security', 'bug'], { security: ['alice'], bug: ['bob'] }).sort().join() === 'alice,bob', 'assignees from labels');
ok(pickAssignees(['bug'], { security: ['alice'] }).length === 0, 'no mapping → none');

// --- loadConfig --------------------------------------------------------------
const tmp = path.join(__dirname, '.tmp-triage.yml');
fs.writeFileSync(tmp, 'duplicate-threshold: 0.7\ncomment: false\nlabels:\n  bug: oops, borked\n  perf: slow, lag\nassignees:\n  security: alice, bob\n');
process.env.INPUT_CONFIG = tmp;
const cfg = loadConfig();
ok(cfg['duplicate-threshold'] === 0.7, 'threshold parsed');
ok(cfg.comment === false, 'comment flag parsed');
ok(cfg.labels.bug.join() === 'oops,borked' && cfg.labels.perf.join() === 'slow,lag', 'nested labels parsed');
ok(cfg.assignees.security.join() === 'alice,bob', 'nested assignees parsed');
fs.unlinkSync(tmp);
delete process.env.INPUT_CONFIG;

// missing config → defaults
process.env.INPUT_CONFIG = path.join(__dirname, 'nope.yml');
const d = loadConfig();
ok(d['duplicate-threshold'] === 0.35 && d.comment === true, 'missing config → defaults');
delete process.env.INPUT_CONFIG;

console.log(`✓ ${pass} assertions passed`);
