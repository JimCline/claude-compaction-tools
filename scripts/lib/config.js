'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// The two Anthropic prompt-cache TTLs. Compaction is scheduled one minute
// before the cached prefix expires: late enough that a user who comes back
// still lands on a warm cache, early enough that the compaction request
// itself still reads the warm prefix instead of paying a full re-write.
const TTL_MINUTES = { '5m': 5, '1h': 60 };
const GRACE_MINUTES = 1;
const DEFAULT_TTL = '1h';

const ROOT = path.join(os.homedir(), '.claude', 'idle-compactor');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const SESSION_DIR = path.join(ROOT, 'sessions');

const DEFAULTS = {
  enabled: true,
  cacheTtl: DEFAULT_TTL,
  idleMinutes: null, // null => derive from cacheTtl
  minTokens: 20000,
  allowBlindInjection: false,
  setupCompleted: false,
  promptPath: null, // user-level compaction prompt file
  prompts: {}, // repo key => compaction prompt file, overrides promptPath
};

function ensureRoot() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  return ROOT;
}

function defaultMinutesFor(ttl) {
  const total = TTL_MINUTES[ttl] || TTL_MINUTES[DEFAULT_TTL];
  return Math.max(1, total - GRACE_MINUTES);
}

function read() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function write(patch) {
  ensureRoot();
  const next = Object.assign({}, DEFAULTS, read(), patch);
  const tmp = CONFIG_PATH + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);
  return next;
}

// write() merges one level deep, so a patch carrying `prompts` would replace
// the whole map. Every per-repo change goes through here instead.
function setPromptPath(repoKey, file) {
  const current = Object.assign({}, DEFAULTS, read());
  const prompts = Object.assign({}, current.prompts);
  if (file) prompts[repoKey] = file;
  else delete prompts[repoKey];
  return write({ prompts });
}

function truthy(v) {
  if (v == null) return false;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function falsy(v) {
  if (v == null) return false;
  return /^(0|false|no|off)$/i.test(String(v).trim());
}

// Env vars win over the config file so a single session can be steered
// without mutating the user's saved preferences.
function resolve(env) {
  env = env || process.env;
  const cfg = Object.assign({}, DEFAULTS, read());
  // Object.assign is shallow, so an untouched config would hand every caller
  // the same DEFAULTS.prompts object to mutate.
  cfg.prompts = Object.assign({}, cfg.prompts);

  if (truthy(env.CLAUDE_IDLE_COMPACT_DISABLE)) cfg.enabled = false;
  if (falsy(env.CLAUDE_IDLE_COMPACT_DISABLE)) cfg.enabled = true;

  const ttl = env.CLAUDE_IDLE_COMPACT_TTL;
  if (ttl && Object.prototype.hasOwnProperty.call(TTL_MINUTES, ttl)) cfg.cacheTtl = ttl;

  const mins = Number(env.CLAUDE_IDLE_COMPACT_MINUTES);
  if (Number.isFinite(mins) && mins > 0) cfg.idleMinutes = mins;

  const minTok = Number(env.CLAUDE_IDLE_COMPACT_MIN_TOKENS);
  if (Number.isFinite(minTok) && minTok >= 0) cfg.minTokens = minTok;

  if (truthy(env.CLAUDE_IDLE_COMPACT_ALLOW_BLIND)) cfg.allowBlindInjection = true;
  if (falsy(env.CLAUDE_IDLE_COMPACT_ALLOW_BLIND)) cfg.allowBlindInjection = false;

  if (!Number.isFinite(Number(cfg.idleMinutes)) || Number(cfg.idleMinutes) <= 0) {
    cfg.idleMinutes = defaultMinutesFor(cfg.cacheTtl);
    cfg.idleMinutesIsDefault = true;
  } else {
    cfg.idleMinutes = Number(cfg.idleMinutes);
    cfg.idleMinutesIsDefault = cfg.idleMinutes === defaultMinutesFor(cfg.cacheTtl);
  }

  return cfg;
}

module.exports = {
  TTL_MINUTES,
  GRACE_MINUTES,
  DEFAULT_TTL,
  DEFAULTS,
  ROOT,
  CONFIG_PATH,
  SESSION_DIR,
  ensureRoot,
  defaultMinutesFor,
  read,
  write,
  setPromptPath,
  resolve,
};
