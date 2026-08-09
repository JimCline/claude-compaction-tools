#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');

const directive = require('../scripts/lib/directive');

const INJECT = path.join(__dirname, '..', 'scripts', 'inject.js');

function runHook(payload) {
  return execFileSync('node', [INJECT], { input: JSON.stringify(payload), encoding: 'utf8' });
}

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test('SessionStart states the policy', () => {
  const out = runHook({ hook_event_name: 'SessionStart', source: 'startup', cwd: process.cwd() });
  assert.ok(out.includes('Standing directive'), 'policy missing');
  assert.ok(!out.includes('A compaction just completed'), 'post-compact check leaked into SessionStart');
});

test('PostCompact adds the recovery check', () => {
  const out = runHook({ hook_event_name: 'PostCompact', cwd: process.cwd() });
  assert.ok(out.includes('Standing directive'), 'policy missing');
  assert.ok(out.includes('A compaction just completed'), 'post-compact check missing');
});

test('resume is skipped — the restored transcript already carries the directive', () => {
  const out = runHook({ hook_event_name: 'SessionStart', source: 'resume', cwd: process.cwd() });
  assert.strictEqual(out, '', 'expected no output for source=resume');
});

test('clear is not skipped — an emptied context is when the policy is needed', () => {
  const out = runHook({ hook_event_name: 'SessionStart', source: 'clear', cwd: process.cwd() });
  assert.ok(out.includes('Standing directive'), 'policy missing after clear');
});

test('output is plain text, not a JSON envelope', () => {
  const out = runHook({ hook_event_name: 'PostCompact', cwd: process.cwd() });
  assert.ok(!out.trimStart().startsWith('{'), 'stdout must not be JSON — the envelope is not read on this event');
});

test('render returns empty when the directive resolves empty', () => {
  assert.strictEqual(directive.render('PostCompact', { text: '' }), '');
});

test('a malformed payload does not throw', () => {
  const out = execFileSync('node', [INJECT], { input: 'not json', encoding: 'utf8' });
  assert.ok(out.includes('Standing directive'), 'should fall back to SessionStart behaviour');
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log('ok   ' + name);
  } catch (err) {
    failed++;
    console.log('FAIL ' + name + ' — ' + err.message);
  }
}

console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
