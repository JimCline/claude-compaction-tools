'use strict';

const fs = require('fs');

function textOf(entry) {
  const content = entry && entry.message && entry.message.content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('');
  }
  return typeof content === 'string' ? content : '';
}

// Transcripts are append-only — compaction adds an entry and the conversation
// continues in the same file — so the compaction that just happened is the
// last isCompactSummary entry present.
//
// The cheap substring test before JSON.parse matters: these files reach
// multiple megabytes and only a handful of lines are ever candidates.
function lastSummary(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }

  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('isCompactSummary') === -1) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (!entry || !entry.isCompactSummary) continue;

    const text = textOf(entry);
    if (!text) continue;

    return {
      uuid: entry.uuid || null,
      parentUuid: entry.parentUuid || null,
      timestamp: entry.timestamp || null,
      cwd: entry.cwd || null,
      gitBranch: entry.gitBranch || null,
      version: entry.version || null,
      sessionId: entry.sessionId || entry.session_id || null,
      // Present on some Claude Code versions only; carries trigger and the
      // pre/post token counts when it is there.
      metadata: entry.compactMetadata || null,
      chars: text.length,
      text,
    };
  }

  return null;
}

module.exports = { lastSummary, textOf };
