#!/usr/bin/env node
'use strict';

// Diagnostics for /idle-compact doctor. Everything the plugin depends on,
// checked in the same environment the hooks themselves run in.

const os = require('os');
const fs = require('fs');

const config = require('./lib/config');
const inject = require('./lib/inject');
const live = require('./lib/sessions');

const lines = [];
function say(s) {
  lines.push(s);
}

const cfg = config.resolve();

say('platform:      ' + process.platform + ' ' + os.release() + ' (' + process.arch + ')');
say('node:          ' + process.version + ' at ' + process.execPath);
say('home:          ' + os.homedir());
say('');
say('enabled:       ' + (cfg.enabled ? 'yes' : 'no'));
say(
  'idle threshold: ' +
    cfg.idleMinutes +
    ' min ' +
    (cfg.idleMinutesIsDefault
      ? '(' + cfg.cacheTtl + ' cache TTL minus ' + config.GRACE_MINUTES + ' min)'
      : '(explicit override)')
);
say('min context:   ' + cfg.minTokens + ' tokens');
say('blind inject:  ' + (cfg.allowBlindInjection ? 'allowed' : 'blocked'));
say('setup done:    ' + (cfg.setupCompleted ? 'yes' : 'no'));
say('config file:   ' + config.CONFIG_PATH + (fs.existsSync(config.CONFIG_PATH) ? '' : ' (absent)'));
say('state dir:     ' + config.SESSION_DIR);

say('');
say('terminal environment:');
const env = inject.captureEnv();
const keys = Object.keys(env);
if (!keys.length) {
  say('  (none of the recognised terminal variables are set)');
} else {
  for (const key of keys) say('  ' + key + '=' + env[key]);
}

const tty = inject.controllingTty(process.ppid);
say('  controlling tty: ' + (tty || 'not found'));
const claudePid = inject.findClaudePid(process.ppid);
say('  claude pid:      ' + (claudePid || 'not found'));

say('');
say('injection providers:');
const ctx = inject.makeContext({ env, tty, text: '/compact' });
const found = inject.detect(ctx);
if (!found.length) {
  say('  NONE — no way to type into this terminal was detected.');
  say('  Supported: tmux, GNU screen, WezTerm, kitty (remote control on),');
  say('  iTerm2, Apple Terminal, xdotool (X11), ydotool (Wayland), Windows SendKeys.');
} else {
  for (const p of found) {
    const usable = !p.blind || cfg.allowBlindInjection;
    say(
      '  ' +
        p.name +
        (p.blind ? ' [blind]' : ' [targeted]') +
        (usable ? '' : '  — blocked, enable with: /idle-compact blind on')
    );
  }
  const first = found.find((p) => !p.blind || cfg.allowBlindInjection);
  say('  selected: ' + (first ? first.name : 'NONE'));
}

say('');
say('helper binaries:');
for (const bin of ['tmux', 'screen', 'wezterm', 'kitty', 'osascript', 'xdotool', 'ydotool']) {
  say('  ' + bin.padEnd(10) + (inject.have(bin) ? 'found' : '-'));
}

say('');
const view = live.describe();
say('live sessions: ' + view.sessions.length);
for (const s of view.sessions) {
  say(
    '  ' +
      s.shortId +
      '  ' +
      s.status +
      (s.detail ? '/' + s.detail : '') +
      '  fireAt=' +
      (s.fireAt ? new Date(s.fireAt).toISOString() : 'unknown') +
      '  ctx=' +
      (s.contextTokens == null ? 'unknown' : s.contextTokens) +
      '  claude=' +
      (s.claudePid || '-') +
      (s.claudePid && !s.claudeAlive ? ' (dead)' : '') +
      '  timer=' +
      (s.timerPid || '-') +
      (s.timerPid && !s.timerAlive ? ' (dead)' : '') +
      (s.fired ? '  last=' + JSON.stringify(s.fired) : '')
  );
}

process.stdout.write(lines.join('\n') + '\n');
