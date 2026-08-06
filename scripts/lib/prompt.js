'use strict';

const fs = require('fs');

const config = require('./config');
const repo = require('./repo');

// The prompt is typed into a terminal as the tail of a single `/compact ...`
// line. An embedded newline would submit the command early and leave the rest
// of the text sitting in the prompt as a stray message, so everything is
// flattened to one line before it is ever injected.
const MAX_CHARS = 800;

function flatten(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

// A repo-scoped prompt wins over the user-level one; the user-level one is the
// fallback for every repo that has not set its own.
function resolveFor(cwd, cfg) {
  cfg = cfg || config.resolve();
  const prompts = cfg.prompts || {};
  const scoped = prompts[repo.key(cwd)] || null;
  const file = scoped || cfg.promptPath || null;

  if (!file) return { path: null, scope: null, text: '', missing: false, truncated: false };

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return {
      path: file,
      scope: scoped ? 'repo' : 'user',
      text: '',
      missing: true,
      truncated: false,
    };
  }

  const flat = flatten(raw);
  return {
    path: file,
    scope: scoped ? 'repo' : 'user',
    text: flat.slice(0, MAX_CHARS),
    missing: false,
    truncated: flat.length > MAX_CHARS,
  };
}

function compactCommand(cwd, cfg) {
  const resolved = resolveFor(cwd, cfg);
  return resolved.text ? '/compact ' + resolved.text : '/compact';
}

function describe(cwd, cfg) {
  const resolved = resolveFor(cwd, cfg);
  if (!resolved.path) return 'compaction prompt: none';
  if (resolved.missing) return 'compaction prompt: FILE MISSING — ' + resolved.path;
  const suffix = resolved.truncated ? ' (truncated to ' + MAX_CHARS + ' chars)' : '';
  return (
    'compaction prompt: ' + resolved.scope + ' — ' + resolved.path + suffix
  );
}

module.exports = { MAX_CHARS, flatten, resolveFor, compactCommand, describe };
