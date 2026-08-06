#!/usr/bin/env node
'use strict';

// Stop hook. Claude Code has finished a turn, so the session is now idle.
// Schedule a detached timer that will inject /compact if nothing happens
// before the prompt cache is about to expire.

const path = require('path');
const { spawn } = require('child_process');

const config = require('./lib/config');
const state = require('./lib/state');
const transcript = require('./lib/transcript');
const inject = require('./lib/inject');
const prompt = require('./lib/prompt');
const { readInput } = require('./lib/hookio');

async function main() {
  const input = await readInput();
  const cfg = config.resolve();
  const sessionId = input.session_id;
  if (!sessionId) return;

  // Whatever was armed by the previous turn is stale now.
  const previous = state.read(sessionId);
  if (previous && previous.timerPid) state.killIfRunning(previous.timerPid);

  if (!cfg.enabled) {
    state.remove(sessionId);
    return;
  }

  const transcriptPath = input.transcript_path;
  const tokens = transcriptPath ? transcript.contextTokens(transcriptPath) : null;

  // Compacting a small context throws away a cheap cache for nothing.
  if (tokens !== null && tokens < cfg.minTokens) {
    state.remove(sessionId);
    return;
  }

  const armedAt = Date.now();
  const armId = state.newArmId();
  const cwd = input.cwd || process.cwd();
  // Resolved now rather than at fire time so the text that will be typed is
  // visible in the state file, and so a prompt file edited mid-idle cannot
  // change what this armed timer sends.
  const text = prompt.compactCommand(cwd, cfg);
  const record = {
    version: 1,
    armId,
    sessionId,
    cwd,
    transcriptPath: transcriptPath || null,
    transcriptMtime: transcriptPath ? transcript.mtimeMs(transcriptPath) : null,
    contextTokens: tokens,
    armedAt,
    fireAt: armedAt + cfg.idleMinutes * 60 * 1000,
    idleMinutes: cfg.idleMinutes,
    cacheTtl: cfg.cacheTtl,
    allowBlindInjection: cfg.allowBlindInjection,
    text,
    nodePath: process.execPath,
    env: inject.captureEnv(),
    tty: inject.controllingTty(process.ppid),
    claudePid: inject.findClaudePid(process.ppid),
    timerPid: null,
    fired: null,
  };

  const statePath = state.write(sessionId, record);

  const child = spawn(
    process.execPath,
    [path.join(__dirname, 'timer.js'), statePath, armId],
    { detached: true, stdio: 'ignore', windowsHide: true }
  );
  child.unref();

  record.timerPid = child.pid;
  state.write(sessionId, record);
}

main().then(
  () => process.exit(0),
  () => process.exit(0)
);
