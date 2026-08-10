#!/usr/bin/env node
'use strict';

// Backing CLI for the /idle-compact slash command.

const path = require('path');

const fs = require('fs');

const config = require('./lib/config');
const state = require('./lib/state');
const inject = require('./lib/inject');
const prompt = require('./lib/prompt');
const repo = require('./lib/repo');
const stats = require('./lib/stats');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const args = argv.filter((a) => a !== '--json');

function out(text, data) {
  if (asJson) {
    process.stdout.write(JSON.stringify(data || {}, null, 2) + '\n');
  } else {
    process.stdout.write(text + '\n');
  }
}

function fail(message) {
  out('error: ' + message, { ok: false, error: message });
  process.exit(1);
}

function describe(cfg) {
  const source = cfg.idleMinutesIsDefault
    ? 'derived from the ' + cfg.cacheTtl + ' cache TTL minus ' + config.GRACE_MINUTES + ' min'
    : 'explicit override';
  return [
    'idle-compactor: ' + (cfg.enabled ? 'ON' : 'OFF'),
    'idle threshold: ' + cfg.idleMinutes + ' min (' + source + ')',
    'cache TTL mode: ' + cfg.cacheTtl,
    'minimum context: ' + cfg.minTokens + ' tokens',
    'blind injection: ' + (cfg.allowBlindInjection ? 'allowed' : 'blocked'),
    prompt.describe(process.cwd(), cfg),
    'config file:    ' + config.CONFIG_PATH,
  ].join('\n');
}

function promptCommand() {
  const sub = (args[1] || 'show').toLowerCase();
  const userLevel = args.includes('--user');
  const cwd = process.cwd();

  if (sub === 'show') {
    const cfg = config.resolve();
    const resolved = prompt.resolveFor(cwd, cfg);
    const lines = [
      prompt.describe(cwd, cfg),
      'repo key:       ' + repo.key(cwd),
      'user-level:     ' + (cfg.promptPath || 'none'),
    ];
    if (resolved.text) {
      lines.push('');
      lines.push('would send: /compact ' + resolved.text);
    }
    return out(lines.join('\n'), { ok: true, prompt: resolved, repoKey: repo.key(cwd) });
  }

  if (sub === 'use') {
    const given = args[2];
    if (!given) return fail('prompt use needs a file path');
    const file = path.resolve(given);
    if (!fs.existsSync(file)) return fail('no such file: ' + file);

    const text = prompt.flatten(fs.readFileSync(file, 'utf8'));
    if (!text) return fail('that file is empty, so there is no prompt to send');

    if (userLevel) config.write({ promptPath: file });
    else config.setPromptPath(repo.key(cwd), file);

    const cfg = config.resolve();
    const lines = [prompt.describe(cwd, cfg)];
    if (text.length > prompt.MAX_CHARS) {
      lines.push(
        'note: ' +
          text.length +
          ' chars flattened; only the first ' +
          prompt.MAX_CHARS +
          ' will be sent'
      );
    }
    lines.push('would send: /compact ' + text.slice(0, prompt.MAX_CHARS));
    return out(lines.join('\n'), { ok: true, path: file, scope: userLevel ? 'user' : 'repo' });
  }

  if (sub === 'clear') {
    if (userLevel) config.write({ promptPath: null });
    else config.setPromptPath(repo.key(cwd), null);
    return out(prompt.describe(cwd, config.resolve()), { ok: true });
  }

  return fail('unknown prompt command: ' + sub + ' (expected show, use, or clear)');
}

function status() {
  const cfg = config.resolve();
  const armed = state
    .listSessions()
    .map((f) => state.readPath(f))
    .filter(Boolean)
    .map((r) => ({
      sessionId: r.sessionId,
      firesInSeconds: Math.max(0, Math.round((r.fireAt - Date.now()) / 1000)),
      contextTokens: r.contextTokens,
      timerAlive: state.isAlive(r.timerPid),
      fired: r.fired || null,
    }));

  const lines = [describe(cfg)];
  if (armed.length) {
    lines.push('');
    lines.push('armed sessions:');
    for (const a of armed) {
      lines.push(
        '  ' +
          a.sessionId.slice(0, 8) +
          '  fires in ' +
          Math.floor(a.firesInSeconds / 60) +
          'm' +
          (a.firesInSeconds % 60) +
          's' +
          '  ctx=' +
          (a.contextTokens == null ? 'unknown' : a.contextTokens) +
          (a.timerAlive ? '' : '  (timer not running)')
      );
    }
  } else {
    lines.push('');
    lines.push('no armed sessions');
  }
  out(lines.join('\n'), { ok: true, config: cfg, armed });
}

