'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const repo = require('./repo');
const summary = require('./summary');

// Bounds the repo-matching scan. Reading a transcript costs a whole
// readFileSync and they run to megabytes; the session doing the asking is
// being appended to as it asks, so it sorts first and the scan almost always
// stops on its first candidate.
const SCAN_LIMIT = 12;

// Resolved per call rather than at load: the test suite runs the CLI under a
// sandboxed HOME.
function projectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

function slugFor(cwd) {
  return String(cwd).replace(/\//g, '-');
}

function derivedPath(cwd, sessionId) {
  return path.join(projectsRoot(), slugFor(cwd), sessionId + '.jsonl');
}

function projectDirs() {
  let names;
  try {
    names = fs.readdirSync(projectsRoot());
  } catch (_) {
    return [];
  }
  return names.map((name) => path.join(projectsRoot(), name));
}

function transcriptsIn(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  const found = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    try {
      found.push({ file, mtime: fs.statSync(file).mtimeMs });
    } catch (_) {
      /* vanished between readdir and stat */
    }
  }
  return found;
}

function newestFirst(entries) {
  return entries.sort((a, b) => b.mtime - a.mtime).map((e) => e.file);
}

// A session id is unique across every project directory, so finding its file
// by name is exact — unlike deriving the directory, which only holds when the
// session started in the directory now asking.
function bySessionId(sessionId) {
  if (!sessionId) return null;
  const base = String(sessionId) + '.jsonl';
  for (const dir of projectDirs()) {
    const file = path.join(dir, base);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// The newest transcript belonging to this repo that actually holds a
// compaction summary, as { file, sessionId }.
//
// Claude Code files a transcript under a slug of the directory the session
// STARTED in, and a bare CLI invocation knows neither that directory nor the
// session id. Renaming a directory strands every earlier session under the
// old slug, so the slug alone is not enough even for the current repo. What
// does survive a rename is the cwd each summary entry records — match on that.
function newestSummaryFor(cwd) {
  const key = repo.key(cwd);
  const preferred = newestFirst(transcriptsIn(path.join(projectsRoot(), slugFor(repo.canonical(cwd)))));

  const seen = new Set(preferred);
  const elsewhere = [];
  for (const dir of projectDirs()) elsewhere.push(...transcriptsIn(dir));
  const ordered = preferred.concat(newestFirst(elsewhere).filter((file) => !seen.has(file)));

  for (const file of ordered.slice(0, SCAN_LIMIT)) {
    const found = summary.lastSummary(file);
    if (!found || !found.cwd) continue;
    if (repo.key(found.cwd) !== key) continue;
    return { file, sessionId: found.sessionId || null };
  }
  return null;
}

module.exports = { bySessionId, newestSummaryFor, derivedPath, slugFor, projectsRoot, SCAN_LIMIT };
