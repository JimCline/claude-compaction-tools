#!/usr/bin/env node
'use strict';

// UserPromptSubmit hook. The user is active, so cancel the pending timer.
// Removing the state file is what actually disarms it — the kill is only an
// optimisation, since the timer re-reads state before firing.

const state = require('./lib/state');
const { readInput } = require('./lib/hookio');

async function main() {
  const input = await readInput();
  const sessionId = input.session_id;
  if (!sessionId) return;

  const record = state.read(sessionId);
  if (!record) return;

  if (record.timerPid) state.killIfRunning(record.timerPid);
  state.remove(sessionId);
}

main().then(
  () => process.exit(0),
  () => process.exit(0)
);
