'use strict';

const fs = require('fs');
const path = require('path');

const config = require('./config');
const repo = require('./repo');
const summary = require('./summary');
const transcripts = require('./transcripts');

// PostCompact fires when compaction completes, but the summary entry it
// produced is written by a separate code path — so poll briefly rather than
// read once and miss it.
const WAIT_MS = 5000;
const POLL_MS = 150;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Both branches are fallbacks — the hook payload normally carries
// transcript_path outright. Claude Code files transcripts under a slug of the
// working directory, which holds only for a session that started here, so a
// derived path that does not exist falls through to finding the session's
// file by id.
function transcriptPathFor(input) {
  if (input && input.transcript_path) return input.transcript_path;
  if (!input || !input.session_id) return null;
  const derived = transcripts.derivedPath(input.cwd || process.cwd(), input.session_id);
  if (fs.existsSync(derived)) return derived;
  return transcripts.bySessionId(input.session_id);
}

function stamp(date) {
  const d = date || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function frontMatter(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined || value === '') continue;
    const str = String(value);
    lines.push(key + ': ' + (/[:#]|^\s|\s$/.test(str) ? JSON.stringify(str) : str));
  }
  lines.push('---');
  return lines.join('\n');
}

function render(found, input, cwd) {
  const meta = found.metadata || {};
  return (
    frontMatter({
      captured_at: new Date().toISOString(),
      compacted_at: found.timestamp,
      session: found.sessionId || (input && input.session_id) || null,
      repo: repo.name(cwd),
      repo_path: repo.key(cwd),
      cwd: found.cwd || cwd,
      branch: found.gitBranch,
      trigger: (input && input.trigger) || meta.trigger || null,
      pre_tokens: meta.preTokens,
      post_tokens: meta.postTokens,
      dropped_tokens: meta.cumulativeDroppedTokens,
      claude_code_version: found.version,
      summary_uuid: found.uuid,
      source: found.source || 'transcript',
      chars: found.chars,
    }) +
    '\n\n' +
    found.text.trim() +
    '\n'
  );
}

function uniquePath(dir, base) {
  let candidate = path.join(dir, base + '.md');
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, base + '-' + n + '.md');
    n++;
  }
  return candidate;
}

// Everything the transcript entry cannot supply when the entry is all we have
// is the payload's, and vice versa — this is the payload-only shape.
function fromPayload(input, text) {
  return {
    uuid: (input && input.prompt_id) || null,
    parentUuid: null,
    timestamp: new Date().toISOString(),
    cwd: (input && input.cwd) || null,
    gitBranch: null,
    version: null,
    sessionId: (input && input.session_id) || null,
    metadata: null,
    chars: text.length,
    text,
  };
}

// Returns a result object rather than throwing: this runs as a hook, where the
// only acceptable failure mode is doing nothing quietly.
async function run(input, options) {
  const opts = options || {};
  const cwd = (input && input.cwd) || process.cwd();
  const settings = opts.settings || config.forRepo(cwd);

  if (!opts.force) {
    if (!settings || !settings.enabled) return { ok: false, skipped: 'not-enabled' };
    if (!settings.location) return { ok: false, skipped: 'no-location' };
  }
  const location = opts.location || (settings && settings.location);
  if (!location) return { ok: false, skipped: 'no-location' };

  // PostCompact hands the summary over in the payload, and that copy is the
  // fuller one: the transcript entry keeps only the <summary> section, while
  // this carries the model's <analysis> reasoning with it. The transcript is
  // still read, for the provenance and the uuid the payload has no field for.
  const payloadText =
    input && typeof input.compact_summary === 'string' && input.compact_summary.trim()
      ? input.compact_summary
      : null;

  const transcriptPath = opts.transcriptPath || transcriptPathFor(input);
  if (!transcriptPath && !payloadText) return { ok: false, skipped: 'no-transcript-path' };

  const sessionId = (input && input.session_id) || 'unknown';
  const state = config.readState(sessionId);

  const deadline = Date.now() + (opts.waitMs === undefined ? WAIT_MS : opts.waitMs);
  let found = null;
  let landed = false;
  while (transcriptPath) {
    found = summary.lastSummary(transcriptPath);
    // A uuid match means this is the compaction we already wrote, not a new
    // one — keeps a re-fired hook from producing duplicate files. A forced
    // capture is someone asking for the file on purpose, so it writes anyway.
    const isNew = found && (opts.force || !found.uuid || found.uuid !== state.lastUuid);
    if (found && isNew) {
      landed = true;
      break;
    }
    // No point waiting out the poll for an entry that is already captured.
    if (found || Date.now() >= deadline) break;
    await wait(POLL_MS);
  }

  if (!landed) {
    // An entry that exists but is already captured stays captured; only a
    // missing one falls through to the payload.
    if (found && !opts.force) return { ok: false, skipped: 'already-captured', transcriptPath };
    if (!payloadText) return { ok: false, skipped: 'no-summary-found', transcriptPath };
    found = fromPayload(input, payloadText);
    if (found.uuid && found.uuid === state.lastUuid && !opts.force) {
      return { ok: false, skipped: 'already-captured', transcriptPath };
    }
  }

  if (payloadText) {
    found.source = 'payload';
    found.text = payloadText;
    found.chars = payloadText.length;
  }

  let file;
  try {
    fs.mkdirSync(location, { recursive: true });
    const trigger = (input && input.trigger) || (found.metadata && found.metadata.trigger) || null;
    const base = stamp(found.timestamp ? new Date(found.timestamp) : null) + (trigger ? '-' + trigger : '');
    file = uniquePath(location, base);
    fs.writeFileSync(file, render(found, input, cwd));
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err), location };
  }

  config.writeState(sessionId, {
    lastUuid: found.uuid || null,
    lastFile: file,
    lastAt: new Date().toISOString(),
    transcriptPath,
  });

  return { ok: true, file, chars: found.chars, location, transcriptPath, source: found.source || 'transcript' };
}

module.exports = { run, transcriptPathFor, render, stamp, WAIT_MS };
