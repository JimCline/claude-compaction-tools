#!/usr/bin/env node
'use strict';

// SessionStart hook. Two jobs:
//   1. Sweep timers left behind by sessions that ended without a disarm.
//   2. On the very first run after install, ask Claude to walk the user
//      through choosing an idle threshold. Claude Code has no interactive
//      install hook, so first-session prompting is the closest equivalent.

const path = require('path');

const config = require('./lib/config');
const state = require('./lib/state');
const { readInput, emit } = require('./lib/hookio');

function sweep() {
  for (const file of state.listSessions()) {
    const record = state.readPath(file);
    if (!record) continue;
    if (record.claudePid && state.isAlive(record.claudePid)) continue;
    if (record.timerPid) state.killIfRunning(record.timerPid);
    state.remove(record.sessionId);
  }
}

function setupContext(cfg) {
  const cli = path.join(__dirname, 'config-cli.js');
  return [
    'The idle-compactor plugin is installed but has not been configured yet.',
    '',
    'Before doing anything else, run its one-time setup with the user:',
    '',
    '1. Tell them the plugin will run /compact automatically after a period of',
    '   inactivity, timed to land just before the Anthropic prompt cache expires.',
    '2. Ask BOTH of the following in a SINGLE AskUserQuestion call — not two',
    '   separate calls, and not one question followed by prose.',
    '',
    '   Question 1, header "Idle wait" — how long a session may sit idle before',
    '   it is compacted:',
    '   - "' + config.defaultMinutesFor('1h') + ' minutes (recommended)" — matches the 1-hour cache TTL minus 5 minutes.',
    '   - "' + config.defaultMinutesFor('5m') + ' minutes" — matches the 5-minute default cache TTL minus 1 minute.',
    '   - "Custom" — any number of minutes they name.',
    '   - "Disable for now" — leave it off.',
    '',
    '   Question 2, header "Min context" — the smallest context worth compacting.',
    '   Below this the plugin stays dormant, because compacting a small context',
    '   discards a cheap warm cache and reclaims almost nothing:',
    '   - "' + config.DEFAULTS.minTokens.toLocaleString('en-US') + ' tokens (recommended)" — skips short sessions.',
    '   - "50,000 tokens" — only compact sessions that have grown large.',
    '   - "Always" — no floor; compact whenever idle.',
    '   - "Custom" — any token count they name.',
    '',
    '3. Apply the answers with Bash. One command from this set:',
    '   ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(cli) + ' set ttl 1h',
    '   ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(cli) + ' set ttl 5m',
    '   ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(cli) + ' set minutes <N>',
    '   ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(cli) + ' off',
    '   and this one for the floor ("Always" means 0):',
    '   ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(cli) + ' set min-tokens <N>',
    '   Set the floor even if they disabled the plugin, so it is right when they',
    '   turn it back on.',
    '4. Finally run: ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(cli) + ' setup-done',
    '   so this prompt does not appear again. Run it even if they chose to disable.',
    '',
    'Keep the whole exchange to that one question call. Afterwards, continue',
    'with whatever the user actually asked for.',
  ].join('\n');
}

async function main() {
  await readInput();
  sweep();

  // Recorded so /idle-compact can find the plugin even if ${CLAUDE_PLUGIN_ROOT}
  // is not substituted inside a command body, and so it uses the same Node
  // binary the hooks run under rather than whatever `node` resolves to.
  config.write({
    pluginRoot: path.resolve(__dirname, '..'),
    nodePath: process.execPath,
  });

  const cfg = config.resolve();
  if (cfg.setupCompleted) return;

  emit({
    systemMessage:
      'idle-compactor is installed but not configured. Default idle threshold is ' +
      config.defaultMinutesFor(config.DEFAULT_TTL) +
      ' minutes (1h prompt-cache TTL minus 5 minutes). Run /idle-compact setup to change it.',
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: setupContext(cfg),
    },
  });
}

main().then(
  () => process.exit(0),
  () => process.exit(0)
);
