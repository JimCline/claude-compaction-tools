#!/usr/bin/env node
'use strict';

// UserPromptSubmit hook. The user is active, so cancel the pending timer.
// Removing the state file is what actually disarms it — the kill is only an
// optimisation, since the timer re-reads state before firing.
//
// One exception: a keepalive ping is itself a real, non-slash prompt (it
// can't be a slash command — Claude Code would intercept it before the model
// ever saw it, so the cache would never actually get read), so submitting it
// fires this same hook. Without this guard every ping would disarm itself
// the instant it was typed, since from here it is indistinguishable from the
// user coming back. Only an exact match skips the disarm, and only in
// keepalive mode — arm.js is what confirms the ping and re-arms.

const state = require('./lib/state');
const prompt = require('./lib/prompt');
const { readInput } = require('./lib/hookio');

async function main() {
  const input = await readInput();
  const sessionId = input.session_id;
  if (!sessionId) return;

  const record = state.read(sessionId);
  if (!record) return;

  if (record.mode === 'keepalive' && input.prompt === prompt.KEEPALIVE_SENTINEL) return;

  if (record.timerPid) state.killIfRunning(record.timerPid);
  state.remove(sessionId);
}

main().then(
  () => process.exit(0),
  () => process.exit(0)
);
