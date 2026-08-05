'use strict';

const { spawnSync } = require('child_process');

const EXEC_TIMEOUT_MS = 8000;

// Env vars that identify *which* pane/tab/window this session occupies. They
// are captured while the hook runs, because the detached timer inherits a
// stripped environment and cannot re-derive them later.
const CAPTURED_ENV = [
  'TMUX',
  'TMUX_PANE',
  'STY',
  'WINDOW',
  'ITERM_SESSION_ID',
  'TERM_SESSION_ID',
  'WEZTERM_PANE',
  'WEZTERM_UNIX_SOCKET',
  'KITTY_WINDOW_ID',
  'KITTY_LISTEN_ON',
  'WINDOWID',
  'WT_SESSION',
  'TERM_PROGRAM',
  'DISPLAY',
  'WAYLAND_DISPLAY',
];

function captureEnv(env) {
  env = env || process.env;
  const out = {};
  for (const key of CAPTURED_ENV) {
    if (env[key]) out[key] = env[key];
  }
  return out;
}

function run(cmd, args, opts) {
  const res = spawnSync(cmd, args, {
    timeout: EXEC_TIMEOUT_MS,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(opts || {}),
  });
  return {
    ok: !res.error && res.status === 0,
    status: res.status,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
    error: res.error ? res.error.message : null,
  };
}

function have(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return run(probe, [cmd]).ok;
}

// Walk up the process tree until a controlling tty appears. Hooks are spawned
// through a shell, so our own ppid is not reliably the terminal-owning process.
function controllingTty(startPid) {
  if (process.platform === 'win32') return null;
  let pid = startPid || process.ppid;
  for (let depth = 0; depth < 8 && pid && pid > 1; depth++) {
    const tty = run('ps', ['-o', 'tty=', '-p', String(pid)]).stdout;
    if (tty && tty !== '?' && tty !== '??' && tty !== '-') {
      return tty.startsWith('/dev/') ? tty : '/dev/' + tty;
    }
    const parent = Number(run('ps', ['-o', 'ppid=', '-p', String(pid)]).stdout);
    if (!Number.isFinite(parent) || parent === pid) break;
    pid = parent;
  }
  return null;
}

// Ordered list of ancestors as {pid, comm}, nearest first. Used to find the
// Claude Code process so the timer can abort once that session is gone.
function ancestry(startPid) {
  if (process.platform === 'win32') return [];
  const chain = [];
  let pid = startPid || process.ppid;
  for (let depth = 0; depth < 8 && pid && pid > 1; depth++) {
    const comm = run('ps', ['-o', 'comm=', '-p', String(pid)]).stdout;
    chain.push({ pid, comm: comm || '' });
    const parent = Number(run('ps', ['-o', 'ppid=', '-p', String(pid)]).stdout);
    if (!Number.isFinite(parent) || parent === pid) break;
    pid = parent;
  }
  return chain;
}

function findClaudePid(startPid) {
  for (const entry of ancestry(startPid)) {
    if (/(^|\/)claude(\s|$)/.test(entry.comm) || /claude/i.test(entry.comm)) return entry.pid;
  }
  return null;
}

function osascript(script) {
  return run('osascript', ['-e', script]);
}

