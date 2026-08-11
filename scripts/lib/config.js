'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// The two Anthropic prompt-cache TTLs. Compaction is scheduled a grace
// period before the cached prefix expires: late enough that a user who comes
// back still lands on a warm cache, early enough that the compaction request
// itself still reads the warm prefix instead of paying a full re-write. The
// grace is wider on the 1h TTL because a long agentic turn can burn several
// minutes of the window before the idle timer is even armed.
const TTL_MINUTES = { '5m': 5, '1h': 60 };
const GRACE_MINUTES = { '5m': 1, '1h': 5 };
const DEFAULT_TTL = '1h';

const ROOT = path.join(os.homedir(), '.claude', 'idle-compactor');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const SESSION_DIR = path.join(ROOT, 'sessions');

const DEFAULTS = {
  enabled: true,
  cacheTtl: DEFAULT_TTL,
  idleMinutes: null, // null => derive from cacheTtl and idleAction
  minTokens: 20000,
  allowBlindInjection: false,
  setupCompleted: false,
  promptPath: null, // user-level compaction prompt file
  prompts: {}, // repo key => compaction prompt file, overrides promptPath
  idleAction: 'compact', // 'compact' | 'keepalive'
  keepaliveMaxPings: 12,
  keepaliveGraceMinutes: 5,
};

function ensureRoot() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  return ROOT;
}

function graceMinutesFor(ttl) {
  const key = Object.prototype.hasOwnProperty.call(GRACE_MINUTES, ttl) ? ttl : DEFAULT_TTL;
  return GRACE_MINUTES[key];
}

function defaultMinutesFor(ttl) {
  const key = Object.prototype.hasOwnProperty.call(TTL_MINUTES, ttl) ? ttl : DEFAULT_TTL;
  return Math.max(1, TTL_MINUTES[key] - graceMinutesFor(key));
}

// Keepalive pings the cache instead of compacting, so a missed window is far
// costlier than in compact mode: a full-price cache write instead of a cheap
// read, repeated on every subsequent ping. That asymmetry is why its grace is
// its own configurable knob rather than sharing GRACE_MINUTES.
function keepaliveMinutesFor(ttl, cfg) {
  const key = Object.prototype.hasOwnProperty.call(TTL_MINUTES, ttl) ? ttl : DEFAULT_TTL;
  const grace =
    cfg && Number.isFinite(Number(cfg.keepaliveGraceMinutes))
      ? Number(cfg.keepaliveGraceMinutes)
      : DEFAULTS.keepaliveGraceMinutes;
  return Math.max(1, TTL_MINUTES[key] - grace);
}

function effectiveIdleMinutes(cfg) {
  return cfg.idleAction === 'keepalive'
    ? keepaliveMinutesFor(cfg.cacheTtl, cfg)
    : defaultMinutesFor(cfg.cacheTtl);
}

function effectiveGraceMinutes(cfg) {
  return cfg.idleAction === 'keepalive' ? cfg.keepaliveGraceMinutes : graceMinutesFor(cfg.cacheTtl);
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
    cfg.idleMinutes = effectiveIdleMinutes(cfg);
    cfg.idleMinutesIsDefault = true;
  } else {
    cfg.idleMinutes = Number(cfg.idleMinutes);
    cfg.idleMinutesIsDefault = cfg.idleMinutes === effectiveIdleMinutes(cfg);
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
  graceMinutesFor,
  keepaliveMinutesFor,
  effectiveIdleMinutes,
  effectiveGraceMinutes,
  read,
  write,
  setPromptPath,
  resolve,
};
