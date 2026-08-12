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
const stats = require('./lib/stats');
const { readInput } = require('./lib/hookio');

async function main() {
  const input = await readInput();
  const cfg = config.resolve();
  const sessionId = input.session_id;
  if (!sessionId) return;

  // Whatever was armed by the previous turn is stale now.
  const previous = state.read(sessionId);
  if (previous && previous.timerPid) state.killIfRunning(previous.timerPid);

  const transcriptPath = input.transcript_path;

  // A keepalive ping is confirmed by this very Stop event: had the user
  // typed for real instead, disarm.js would already have removed this state
  // before Stop ever fired (its own prompt won't match the sentinel), so a
  // keepalive record surviving to here means Claude just replied to our own
  // ping. Classify it and carry the count forward before deciding whether to
  // arm again.
  let pingCount = 0;
  if (previous && previous.mode === 'keepalive' && previous.fired && previous.fired.ok) {
    const usage = transcriptPath ? transcript.lastUsage(transcriptPath) : null;
    const verdict = stats.classifyPingUsage(usage);
    // The chain the *ping* belonged to is the record that fired it, not the
    // record about to be armed next; previous.armId is the pre-chainId
    // fallback for state written before this field existed.
    const chainOfPing = previous.chainId || previous.armId;
    if (verdict) {
      stats.recordPing(sessionId, verdict, {
        chainId: chainOfPing,
        model: previous.model,
        effort: previous.effort,
        usage,
        previousContextTokens: previous.contextTokens,
      });
    }
    pingCount = (previous.pingCount || 0) + 1;
    if (cfg.idleAction === 'keepalive' && pingCount >= cfg.keepaliveMaxPings) {
      stats.record(
        sessionId,
        { ok: true, reason: 'keepalive-exhausted', detail: 'pings:' + pingCount },
        {
          mode: previous.mode,
          chainId: chainOfPing,
          tokens: previous.contextTokens,
          model: previous.model,
          effort: previous.effort,
        }
      );
      state.remove(sessionId);
      return;
    }
  }

  if (!cfg.enabled) {
    state.remove(sessionId);
    return;
  }

  const info = transcriptPath ? transcript.lastAssistantInfo(transcriptPath) : null;
  const tokens = info ? info.tokens : null;

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
  const text = cfg.idleAction === 'keepalive' ? prompt.keepaliveCommand() : prompt.compactCommand(cwd, cfg);
  // A keepalive chain is one continuous idle stretch: it survives re-arming on
  // each confirmed ping, and ends whenever pingCount would reset. Grouping the
  // per-ping rows by this id at read time is what turns a chain into a single
  // savings event, without needing to catch every way a chain can end.
  const continuesChain =
    previous &&
    previous.mode === 'keepalive' &&
    previous.fired &&
    previous.fired.ok &&
    cfg.idleAction === 'keepalive';
  const chainId = continuesChain ? previous.chainId || previous.armId : armId;
  const record = {
    version: 1,
    armId,
    sessionId,
    cwd,
    transcriptPath: transcriptPath || null,
    contextTokens: tokens,
    model: info ? info.model : null,
    effort: info ? info.effort : null,
    chainId,
    armedAt,
    fireAt: armedAt + cfg.idleMinutes * 60 * 1000,
    idleMinutes: cfg.idleMinutes,
    cacheTtl: cfg.cacheTtl,
    allowBlindInjection: cfg.allowBlindInjection,
    mode: cfg.idleAction,
    pingCount: cfg.idleAction === 'keepalive' ? pingCount : 0,
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