function appleQuote(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// ---------------------------------------------------------------------------
// Providers
//
// `blind: true` means the provider types into whatever window currently has
// focus rather than into a pane it can positively identify. Those are gated
// behind allowBlindInjection because a misfire types "/compact" into an
// unrelated application.
// ---------------------------------------------------------------------------

function providerTmux(ctx) {
  const pane = ctx.env.TMUX_PANE;
  if (!pane || !ctx.env.TMUX || !have('tmux')) return null;
  const socket = String(ctx.env.TMUX).split(',')[0];
  const base = socket ? ['-S', socket] : [];
  return {
    name: 'tmux',
    blind: false,
    send() {
      const typed = run('tmux', base.concat(['send-keys', '-t', pane, '-l', '--', ctx.text]));
      if (!typed.ok) return typed;
      return run('tmux', base.concat(['send-keys', '-t', pane, 'Enter']));
    },
  };
}

function providerScreen(ctx) {
  const sty = ctx.env.STY;
  if (!sty || !have('screen')) return null;
  const args = ['-S', sty];
  if (ctx.env.WINDOW) args.push('-p', String(ctx.env.WINDOW));
  return {
    name: 'screen',
    blind: false,
    send() {
      return run('screen', args.concat(['-X', 'stuff', ctx.text + '\n']));
    },
  };
}

function providerWezterm(ctx) {
  const pane = ctx.env.WEZTERM_PANE;
  if (!pane || !have('wezterm')) return null;
  return {
    name: 'wezterm',
    blind: false,
    send() {
      return run('wezterm', [
        'cli',
        'send-text',
        '--pane-id',
        String(pane),
        '--no-paste',
        ctx.text + '\n',
      ]);
    },
  };
}

function providerKitty(ctx) {
  const winId = ctx.env.KITTY_WINDOW_ID;
  if (!winId || !have('kitty')) return null;
  const args = ['@'];
  if (ctx.env.KITTY_LISTEN_ON) args.push('--to', ctx.env.KITTY_LISTEN_ON);
  return {
    name: 'kitty',
    blind: false,
    // Requires `allow_remote_control yes` in kitty.conf; fails cleanly otherwise.
    send() {
      return run('kitty', args.concat(['send-text', '--match', 'id:' + winId, ctx.text + '\r']));
    },
  };
}

function providerITerm2(ctx) {
  if (process.platform !== 'darwin') return null;
  const raw = ctx.env.ITERM_SESSION_ID;
  if (!raw) return null;
  // ITERM_SESSION_ID looks like "w0t7p0:UUID"; AppleScript exposes the UUID.
  const guid = raw.indexOf(':') >= 0 ? raw.slice(raw.indexOf(':') + 1) : raw;
  return {
    name: 'iterm2',
    blind: false,
    send() {
      const target = appleQuote(guid);
      return osascript(
        [
          'tell application "iTerm2"',
          '  repeat with theWindow in windows',
          '    repeat with theTab in tabs of theWindow',
          '      repeat with theSession in sessions of theTab',
          '        set sid to (id of theSession) as text',
          '        if sid is ' + target + ' or sid ends with ' + target + ' then',
          '          tell theSession to write text ' + appleQuote(ctx.text),
          '          return "sent"',
          '        end if',
          '      end repeat',
          '    end repeat',
          '  end repeat',
          'end tell',
          'error "session not found"',
        ].join('\n')
      );
    },
  };
}

function providerAppleTerminal(ctx) {
  if (process.platform !== 'darwin') return null;
  if (ctx.env.TERM_PROGRAM !== 'Apple_Terminal') return null;
  if (!ctx.tty) return null;
  return {
    name: 'apple-terminal',
    blind: false,
    send() {
      const tty = appleQuote(ctx.tty);
      return osascript(
        [
          'tell application "Terminal"',
          '  repeat with theWindow in windows',
          '    repeat with theTab in tabs of theWindow',
          '      if tty of theTab is ' + tty + ' then',
          '        do script ' + appleQuote(ctx.text) + ' in theTab',
          '        return "sent"',
          '      end if',
          '    end repeat',
          '  end repeat',
          'end tell',
          'error "tab not found"',
        ].join('\n')
      );
    },
  };
}

function providerXdotoolTargeted(ctx) {
  if (process.platform === 'win32' || process.platform === 'darwin') return null;
  if (!ctx.env.WINDOWID || !ctx.env.DISPLAY || !have('xdotool')) return null;
  const id = String(ctx.env.WINDOWID);
  return {
    name: 'xdotool-window',
    blind: false,
    send() {
      const typed = run('xdotool', ['type', '--window', id, '--clearmodifiers', '--', ctx.text]);
      if (!typed.ok) return typed;
      return run('xdotool', ['key', '--window', id, '--clearmodifiers', 'Return']);
    },
  };
}

function providerXdotoolActive(ctx) {
  if (process.platform === 'win32' || process.platform === 'darwin') return null;
  if (!ctx.env.DISPLAY || !have('xdotool')) return null;
  return {
    name: 'xdotool-active',
    blind: true,
    send() {
      const typed = run('xdotool', ['type', '--clearmodifiers', '--', ctx.text]);
      if (!typed.ok) return typed;
      return run('xdotool', ['key', '--clearmodifiers', 'Return']);
    },
  };
}

function providerYdotool(ctx) {
  if (process.platform === 'win32' || process.platform === 'darwin') return null;
  if (!ctx.env.WAYLAND_DISPLAY || !have('ydotool')) return null;
  return {
    name: 'ydotool',
    blind: true,
    send() {
      const typed = run('ydotool', ['type', ctx.text]);
      if (!typed.ok) return typed;
      return run('ydotool', ['key', '28:1', '28:0']); // KEY_ENTER down/up
    },
  };
}

function providerWindowsSendKeys(ctx) {
  if (process.platform !== 'win32') return null;
  const shell = have('pwsh') ? 'pwsh' : 'powershell';
  // SendKeys treats these as control characters, so they must be braced.
  const escaped = ctx.text.replace(/([+^%~(){}\[\]])/g, '{$1}');
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    '$ErrorActionPreference = "Stop";',
    '$p = Get-Process -Id ' + ctx.terminalPid + ' -ErrorAction Stop;',
    '$sig = New-Object -ComObject WScript.Shell;',
    '$null = $sig.AppActivate($p.Id);',
    'Start-Sleep -Milliseconds 250;',
    '[System.Windows.Forms.SendKeys]::SendWait(' + JSON.stringify(escaped) + ');',
    '[System.Windows.Forms.SendKeys]::SendWait("{ENTER}");',
  ].join(' ');
  return {
    name: 'windows-sendkeys',
    blind: true,
    send() {
      return run(shell, ['-NoProfile', '-NonInteractive', '-Command', script]);
    },
  };
}

