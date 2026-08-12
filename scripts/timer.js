#!/usr/bin/env node
'use strict';

// Detached idle timer. Spawned by arm.js, outlives the hook that created it,
// and injects /compact into the session's own terminal once the idle window
// elapses.
//
// Polling rather than a single setTimeout is deliberate: a suspended laptop
// stops long timers, and we want the check to happen on wake instead of an
// hour later.

const fs = require('fs');

const state = require('./lib/state');
const transcript = require('./lib/transcript');
const inject = require('./lib/inject');
const stats = require('./lib/stats');

const POLL_MS = 15 * 1000;
// Claude Code writes the closing assistant message around the time the Stop
// hook runs, so transcript writes just after arming are expected. Anything
// later than this means real activity that disarm.js somehow missed.
const ACTIVITY_GRACE_MS = 60 * 1000;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

const statePath = process.argv[2];
const armId = process.argv[3];

function current() {
  const record = state.readPath(statePath);
  if (!record || record.armId !== armId) return null;
  return record;
}

function finish(record, outcome) {
  try {
    record.fired = Object.assign({ at: Date.now() }, outcome);
    fs.writeFileSync(statePath, JSON.stringify(record, null, 2) + '\n');
  } catch (_) {
    /* the state file is a diagnostic, not a correctness requirement */
  }
  try {
    stats.record(record.sessionId, record.fired, {
      mode: record.mode,
      chainId: record.chainId,
      tokens: record.contextTokens,
      model: record.model,
      effort: record.effort,
    });
  } catch (_) {
    /* the fire log is a diagnostic, not a correctness requirement */
  }
  process.exit(0);
}

function tick() {
  const record = current();
  // State gone or superseded: disarmed, or a newer turn armed its own timer.
  if (!record) process.exit(0);

  if (Date.now() - record.armedAt > MAX_LIFETIME_MS) process.exit(0);

  // The session itself is gone; there is nothing left to type into.
  if (record.claudePid && !state.isAlive(record.claudePid)) {
    state.remove(record.sessionId);
    process.exit(0);
  }

  if (Date.now() < record.fireAt) return;

  if (record.transcriptPath) {
    const mtime = transcript.mtimeMs(record.transcriptPath);
    if (mtime === null) {
      state.remove(record.sessionId);
      process.exit(0);
    }
    if (mtime > record.armedAt + ACTIVITY_GRACE_MS) {
      // The file moved, but Claude Code writes its own entries into an idle
      // session's transcript (away_summary recaps, stop_hook_summary,
      // turn_duration), so an mtime bump is not evidence the user came back.
      // Only a genuine user turn is. A null reading means we could not tell,
      // and not firing is the cheaper mistake.
      const lastUser = transcript.lastUserTurnMs(record.transcriptPath);
      if (lastUser === null) {
        return finish(record, {
          ok: false,
          reason: 'activity-detected',
          detail: 'indeterminate',
        });
      }
      if (lastUser > record.armedAt + ACTIVITY_GRACE_MS) {
        return finish(record, {
          ok: false,
          reason: 'activity-detected',
          detail: 'user-turn',
        });
      }
    }
  }

  const result = inject.inject({
    env: record.env,
    tty: record.tty,
    terminalPid: record.claudePid || process.ppid,
    text: record.text || '/compact',
    allowBlind: !!record.allowBlindInjection,
  });

  finish(record, result);
}

if (!statePath || !armId) process.exit(0);

tick();
setInterval(tick, POLL_MS);
