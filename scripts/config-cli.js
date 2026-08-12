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
const live = require('./lib/sessions');

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
    ? 'derived from the ' + cfg.cacheTtl + ' cache TTL minus ' + config.effectiveGraceMinutes(cfg) + ' min'
    : 'explicit override';
  return [
    'idle-compactor: ' + (cfg.enabled ? 'ON' : 'OFF'),
    'mode:           ' +
      cfg.idleAction +
      (cfg.idleAction === 'keepalive' ? ' (max ' + cfg.keepaliveMaxPings + ' pings)' : ''),
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
  const view = live.describe();
  out([describe(cfg), '', live.render(view)].join('\n'), {
    ok: true,
    config: cfg,
    sessions: view.sessions,
    counts: view.counts,
  });
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
    stats.resetPings();
    return out('compaction stats cleared', { ok: true });
  }
  if (sub === 'sessions') {
    const view = live.describe();
    return out(live.render(view), {
      ok: true,
      now: view.now,
      counts: view.counts,
      sessions: view.sessions,
    });
  }
  if (sub !== 'show') {
    return fail('unknown stats command: ' + sub + ' (expected show, sessions, or reset)');
  }

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

  const savings = stats.summarizeSavings();
  lines.push('');
  if (savings.events === 0 && savings.emptyChains === 0) {
    lines.push('no token-savings events recorded yet');
  } else {
    lines.push(
      'idle events:      ' +
        savings.events +
        '  (' +
        savings.compactions +
        ' compactions, ' +
        savings.keepaliveChains +
        ' keepalive chains)'
    );
    let tokensLine = 'tokens protected: ' + savings.tokensProtected;
    if (savings.eventsMissingTokens > 0) {
      tokensLine += '  (' + savings.eventsMissingTokens + ' chains had no recorded token count)';
    }
    lines.push(tokensLine);
    if (savings.pingHits + savings.pingMisses > 0) {
      lines.push('keepalive pings:   ' + savings.pingHits + ' hits, ' + savings.pingMisses + ' misses');
    }
    if (savings.emptyChains > 0) {
      lines.push('  (' + savings.emptyChains + ' keepalive chains protected nothing)');
    }
    if (savings.tokensRewritten > 0) {
      lines.push('  (' + savings.tokensRewritten + ' tokens rewritten by missed pings)');
    }
    const models = Object.keys(savings.byModel).sort(
      (a, b) => savings.byModel[b].tokens - savings.byModel[a].tokens
    );
    if (models.length) {
      lines.push('');
      lines.push('by model:');
      for (const m of models) {
        const row = savings.byModel[m];
        lines.push(
          '  ' +
            m.padEnd(18) +
            ' ' +
            String(row.events).padStart(3) +
            ' events   ' +
            String(row.tokens).padStart(9) +
            ' tokens'
        );
      }
    }
  }

  const view = live.describe();
  lines.push('');
  lines.push(live.render(view));

  return out(lines.join('\n'), {
    ok: true,
    stats: summary,
    savings,
    counts: view.counts,
    sessions: view.sessions,
  });
}

function formatChainEvent(g) {
  const at = new Date(g.lastAt).toISOString();
  const kind = (g.kind === 'compact' ? 'compact' : 'keepalive').padEnd(9);
  const sid = (g.sessionId || '').slice(0, 8).padEnd(8);
  const model = String(g.model || '(unknown)').padEnd(18);
  const effort = String(g.effort || '-').padEnd(6);
  const tokens = String(g.tokens != null ? g.tokens : '-').padStart(9);
  let line = at + '  ' + kind + '  ' + sid + '  ' + model + '  ' + effort + '  ' + tokens;
  if (g.pings > 1) line += '  x' + g.pings;
  return line;
}

function formatRawRow(row, source) {
  const at = new Date(row.at || 0).toISOString();
  const label =
    source === 'pings'
      ? ('ping-' + (row.result || '?')).padEnd(9)
      : (row.ok
          ? row.mode || 'compact'
          : row.reason === 'activity-detected'
          ? 'skipped'
          : 'failed'
        ).padEnd(9);
  const sid = (row.sessionId || '').slice(0, 8).padEnd(8);
  const model = String(row.model || '(unknown)').padEnd(18);
  const effort = String(row.effort || '-').padEnd(6);
  const tokens = String(row.tokens != null ? row.tokens : '-').padStart(9);
  return at + '  ' + label + '  ' + sid + '  ' + model + '  ' + effort + '  ' + tokens;
}

function logCommand() {
  const showAll = (args[1] || '').toLowerCase() === 'all';
  const countArg = showAll ? args[2] : args[1];
  let n = 10;
  if (countArg !== undefined) {
    n = Number(countArg);
    if (!Number.isInteger(n) || n < 1 || n > 200) {
      return fail('log count must be an integer between 1 and 200');
    }
  }

  if (showAll) {
    const tagged = stats
      .readAll()
      .map((r) => ({ row: r, source: 'fires' }))
      .concat(stats.readPings().map((r) => ({ row: r, source: 'pings' })));
    tagged.sort((a, b) => (b.row.at || 0) - (a.row.at || 0));
    const top = tagged.slice(0, n);
    if (!top.length) return out('no idle compaction events recorded yet', { ok: true, events: [] });
    return out(
      top.map((t) => formatRawRow(t.row, t.source)).join('\n'),
      { ok: true, events: top.map((t) => t.row) }
    );
  }

  const events = stats
    .readSavings()
    .slice()
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, n);
  if (!events.length) return out('no idle compaction events recorded yet', { ok: true, events: [] });
  return out(events.map(formatChainEvent).join('\n'), { ok: true, events });
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
        const current = config.resolve();
        if (value === '5m' && current.idleAction === 'keepalive') {
          return fail(
            'cannot use ttl 5m in keepalive mode: pinging a 5-minute cache loses money inside ' +
              'the hour. Switch action to compact first, or keep ttl 1h.'
          );
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
      if (key === 'action') {
        const v = (value || '').toLowerCase();
        if (v !== 'compact' && v !== 'keepalive') return fail('action must be compact or keepalive');
        const current = config.resolve();
        if (v === 'keepalive' && current.cacheTtl === '5m') {
          return fail(
            'cannot enable keepalive under the 5-minute cache TTL: it loses money inside the ' +
              'hour. Run "/idle-compact 1h" first, or set ttl 1h.'
          );
        }
        // Choosing an action means "use that action's derived default",
        // same reasoning as choosing a TTL above.
        config.write({ idleAction: v, idleMinutes: null });
        return out(describe(config.resolve()), { ok: true, config: config.resolve() });
      }
      if (key === 'max-pings') {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
          return fail('max-pings must be a positive integer');
        }
        config.write({ keepaliveMaxPings: n });
        return out(describe(config.resolve()), { ok: true, config: config.resolve() });
      }
      return fail('unknown setting: ' + key + ' (expected ttl, minutes, min-tokens, action, or max-pings)');
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

    case 'log':
      return logCommand();

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