const PROVIDERS = [
  providerTmux,
  providerScreen,
  providerWezterm,
  providerKitty,
  providerITerm2,
  providerAppleTerminal,
  providerXdotoolTargeted,
  providerXdotoolActive,
  providerYdotool,
  providerWindowsSendKeys,
];

function detect(ctx) {
  const found = [];
  for (const factory of PROVIDERS) {
    let p = null;
    try {
      p = factory(ctx);
    } catch (_) {
      p = null;
    }
    if (p) found.push(p);
  }
  return found;
}

function makeContext(opts) {
  opts = opts || {};
  return {
    env: opts.env || captureEnv(),
    tty: opts.tty || null,
    terminalPid: opts.terminalPid || process.ppid,
    text: opts.text || '/compact',
  };
}

// Tries each usable provider in order and stops at the first that reports
// success. Blind providers are skipped unless explicitly allowed.
function inject(opts) {
  const ctx = makeContext(opts);
  const allowBlind = !!(opts && opts.allowBlind);
  const candidates = detect(ctx);
  const attempts = [];

  for (const p of candidates) {
    if (p.blind && !allowBlind) {
      attempts.push({ provider: p.name, skipped: 'blind-injection-not-allowed' });
      continue;
    }
    const res = p.send();
    attempts.push({
      provider: p.name,
      ok: res.ok,
      status: res.status,
      error: res.error || res.stderr || null,
    });
    if (res.ok) return { ok: true, provider: p.name, attempts };
  }

  return { ok: false, provider: null, attempts };
}

module.exports = {
  CAPTURED_ENV,
  captureEnv,
  controllingTty,
  ancestry,
  findClaudePid,
  detect,
  makeContext,
  inject,
  have,
};
