'use strict';

const fs = require('fs');

const TAIL_BYTES = 512 * 1024;

// Claude Code appends one JSON object per line. Only the tail matters: the
// most recent assistant message carries the usage block that describes how
// much context the next request would have to send.
function readTailLines(file, maxBytes) {
  const window = maxBytes || TAIL_BYTES;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - window);
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const lines = buf.toString('utf8').split('\n');
    // A non-zero start almost certainly sliced the first line in half.
    if (start > 0) lines.shift();
    return lines;
  } catch (_) {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* ignore */
      }
    }
  }
}

// The newest non-sidechain entry carrying a usage block, plus the identity of
// the request that produced it. Sidechain entries are subagent traffic written
// into the same file; taking their usage would report a subagent's context and
// a subagent's model as if they were the session's own.
function lastAssistantInfo(file) {
  const lines = readTailLines(file);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line[0] !== '{') continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (entry && entry.isSidechain === true) continue;
    const usage = entry && entry.message && entry.message.usage;
    if (!usage || typeof usage !== 'object') continue;
    return {
      usage,
      model: entry.message.model || null,
      // Absent on transcripts written by older Claude Code builds, and not
      // backfillable; every consumer must tolerate null.
      effort: entry.effort || null,
      tokens:
        (usage.input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0) +
        (usage.cache_read_input_tokens || 0),
    };
  }
  return null;
}

function lastUsage(file) {
  const info = lastAssistantInfo(file);
  return info ? info.usage : null;
}

// The full prompt size for the next request, per the Anthropic usage contract:
// input_tokens + cache_creation_input_tokens + cache_read_input_tokens.
function contextTokens(file) {
  const info = lastAssistantInfo(file);
  return info ? info.tokens : null;
}

function mtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch (_) {
    return null;
  }
}

// Elapsed silence can't tell "finished" from "still working" — a build, a
// test suite, or a subagent can leave the transcript quiet for over an hour
// while the turn is very much open. Turn completeness can: a tool_use still
// unanswered means the turn is open.
function turnState(file) {
  const lines = readTailLines(file);
  const entries = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    try {
      entries.push(JSON.parse(line));
    } catch (_) {
      continue;
    }
  }

  // isSidechain is ignored here on purpose: an unanswered tool_use anywhere
  // in the tail means something is still running, subagent or not, and
  // treating that as idle is the failure mode this function exists to avoid.
  // Scanning the whole tail for any unmatched use relies on Claude Code
  // always writing a tool_result, even for an interrupted or cancelled call —
  // an unmatched use means in-flight, never an abandoned orphan.
  const used = new Set();
  const resulted = new Set();
  for (const entry of entries) {
    const content = entry && entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use' && block.id) used.add(block.id);
      if (block.type === 'tool_result' && block.tool_use_id) resulted.add(block.tool_use_id);
    }
  }
  for (const id of used) {
    if (!resulted.has(id)) return { busy: true, why: 'pending-tool' };
  }

  // No "awaiting a genuine reply" branch: arm.js re-arms on every user prompt
  // with a fresh armedAt and fireAt a full idle window out, so any user-role
  // entry this function could still see is already older than the whole idle
  // window — never someone waiting on a response. It also can't be told apart
  // from synthetic user-role bookkeeping (compaction receipts, slash-command
  // echoes, interrupt markers) that trails idle sessions constantly; treating
  // any of that as a pending reply is what deferred a session forever after
  // its first compaction.
  return { busy: false };
}

module.exports = { lastAssistantInfo, lastUsage, contextTokens, mtimeMs, turnState };
