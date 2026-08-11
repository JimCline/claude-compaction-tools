'use strict';

// Durable record of every idle-compaction fire, independent of the
// per-session state file (which arm.js overwrites on every turn, so it can
// only ever show the last fire, not a count). Appended to, never
// read-modify-written, because multiple session timers can fire around the
// same moment and fs.appendFileSync's O_APPEND write is atomic where a
// read-then-write of a shared counter file would race.

const fs = require('fs');
const path = require('path');

const config = require('./config');

const LOG_PATH = path.join(config.ROOT, 'fires.log');
const PING_LOG_PATH = path.join(config.ROOT, 'pings.log');

function record(sessionId, fired) {
  config.ensureRoot();
  const line = JSON.stringify({
    at: (fired && fired.at) || Date.now(),
    sessionId,
    ok: !!(fired && fired.ok),
    reason: (fired && fired.reason) || null,
    detail: (fired && fired.detail) || null,
  });
  fs.appendFileSync(LOG_PATH, line + '\n');
}

function readAll() {
  let text;
  try {
    text = fs.readFileSync(LOG_PATH, 'utf8');
  } catch (_) {
    return [];
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (_) {
      /* one corrupt line (e.g. a torn write) shouldn't lose the rest of the log */
    }
  }
  return events;
}

function summarize() {
  const events = readAll();
  const sessions = {};
  let ok = 0;
  let activitySkipped = 0;
  let failed = 0;

  for (const e of events) {
    const s = (sessions[e.sessionId] = sessions[e.sessionId] || {
      attempts: 0,
      ok: 0,
      skipped: 0,
      failed: 0,
      lastAt: 0,
    });
    s.attempts++;
    s.lastAt = Math.max(s.lastAt, e.at || 0);
    if (e.ok) {
      s.ok++;
      ok++;
    } else if (e.reason === 'activity-detected') {
      s.skipped++;
      activitySkipped++;
    } else {
      s.failed++;
      failed++;
    }
  }

  return { totalAttempts: events.length, ok, activitySkipped, failed, sessions };
}

function reset() {
  try {
    fs.unlinkSync(LOG_PATH);
    return true;
  } catch (_) {
    return false;
  }
}

// A keepalive ping is confirmed once Claude's reply lands, so classification
// reads that reply's own usage block — cache_read_input_tokens dominant means
// the ping refreshed a still-warm cache (hit); cache_creation_input_tokens
// dominant means the cache had already expired and this ping paid a full
// re-write instead (miss). Mirrors the fields transcript.contextTokens()
// already relies on, rather than the nested per-TTL cache_creation breakdown.
function classifyPingUsage(usage) {
  if (!usage) return null;
  const read = usage.cache_read_input_tokens || 0;
  const created = usage.cache_creation_input_tokens || 0;
  if (read === 0 && created === 0) return null;
  return created > read ? 'miss' : 'hit';
}

function recordPing(sessionId, result) {
  config.ensureRoot();
  const line = JSON.stringify({ at: Date.now(), sessionId, result });
  fs.appendFileSync(PING_LOG_PATH, line + '\n');
}

function readPings() {
  let text;
  try {
    text = fs.readFileSync(PING_LOG_PATH, 'utf8');
  } catch (_) {
    return [];
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (_) {
      /* one corrupt line (e.g. a torn write) shouldn't lose the rest of the log */
    }
  }
  return events;
}

function summarizePings() {
  const events = readPings();
  let hits = 0;
  let misses = 0;
  for (const e of events) {
    if (e.result === 'hit') hits++;
    else if (e.result === 'miss') misses++;
  }
  const total = hits + misses;
  return { total, hits, misses, missRate: total ? misses / total : 0 };
}

function resetPings() {
  try {
    fs.unlinkSync(PING_LOG_PATH);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  LOG_PATH,
  PING_LOG_PATH,
  record,
  readAll,
  summarize,
  reset,
  classifyPingUsage,
  recordPing,
  readPings,
  summarizePings,
  resetPings,
};
