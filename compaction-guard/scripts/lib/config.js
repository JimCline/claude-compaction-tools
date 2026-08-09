'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { POLICY } = require('./directive');

const ROOT = path.join(os.homedir(), '.claude', 'compaction-guard');
const CONFIG_PATH = path.join(ROOT, 'config.json');

// mode: 'default' uses the shipped policy; 'replace' swaps in `directive`;
// 'append' keeps the policy and adds `directive` after it.
const DEFAULTS = { version: 1, enabled: true, mode: 'default', directive: '', repos: {} };

function ensureRoot() {
  fs.mkdirSync(ROOT, { recursive: true });
}

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return Object.assign({}, DEFAULTS, raw);
  } catch (_) {
    return Object.assign({}, DEFAULTS);
  }
}

function write(cfg) {
  ensureRoot();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

// Nearest enclosing git worktree, so a per-repo override keys off the same
// identity the user sees in their prompt rather than an arbitrary subdirectory.
function repoRoot(startDir) {
  let dir = startDir;
  while (dir) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function forRepo(cfg, cwd) {
  const key = repoRoot(cwd || process.cwd()) || cwd || process.cwd();
  const override = (cfg.repos && cfg.repos[key]) || {};
  return {
    key,
    enabled: override.enabled !== undefined ? override.enabled : cfg.enabled,
    mode: override.mode || cfg.mode,
    directive: override.directive !== undefined ? override.directive : cfg.directive,
  };
}

function resolve(cwd) {
  const settings = forRepo(read(), cwd);
  if (!settings.enabled) return { enabled: false, text: '' };

  let text;
  if (settings.mode === 'replace') text = settings.directive || '';
  else if (settings.mode === 'append') {
    text = settings.directive ? POLICY + '\n\n' + settings.directive : POLICY;
  } else text = POLICY;

  return { enabled: true, key: settings.key, mode: settings.mode, text: text.trim() };
}

function setRepo(cwd, patch) {
  const cfg = read();
  const key = repoRoot(cwd || process.cwd()) || cwd || process.cwd();
  if (!cfg.repos) cfg.repos = {};
  cfg.repos[key] = Object.assign({}, cfg.repos[key], patch);
  write(cfg);
  return cfg.repos[key];
}

module.exports = { ROOT, CONFIG_PATH, DEFAULTS, read, write, forRepo, resolve, setRepo, repoRoot };
