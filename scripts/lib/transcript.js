'use strict';

const fs = require('fs');

const TAIL_BYTES = 512 * 1024;

// Claude Code appends one JSON object per line. Only the tail matters: the
// most recent assistant message carries the usage block that describes how
// much context the next request would have to send.
function readTailLines(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
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

function mtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch (_) {
    return null;
  }
}

module.exports = { lastUsage, contextTokens, mtimeMs };
