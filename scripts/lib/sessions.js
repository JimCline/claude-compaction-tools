'use strict';

// A point-in-time inventory of the per-session state files under
// ~/.claude/idle-compactor/sessions/. Deliberately separate from stats.js: that
// aggregates the durable fires.log history, this answers "what is each session
// doing right now". The same sessionId appears in both views meaning different
// things.

const path = require('path');

const state = require('./state');

const LABELS = {
  'counting-down': 'counting down',
  due: 'due now',
  fired: 'fired',
  orphaned: 'orphaned',
};

const DETAILS = {
  ok: 'compacted',
  'activity-skipped': 'skipped, user active',
  failed: 'injection failed',
  'session-gone': 'claude process gone',
  'timer-gone': 'timer process gone',
};

// Ordering for the rendered list: whatever is about to happen first, then
// history, then wreckage.
const RANK = { due: 0, 'counting-down': 1, fired: 2, orphaned: 3 };

// "45s" / "41m 18s" / "2h 05m". Consolidates the ad-hoc "Xm Ys" already used in
// config-cli.js's armed-sessions block; callers decide whether a duration is
// remaining or elapsed, so negatives are clamped rather than signed.
function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return total + 's';
  if (total < 3600) {
    return Math.floor(total / 60) + 'm ' + String(total % 60).padStart(2, '0') + 's';
  }
  return (
    Math.floor(total / 3600) + 'h ' + String(Math.floor((total % 3600) / 60)).padStart(2, '0') + 'm'
  );
}

function classify(record, now) {
  // Terminal and factual: the fire already happened, whatever died afterwards.
  if (record.fired) {
    if (record.fired.ok) return { status: 'fired', detail: 'ok' };
    if (record.fired.reason === 'activity-detected') {
      return { status: 'fired', detail: 'activity-skipped' };
    }
    return { status: 'fired', detail: 'failed' };
  }
  // Guarded on the pid being recorded at all: isAlive(null) is false, and an
  // undiscoverable pid is unknown, not dead. Matches timer.js's own guard.
  // These linger until the SessionStart reaper takes them, so they are a state
  // the user will genuinely see rather than a transient.
  if (record.claudePid && !state.isAlive(record.claudePid)) {
    return { status: 'orphaned', detail: 'session-gone' };
  }
  if (record.timerPid && !state.isAlive(record.timerPid)) {
    return { status: 'orphaned', detail: 'timer-gone' };
  }
  // The deadline passed but the timer polls every 15s, so this is the real and
  // short-lived "about to fire" window rather than a countdown of zero.
  if (now >= record.fireAt) return { status: 'due', detail: null };
  return { status: 'counting-down', detail: null };
}

function describe(nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const sessions = [];

  for (const file of state.listSessions()) {
    const record = state.readPath(file);
    // Unreadable or half-written: nothing truthful to say about it.
    if (!record) continue;
    const c = classify(record, now);
    const id = record.sessionId || path.basename(file, '.json');
    sessions.push({
      sessionId: id,
      shortId: String(id).slice(0, 8),
      status: c.status,
      detail: c.detail,
      cwd: record.cwd || null,
      armedAt: record.armedAt || null,
      fireAt: record.fireAt || null,
      idleMinutes: record.idleMinutes == null ? null : record.idleMinutes,
      contextTokens: record.contextTokens == null ? null : record.contextTokens,
      dueInMs: c.status === 'counting-down' ? record.fireAt - now : null,
      firedAt: (record.fired && record.fired.at) || null,
      fired: record.fired || null,
      claudePid: record.claudePid || null,
      claudeAlive: state.isAlive(record.claudePid),
      timerPid: record.timerPid || null,
      timerAlive: state.isAlive(record.timerPid),
      file,
    });
  }

  sessions.sort((a, b) => {
    const byRank = RANK[a.status] - RANK[b.status];
    if (byRank) return byRank;
    if (a.status === 'counting-down') return a.dueInMs - b.dueInMs;
    if (a.status === 'fired') return (b.firedAt || 0) - (a.firedAt || 0);
    return (b.armedAt || 0) - (a.armedAt || 0);
  });

  const counts = { countingDown: 0, due: 0, fired: 0, orphaned: 0 };
  for (const s of sessions) {
    if (s.status === 'counting-down') counts.countingDown++;
    else if (s.status === 'due') counts.due++;
    else if (s.status === 'fired') counts.fired++;
    else counts.orphaned++;
  }

  return { now, sessions, counts };
}

function timing(s, now) {
  if (s.status === 'counting-down') return 'fires in ' + formatDuration(s.dueInMs);
  if (s.status === 'due') return 'firing now';
  if (s.status === 'fired') {
    const label = DETAILS[s.detail] || s.detail || 'fired';
    return s.firedAt ? label + ' ' + formatDuration(now - s.firedAt) + ' ago' : label;
  }
  return DETAILS[s.detail] || s.detail || 'unknown';
}

function render(view) {
  if (!view.sessions.length) return 'no live sessions';
  const lines = [
    'live sessions: ' +
      view.sessions.length +
      '  (' +
      view.counts.countingDown +
      ' counting down, ' +
      view.counts.due +
      ' due, ' +
      view.counts.fired +
      ' fired, ' +
      view.counts.orphaned +
      ' orphaned)',
    '',
  ];
  for (const s of view.sessions) {
    lines.push(
      '  ' +
        s.shortId +
        '  ' +
        LABELS[s.status].padEnd(13) +
        '  ' +
        timing(s, view.now).padEnd(24) +
        '  ' +
        (s.cwd ? path.basename(s.cwd) : '-')
    );
  }
  return lines.join('\n');
}

module.exports = { describe, render, formatDuration };
