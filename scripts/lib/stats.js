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

function record(sessionId, fired, meta) {
  config.ensureRoot();
  const base = {
    at: (fired && fired.at) || Date.now(),
    sessionId,
    ok: !!(fired && fired.ok),
    reason: (fired && fired.reason) || null,
    detail: (fired && fired.detail) || null,
  };
  const line = JSON.stringify(
    meta
      ? Object.assign({}, base, {
          mode: meta.mode != null ? meta.mode : null,
          chainId: meta.chainId != null ? meta.chainId : null,
          tokens: meta.tokens != null ? meta.tokens : null,
          model: meta.model != null ? meta.model : null,
          effort: meta.effort != null ? meta.effort : null,
          basis: 'estimated',
        })
      : base
  );
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

function recordPing(sessionId, result, meta) {
  config.ensureRoot();
  const base = { at: Date.now(), sessionId, result };
  let line;
  if (meta) {
    const usage = meta.usage;
    const cacheReadTokens =
      usage && typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : null;
    const cacheCreationTokens =
      usage && typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : null;
    let tokens;
    let basis;
    if (result === 'miss') {
      tokens = 0;
      basis = 'measured';
    } else if (cacheReadTokens) {
      tokens = cacheReadTokens;
      basis = 'measured';
    } else {
      tokens = meta.previousContextTokens != null ? meta.previousContextTokens : null;
      basis = 'estimated';
    }
    line = JSON.stringify(
      Object.assign({}, base, {
        chainId: meta.chainId != null ? meta.chainId : null,
        tokens,
        cacheReadTokens,
        cacheCreationTokens,
        model: meta.model != null ? meta.model : null,
        effort: meta.effort != null ? meta.effort : null,
        basis,
      })
    );
  } else {
    line = JSON.stringify(base);
  }
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

// Read-time chain grouping (see docs/specs/token-savings-tracking.md §6.4).
// Token savings are not additive across keepalive pings — a chain of N pings
// against the same context protects that context once, not N times — so the
// group's value is the MAX single row, never a sum. A compact fire's chainId
// always equals its own armId, so it is a chain of exactly one and the same
// grouping code handles both modes uniformly.
//
// A fires.log row is eligible to value a chain only when it is a genuine
// compact fire (ok, not a keepalive-exhaustion terminator, mode 'compact' —
// or no mode at all, which is a pre-upgrade row and is charitably treated as
// its own one-row event rather than silently dropped). A successful
// keepalive-mode fires.log row records only that a ping was *sent*; the
// measured savings figure for that ping is the *confirming* reply, which
// lands in pings.log via recordPing(), so keepalive fires.log rows are never
// eligible themselves — counting both would double the ping count a chain
// reports.
function normalizedRows() {
  const rows = [];
  for (const f of readAll()) {
    let kind;
    let counts;
    if (f.ok === true && f.reason === 'keepalive-exhausted') {
      kind = 'exhausted';
      counts = false;
    } else if (f.ok === true && f.mode === 'keepalive') {
      kind = 'keepalive-fire';
      counts = false;
    } else if (f.ok === true) {
      kind = 'compact';
      counts = true;
    } else if (f.reason === 'activity-detected') {
      kind = 'skipped';
      counts = false;
    } else {
      kind = 'failed';
      counts = false;
    }
    rows.push({
      at: f.at || 0,
      sessionId: f.sessionId,
      chainId: f.chainId != null ? f.chainId : null,
      kind,
      tokens: typeof f.tokens === 'number' ? f.tokens : null,
      model: f.model != null ? f.model : null,
      effort: f.effort != null ? f.effort : null,
      basis: f.basis != null ? f.basis : null,
      counts,
      source: 'fires',
    });
  }
  for (const p of readPings()) {
    rows.push({
      at: p.at || 0,
      sessionId: p.sessionId,
      chainId: p.chainId != null ? p.chainId : null,
      kind: p.result === 'hit' ? 'ping-hit' : 'ping-miss',
      tokens: typeof p.tokens === 'number' ? p.tokens : p.result === 'miss' ? 0 : null,
      model: p.model != null ? p.model : null,
      effort: p.effort != null ? p.effort : null,
      basis: p.basis != null ? p.basis : null,
      counts: p.result === 'hit',
      source: 'pings',
    });
  }
  return rows;
}

// Groups the rows that can ever belong to a chain — eligible compact fires
// plus every ping row (hit and miss both, so an all-miss chain still forms a
// group whose max is correctly 0) — and takes each group's max. Rows lacking
// a chainId (pre-upgrade) key on sessionId + at instead, so old data degrades
// to one event per row rather than merging unrelated rows together.
function groupChains() {
  const rows = normalizedRows().filter(
    (r) => r.source === 'pings' || (r.source === 'fires' && r.counts)
  );
  const groups = new Map();
  for (const row of rows) {
    const key = row.sessionId + ':' + (row.chainId != null ? row.chainId : 'at' + row.at);
    let g = groups.get(key);
    if (!g) {
      g = {
        chainKey: key,
        sessionId: row.sessionId,
        kind: row.source === 'fires' ? 'compact' : 'keepalive-chain',
        tokens: null,
        pings: 0,
        firstAt: row.at,
        lastAt: row.at,
        model: null,
        effort: null,
        basis: null,
      };
      groups.set(key, g);
    }
    g.pings++;
    g.firstAt = Math.min(g.firstAt, row.at);
    g.lastAt = Math.max(g.lastAt, row.at);
    if (typeof row.tokens === 'number' && (g.tokens === null || row.tokens > g.tokens)) {
      g.tokens = row.tokens;
      g.model = row.model;
      g.effort = row.effort;
      g.basis = row.basis;
    }
  }
  return [...groups.values()];
}

// Chain-level savings events, oldest first. Empty chains (every ping missed —
// tokens === 0, protected nothing) are excluded: they are not a savings
// event, and are reported separately via summarizeSavings().emptyChains.
function readSavings() {
  return groupChains()
    .filter((g) => g.tokens !== 0)
    .sort((a, b) => a.firstAt - b.firstAt);
}

function summarizeSavings() {
  const result = {
    events: 0,
    compactions: 0,
    keepaliveChains: 0,
    emptyChains: 0,
    pingHits: 0,
    pingMisses: 0,
    tokensProtected: 0,
    tokensEstimated: 0,
    tokensRewritten: 0,
    eventsMissingTokens: 0,
    byModel: {},
  };

  for (const p of readPings()) {
    if (p.result === 'hit') result.pingHits++;
    else if (p.result === 'miss') {
      result.pingMisses++;
      result.tokensRewritten += typeof p.cacheCreationTokens === 'number' ? p.cacheCreationTokens : 0;
    }
  }

  for (const g of groupChains()) {
    if (g.tokens === null) {
      result.eventsMissingTokens++;
      continue;
    }
    if (g.tokens === 0) {
      result.emptyChains++;
      continue;
    }
    result.events++;
    result.tokensProtected += g.tokens;
    if (g.basis === 'estimated') result.tokensEstimated += g.tokens;
    if (g.kind === 'compact') result.compactions++;
    else result.keepaliveChains++;

    const modelKey = g.model || '(unknown)';
    const m = (result.byModel[modelKey] = result.byModel[modelKey] || {
      events: 0,
      tokens: 0,
      compactions: 0,
      keepaliveChains: 0,
    });
    m.events++;
    m.tokens += g.tokens;
    if (g.kind === 'compact') m.compactions++;
    else m.keepaliveChains++;
  }

  return result;
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
  readSavings,
  summarizeSavings,
};
