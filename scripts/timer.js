#!/usr/bin/env node
'use strict';

// Detached idle timer. Spawned by arm.js, outlives the hook that created it,
// and injects /compact into the session's own terminal once the idle window
// elapses.
//
// Polling rather than a single setTimeout is deliberate: a suspended laptop
// stops long timers, and we want the check to happen on wake instead of an
// hour later.

const state = require('./lib/state');
const transcript = require('./lib/transcript');
const inject = require('./lib/inject');
const stats = require('./lib/stats');

// Test seam: overriding the poll interval lets the suite exercise this
// file's own setInterval loop across two real ticks in one process, instead
// of faking a second tick by respawning a process under a reused armId —
// arm.js always mints a fresh armId and spawns exactly one daemon per arm,
// so that reused-armId shape never occurs outside a test.
const POLL_MS = Number(process.env.IDLE_COMPACTOR_POLL_MS) || 15 * 1000;
// transcript.turnState() is the activity signal now — this is only a race
// guard against a burst of closing writes or a line landing mid-read. It is
// NOT the idleness check and must never be tuned as one; widening it doesn't
// make busy-detection more accurate, it just delays every fire.
const SETTLE_MS = 60 * 1000;
// Deferring no longer exits, so this is the only thing that ever ends a
// defer loop that never goes quiet. armedAt is frozen at arm time and never
// advances on defer, which is what keeps this reachable.
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

const statePath = process.argv[2];
const armId = process.argv[3];
// Tracks whether this arm has already logged its one activity-detected row.
// Kept in process memory rather than on the record: current() re-reads
// statePath fresh every tick, so a flag stored on the record would be
// discarded along with the rest of the in-memory record if a write ever
// failed, undoing the one-row-per-arm guarantee. A module-level flag needs
// no write to survive, and process lifetime already equals arm lifetime — a
// new armId spawns a new timer and retires this one at the current() check.
let deferLogged = false;

function current() {
  const record = state.readPath(statePath);
  if (!record || record.armId !== armId) return null;
  return record;
}

function finish(record, outcome) {
  try {
    record.fired = Object.assign({ at: Date.now() }, outcome);
    state.writePath(statePath, record);
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

// Not finish(): the deadline arrived but the session is still busy, so this
// reschedules instead of ending the process. armedAt is left untouched — it
// is MAX_LIFETIME_MS's anchor, and advancing it here would make that check
// unreachable for as long as the session stays quiet-but-not-idle.
function defer(record, detail) {
  if (!deferLogged) {
    try {
      stats.record(
        record.sessionId,
        { ok: false, reason: 'activity-detected', detail },
        {
          mode: record.mode,
          chainId: record.chainId,
          tokens: record.contextTokens,
          model: record.model,
          effort: record.effort,
        }
      );
    } catch (_) {
      /* the fire log is a diagnostic, not a correctness requirement */
    }
    deferLogged = true;
  }
  record.fireAt = Date.now() + record.idleMinutes * 60 * 1000;
  // current() re-reads statePath, the literal file this process was launched
  // with, every tick — so the write must target that same path rather than a
  // sessionId-derived one, or it becomes invisible to the next tick and the
  // old deadline re-fires 15s later.
  try {
    state.writePath(statePath, record);
  } catch (_) {
    // A transient write failure must not throw out of tick() and kill the
    // daemon (setInterval has no caller to catch it). fireAt stays
    // unadvanced, so the next tick just re-evaluates and re-defers, and
    // deferLogged lives in process memory, so it survives the failed write
    // and still stops a duplicate stats row.
  }
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
    const turn = transcript.turnState(record.transcriptPath);
    if (turn.busy) return defer(record, turn.why);
    if (Date.now() - mtime < SETTLE_MS) return defer(record, 'settling');
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