function testInjection() {
  const cfg = config.resolve();
  const send = args.includes('--send');
  const textIdx = args.indexOf('--text');
  const text = textIdx >= 0 && args[textIdx + 1] ? args[textIdx + 1] : '/idle-compact status';

  const ctx = inject.makeContext({
    env: inject.captureEnv(),
    tty: inject.controllingTty(process.ppid),
    text,
  });
  const found = inject.detect(ctx).map((p) => ({
    provider: p.name,
    blind: p.blind,
    usable: !p.blind || cfg.allowBlindInjection,
  }));

  if (!send) {
    const usable = found.filter((p) => p.usable);
    const lines = [
      'detected providers: ' + (found.length ? found.map((p) => p.provider).join(', ') : 'none'),
      'would use: ' + (usable.length ? usable[0].provider : 'NONE — injection would fail'),
    ];
    const blocked = found.filter((p) => p.blind && !p.usable);
    if (blocked.length) {
      lines.push(
        'blocked (blind): ' +
          blocked.map((p) => p.provider).join(', ') +
          '  — enable with: /idle-compact blind on'
      );
    }
    lines.push('');
    lines.push('Run with --send to actually type ' + JSON.stringify(text) + ' into this terminal.');
    return out(lines.join('\n'), { ok: true, providers: found, wouldSend: text });
  }

  const result = inject.inject({
    env: ctx.env,
    tty: ctx.tty,
    text,
    allowBlind: cfg.allowBlindInjection,
  });
  out(
    result.ok
      ? 'injected via ' + result.provider
      : 'injection failed\n' + JSON.stringify(result.attempts, null, 2),
    Object.assign({ ok: result.ok }, result)
  );
  if (!result.ok) process.exit(1);
}

function statsCommand() {
  const sub = (args[1] || 'show').toLowerCase();

  if (sub === 'reset') {
    stats.reset();
    return out('compaction stats cleared', { ok: true });
  }
  if (sub !== 'show') return fail('unknown stats command: ' + sub + ' (expected show or reset)');

  const summary = stats.summarize();
  const lines = [
    'autocompactions: ' + summary.ok,
    'attempts:        ' +
      summary.totalAttempts +
      '  (' +
      summary.ok +
      ' ok, ' +
      summary.activitySkipped +
      ' skipped-activity, ' +
      summary.failed +
      ' failed)',
  ];

  const ids = Object.keys(summary.sessions).sort(
    (a, b) => summary.sessions[b].lastAt - summary.sessions[a].lastAt
  );
  if (ids.length) {
    lines.push('');
    lines.push('per session:');
    for (const id of ids) {
      const s = summary.sessions[id];
      lines.push(
        '  ' +
          id.slice(0, 8) +
          '  ' +
          s.ok +
          ' autocompaction' +
          (s.ok === 1 ? '' : 's') +
          '  (last ' +
          new Date(s.lastAt).toISOString() +
          ')'
      );
    }
  } else {
    lines.push('');
    lines.push('no recorded fires yet');
  }

  return out(lines.join('\n'), { ok: true, stats: summary });
}

function main() {
  const cmd = (args[0] || 'status').toLowerCase();

  switch (cmd) {
    case 'status':
      return status();

    case 'on':
      config.write({ enabled: true });
      return out(describe(config.resolve()), { ok: true, config: config.resolve() });

    case 'off': {
      config.write({ enabled: false });
      for (const file of state.listSessions()) {
        const record = state.readPath(file);
        if (record && record.timerPid) state.killIfRunning(record.timerPid);
        if (record) state.remove(record.sessionId);
      }
      return out(describe(config.resolve()), { ok: true, config: config.resolve() });
    }

    case 'set': {
      const key = (args[1] || '').toLowerCase();
      const value = args[2];
      if (key === 'ttl') {
        if (!Object.prototype.hasOwnProperty.call(config.TTL_MINUTES, value)) {
          return fail('ttl must be one of: ' + Object.keys(config.TTL_MINUTES).join(', '));
        }
        // Choosing a TTL means "use that TTL's derived default", so any
        // previous explicit minute count is cleared.
        config.write({ cacheTtl: value, idleMinutes: null });
        return out(describe(config.resolve()), { ok: true, config: config.resolve() });
      }
      if (key === 'minutes') {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return fail('minutes must be a positive number');
        config.write({ idleMinutes: n });
        return out(describe(config.resolve()), { ok: true, config: config.resolve() });
      }
      if (key === 'min-tokens') {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) return fail('min-tokens must be zero or greater');
        config.write({ minTokens: n });
        return out(describe(config.resolve()), { ok: true, config: config.resolve() });
      }
      return fail('unknown setting: ' + key + ' (expected ttl, minutes, or min-tokens)');
    }

    case 'blind': {
      const value = (args[1] || '').toLowerCase();
      if (value !== 'on' && value !== 'off') return fail('blind takes "on" or "off"');
      config.write({ allowBlindInjection: value === 'on' });
      return out(describe(config.resolve()), { ok: true, config: config.resolve() });
    }

    case 'paths': {
      const cfg = config.resolve();
      const root = cfg.pluginRoot || path.resolve(__dirname, '..');
      const node = cfg.nodePath || process.execPath;
      return out('node: ' + node + '\nroot: ' + root, { ok: true, nodePath: node, pluginRoot: root });
    }

    case 'setup-done':
      config.write({ setupCompleted: true });
      return out('setup recorded', { ok: true, config: config.resolve() });

    case 'reset':
      config.write(Object.assign({}, config.DEFAULTS));
      return out(describe(config.resolve()), { ok: true, config: config.resolve() });

    case 'prompt':
      return promptCommand();

    case 'stats':
      return statsCommand();

    case 'test':
      return testInjection();

    default:
      return fail('unknown command: ' + cmd);
  }
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
