'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const repo = require('./repo');

const ROOT = path.join(os.homedir(), '.claude', 'compaction-capture');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_DIR = path.join(ROOT, 'state');

// Where captures go when the user picks the shared location rather than a
// folder inside their repo.
const CENTRAL_ROOT = path.join(os.homedir(), '.claude', 'compaction-captures');

const DEFAULTS = { version: 1, repos: {} };

function ensureRoot() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  return ROOT;
}

function read() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function all() {
  const cfg = Object.assign({}, DEFAULTS, read());
  cfg.repos = Object.assign({}, cfg.repos);
  return cfg;
}

function write(next) {
  ensureRoot();
  const tmp = CONFIG_PATH + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);
  return next;
}

// Recorded so the slash command can still find the plugin when
// ${CLAUDE_PLUGIN_ROOT} arrives unsubstituted, and so it runs under the same
// Node the hooks use rather than whatever `node` resolves to.
function setPaths(pluginRoot, nodePath) {
  const cfg = all();
  if (cfg.pluginRoot === pluginRoot && cfg.nodePath === nodePath) return cfg;
  cfg.pluginRoot = pluginRoot;
  cfg.nodePath = nodePath;
  return write(cfg);
}

function forRepo(cwd) {
  return all().repos[repo.key(cwd)] || null;
}

function setRepo(cwd, patch) {
  const cfg = all();
  const key = repo.key(cwd);
  cfg.repos[key] = Object.assign({ location: null, mode: null, enabled: false }, cfg.repos[key], patch);
  write(cfg);
  return cfg.repos[key];
}

// The three offers the slash command presents. A repo-local folder needs no
// per-repo subdirectory — the repo is already the scope — while the shared one
// does, or every project's captures would land in the same heap.
function presets(cwd) {
  const key = repo.key(cwd);
  return {
    repo: {
      mode: 'repo',
      location: path.join(key, '.claude', 'compaction-captures'),
      label: 'inside this repo',
    },
    central: {
      mode: 'central',
      location: path.join(CENTRAL_ROOT, repo.name(cwd)),
      label: 'shared folder, filed by repo name',
    },
  };
}

// Written per session rather than into the config file so that a burst of
// compactions never rewrites the user's settings.
function statePath(sessionId) {
  return path.join(STATE_DIR, String(sessionId || 'unknown').replace(/[^\w.-]/g, '_') + '.json');
}

function readState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(statePath(sessionId), 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeState(sessionId, next) {
  ensureRoot();
  const file = statePath(sessionId);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return next;
}

module.exports = {
  ROOT,
  CONFIG_PATH,
  STATE_DIR,
  CENTRAL_ROOT,
  DEFAULTS,
  ensureRoot,
  read,
  all,
  write,
  setPaths,
  forRepo,
  setRepo,
  presets,
  statePath,
  readState,
  writeState,
};
