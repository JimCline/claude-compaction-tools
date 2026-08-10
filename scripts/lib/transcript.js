'use strict';

const fs = require('fs');

const TAIL_BYTES = 512 * 1024;
// A user turn can sit far behind the tail that carries the usage block: one
// tool-heavy turn easily exceeds TAIL_BYTES on its own.
const USER_SCAN_BYTES = 4 * 1024 * 1024;

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

function lastUsage(file) {
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
    const usage = entry && entry.message && entry.message.usage;
    if (usage && typeof usage === 'object') return usage;
  }
  return null;
}

// The full prompt size for the next request, per the Anthropic usage contract:
// input_tokens + cache_creation_input_tokens + cache_read_input_tokens.
function contextTokens(file) {
  const u = lastUsage(file);
  if (!u) return null;
  return (
    (u.input_tokens || 0) +
    (u.cache_creation_input_tokens || 0) +
    (u.cache_read_input_tokens || 0)
  );
}

// Claude Code writes several kinds of entry under type "user" that the human
// never typed: tool results from an in-flight or background task, meta entries
// injected by hooks and commands, and subagent sidechain traffic. Measured on a
// real transcript, 74 of 120 "user" lines were tool results alone.
function isUserTurn(entry) {
  if (!entry || entry.type !== 'user') return false;
  if (entry.isMeta === true) return false;
  if (entry.isSidechain === true) return false;
  if (entry.toolUseResult !== undefined) return false;
  const message = entry.message;
  if (!message || message.role !== 'user') return false;
  const content = message.content;
  if (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((block) => block && block.type === 'tool_result')
  ) {
    return false;
  }
  return true;
}

// Epoch ms of the most recent genuine user turn in the transcript, or null when
// that cannot be established. Callers must treat null as "assume the user is
// active": the file's mtime moves for Claude Code's own bookkeeping (system
// away_summary recaps, stop_hook_summary, turn_duration), so mtime alone cannot
// answer whether the human came back.
function lastUserTurnMs(file) {
  const lines = readTailLines(file, USER_SCAN_BYTES);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line[0] !== '{') continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (!isUserTurn(entry)) continue;
    const at = Date.parse(entry.timestamp);
    // Stop at the newest user turn either way. Scanning further back would
    // report a stale "last active hours ago" and fire into a live session.
    return Number.isFinite(at) ? at : null;
  }
  return null;
}

function mtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch (_) {
    return null;
  }
}

module.exports = { lastUsage, contextTokens, lastUserTurnMs, mtimeMs };
