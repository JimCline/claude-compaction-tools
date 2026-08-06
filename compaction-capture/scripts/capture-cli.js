#!/usr/bin/env node
'use strict';

// Backing CLI for the /compaction-capture slash command.

const fs = require('fs');
const path = require('path');

const capture = require('./lib/capture');
const config = require('./lib/config');
const repo = require('./lib/repo');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const args = argv.filter((a) => a !== '--json');

function flag(name) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

function out(text, data) {
  if (asJson) process.stdout.write(JSON.stringify(data || {}, null, 2) + '\n');
  else process.stdout.write(text + '\n');
}

function fail(message) {
  out('error: ' + message, { ok: false, error: message });
  process.exit(1);
}

function describe(cwd) {
  const settings = config.forRepo(cwd);
  const lines = [
    'compaction-capture: ' + (settings && settings.enabled ? 'ON' : 'OFF') + ' for this repo',
    'repo:           ' + repo.name(cwd) + '  (' + repo.key(cwd) + ')',
    'saving to:      ' + ((settings && settings.location) || 'not set'),
    'config file:    ' + config.CONFIG_PATH,
  ];
  return lines.join('\n');
}

function status() {
  const cwd = process.cwd();
  const settings = config.forRepo(cwd);
  const lines = [describe(cwd)];

  let captures = [];
  if (settings && settings.location) {
    try {
      captures = fs
        .readdirSync(settings.location)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .reverse();
    } catch (_) {
      /* folder not created yet */
    }
  }

  lines.push('captures:       ' + captures.length);
  if (captures.length) lines.push('most recent:    ' + captures[0]);

  // PostCompact's payload shape is undocumented, so surface what actually
  // arrived last — it is the fastest way to see whether the hook ever ran.
  let payload = null;
  try {
    payload = JSON.parse(fs.readFileSync(path.join(config.STATE_DIR, 'last-payload.json'), 'utf8'));
  } catch (_) {
    /* hook has not fired yet */
  }
  lines.push(
    'hook last ran:  ' + (payload ? payload.at + '  fields: ' + (payload.keys || []).join(', ') : 'never')
  );

  out(lines.join('\n'), {
    ok: true,
    enabled: !!(settings && settings.enabled),
    settings,
    repoKey: repo.key(cwd),
    captures,
    lastPayload: payload,
  });
}

function presets() {
  const cwd = process.cwd();
  const p = config.presets(cwd);
  const lines = [
    'repo     ' + p.repo.location,
    'central  ' + p.central.location,
    '',
    'Or any absolute path you name.',
  ];
  out(lines.join('\n'), { ok: true, presets: p, repoKey: repo.key(cwd) });
}

function enable() {
  const cwd = process.cwd();
  const mode = flag('mode') || 'custom';
  let location = flag('location');

  if (!location) {
    const p = config.presets(cwd);
    if (mode === 'repo' || mode === 'central') location = p[mode].location;
  }
  if (!location) return fail('enable needs --location <dir> (or --mode repo|central)');

  location = path.resolve(location);
  try {
    fs.mkdirSync(location, { recursive: true });
  } catch (err) {
    return fail('cannot create ' + location + ': ' + ((err && err.message) || err));
  }

  config.setRepo(cwd, { enabled: true, location, mode });
  return out(describe(cwd), { ok: true, settings: config.forRepo(cwd) });
}

function disable() {
  const cwd = process.cwd();
  // The location is kept so turning it back on does not re-ask.
  config.setRepo(cwd, { enabled: false });
  return out(describe(cwd), { ok: true, settings: config.forRepo(cwd) });
}

// Writes a capture right now from the current transcript, bypassing the
// enabled check. The only way to prove the whole path works without waiting
// for a real compaction.
async function captureNow() {
  const cwd = process.cwd();
  const settings = config.forRepo(cwd);
  const location = flag('location') || (settings && settings.location);
  if (!location) return fail('no location configured; run enable first, or pass --location <dir>');

  const result = await capture.run(
    { session_id: flag('session') || 'manual', cwd, transcript_path: flag('transcript') || null },
    { force: true, location: path.resolve(location), waitMs: 0, transcriptPath: flag('transcript') }
  );

  if (!result.ok) {
    return fail(result.skipped || result.error || 'capture failed');
  }
  return out('wrote ' + result.file + '  (' + result.chars + ' chars)', Object.assign({ ok: true }, result));
}

async function main() {
  try {
    config.setPaths(path.resolve(__dirname, '..'), process.execPath);
  } catch (_) {
    /* best effort */
  }

  const cmd = (args[0] || 'status').toLowerCase();

  switch (cmd) {
    case 'status':
      return status();
    case 'presets':
      return presets();
    case 'on':
    case 'enable':
      return enable();
    case 'off':
    case 'disable':
      return disable();
    case 'capture':
      return captureNow();
    default:
      return fail('unknown command: ' + cmd);
  }
}

main().catch((err) => fail((err && err.message) || String(err)));
