'use strict';

// Exercises arm/disarm/timer against a sandboxed HOME so the real
// ~/.claude/idle-compactor is never touched.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN = path.resolve(__dirname, '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-test-'));
const TRANSCRIPT = path.join(SANDBOX, 'transcript.jsonl');

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  }
}

function env(extra) {
  return Object.assign({}, process.env, { HOME: SANDBOX, USERPROFILE: SANDBOX }, extra || {});
}

function runScript(script, input, extraEnv, argv) {
  return spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', script)].concat(argv || []), {
    input: input === undefined ? '' : JSON.stringify(input),
    encoding: 'utf8',
    env: env(extraEnv),
    timeout: 20000,
  });
}

function writeTranscript(tokens, opts) {
  const o = opts || {};
  const user = { type: 'user', message: { role: 'user', content: 'hi' } };
  if (!o.omitUserTimestamp) {
    user.timestamp = new Date(o.userTimestamp || Date.now()).toISOString();
  }
  const assistant = {
    type: 'assistant',
    message: {
      role: 'assistant',
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: Math.max(0, tokens - 10),
      },
    },
  };
  if (o.model) assistant.message.model = o.model;
  if (o.effort) assistant.effort = o.effort;
  const lines = [JSON.stringify(user), JSON.stringify(assistant)];
  if (o.sidechain) {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        message: {
          role: 'assistant',
          model: 'sidechain-model',
          usage: {
            input_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 5,
          },
        },
      })
    );
  }
  for (const extra of o.extraLines || []) lines.push(JSON.stringify(extra));
  fs.writeFileSync(TRANSCRIPT, lines.join('\n') + '\n');
}

function sessionState(sessionId) {
  const file = path.join(SANDBOX, '.claude', 'idle-compactor', 'sessions', sessionId + '.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function statePath(sessionId) {
  return path.join(SANDBOX, '.claude', 'idle-compactor', 'sessions', sessionId + '.json');
}

console.log('sandbox HOME: ' + SANDBOX + '\n');

// ---------------------------------------------------------------------------
console.log('transcript token accounting');
{
  const transcript = require(path.join(PLUGIN, 'scripts/lib/transcript.js'));
  writeTranscript(50000);
  check('sums input + cache_creation + cache_read', transcript.contextTokens(TRANSCRIPT) === 50000,
    String(transcript.contextTokens(TRANSCRIPT)));
  check('returns null for a missing transcript', transcript.contextTokens(TRANSCRIPT + '.nope') === null);
}

// ---------------------------------------------------------------------------
console.log('\ndefault threshold derivation');
{
  const config = require(path.join(PLUGIN, 'scripts/lib/config.js'));
  check('1h TTL -> 55 minutes', config.defaultMinutesFor('1h') === 55, String(config.defaultMinutesFor('1h')));
  check('5m TTL -> 4 minutes', config.defaultMinutesFor('5m') === 4, String(config.defaultMinutesFor('5m')));

  check(
    'keepalive derives 55 minutes on the 1h TTL',
    config.effectiveIdleMinutes({ idleAction: 'keepalive', cacheTtl: '1h', keepaliveGraceMinutes: 5 }) === 55,
    String(config.effectiveIdleMinutes({ idleAction: 'keepalive', cacheTtl: '1h', keepaliveGraceMinutes: 5 }))
  );
  check(
    'compact mode ignores keepaliveGraceMinutes',
    config.effectiveIdleMinutes({ idleAction: 'compact', cacheTtl: '1h', keepaliveGraceMinutes: 30 }) === 55,
    String(config.effectiveIdleMinutes({ idleAction: 'compact', cacheTtl: '1h', keepaliveGraceMinutes: 30 }))
  );
  check(
    'effectiveGraceMinutes follows mode',
    config.effectiveGraceMinutes({ idleAction: 'keepalive', cacheTtl: '1h', keepaliveGraceMinutes: 5 }) === 5 &&
      config.effectiveGraceMinutes({ idleAction: 'compact', cacheTtl: '1h' }) === 5
  );
}

// ---------------------------------------------------------------------------
console.log('\nkeepalive sentinel');
{
  const prompt = require(path.join(PLUGIN, 'scripts/lib/prompt.js'));
  check('keepaliveCommand returns the sentinel verbatim', prompt.keepaliveCommand() === prompt.KEEPALIVE_SENTINEL);
  check('sentinel is not a slash command', prompt.KEEPALIVE_SENTINEL[0] !== '/');
  check('sentinel is a single line', prompt.KEEPALIVE_SENTINEL.indexOf('\n') === -1);
}

// ---------------------------------------------------------------------------
console.log('\nping classification');
{
  const stats = require(path.join(PLUGIN, 'scripts/lib/stats.js'));
  check(
    'read-dominated usage classifies as a hit',
    stats.classifyPingUsage({ cache_read_input_tokens: 50000, cache_creation_input_tokens: 10 }) === 'hit'
  );
  check(
    'creation-dominated usage classifies as a miss',
    stats.classifyPingUsage({ cache_read_input_tokens: 10, cache_creation_input_tokens: 50000 }) === 'miss'
  );
  check('no usage classifies as null', stats.classifyPingUsage(null) === null);
  check(
    'all-zero usage classifies as null',
    stats.classifyPingUsage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) === null
  );
}

// ---------------------------------------------------------------------------
console.log('\narm gating');
{
  writeTranscript(500);
  const r = runScript('arm.js', {
    session_id: 'small-ctx',
    transcript_path: TRANSCRIPT,
    cwd: SANDBOX,
    hook_event_name: 'Stop',
  });
  check('exits 0 on a below-floor context', r.status === 0, r.stderr);
  check('does not arm a below-floor context', sessionState('small-ctx') === null);
}

{
  writeTranscript(500);
  const r = runScript(
    'arm.js',
    { session_id: 'no-floor', transcript_path: TRANSCRIPT, cwd: SANDBOX, hook_event_name: 'Stop' },
    { CLAUDE_IDLE_COMPACT_MIN_TOKENS: '0' }
  );
  const s = sessionState('no-floor');
  check('exits 0 with the floor removed', r.status === 0, r.stderr);
  check('a zero floor arms even a tiny context', !!s);
  if (s && s.timerPid) {
    try {
      process.kill(s.timerPid, 'SIGTERM');
    } catch (_) {
      /* already gone */
    }
  }
}

{
  writeTranscript(30000);
  const r = runScript(
    'arm.js',
    { session_id: 'raised-floor', transcript_path: TRANSCRIPT, cwd: SANDBOX, hook_event_name: 'Stop' },
    { CLAUDE_IDLE_COMPACT_MIN_TOKENS: '50000' }
  );
  check('exits 0 with a raised floor', r.status === 0, r.stderr);
  check('a raised floor blocks a mid-size context', sessionState('raised-floor') === null);
}

{
  writeTranscript(50000);
  const r = runScript('arm.js', {
    session_id: 'big-ctx',
    transcript_path: TRANSCRIPT,
    cwd: SANDBOX,
    hook_event_name: 'Stop',
  });
  const s = sessionState('big-ctx');
  check('exits 0 on an above-floor context', r.status === 0, r.stderr);
  check('writes session state', !!s);
  check('records a timer pid', !!(s && s.timerPid), s && String(s.timerPid));
  check('records an armId', !!(s && s.armId));
  check('defaults to a 55 minute window', !!s && s.idleMinutes === 55, s && String(s.idleMinutes));
  check('fireAt is armedAt + 55 min', !!s && s.fireAt - s.armedAt === 55 * 60 * 1000);
  check('records the absolute node path', !!s && s.nodePath === process.execPath);
  check('injects /compact', !!s && s.text === '/compact');
  check('mode defaults to compact', !!s && s.mode === 'compact', s && s.mode);
  check('pingCount defaults to 0', !!s && s.pingCount === 0, s && String(s.pingCount));
}

{
  const before = sessionState('big-ctx');
  const r = runScript('arm.js', {
    session_id: 'big-ctx',
    transcript_path: TRANSCRIPT,
    cwd: SANDBOX,
    hook_event_name: 'Stop',
  });
  const after = sessionState('big-ctx');
  check('re-arming exits 0', r.status === 0, r.stderr);
  check('re-arming mints a fresh armId', before.armId !== after.armId);
  check('re-arming kills the previous timer', !isAlive(before.timerPid), String(before.timerPid));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
console.log('\ndisarm');
{
  const before = sessionState('big-ctx');
  const r = runScript('disarm.js', {
    session_id: 'big-ctx',
    hook_event_name: 'UserPromptSubmit',
    prompt: 'hello',
  });
  check('exits 0', r.status === 0, r.stderr);
  check('removes session state', sessionState('big-ctx') === null);
  check('kills the timer', !isAlive(before.timerPid));
}

// ---------------------------------------------------------------------------
console.log('\ntimer decisions');

function seedState(id, overrides) {
  const now = Date.now();
  const record = Object.assign(
    {
      version: 1,
      armId: 'armid-' + id,
      sessionId: id,
      cwd: SANDBOX,
      transcriptPath: TRANSCRIPT,
      contextTokens: 50000,
      armedAt: now - 2000,
      fireAt: now - 1000,
      idleMinutes: 55,
      cacheTtl: '1h',
      allowBlindInjection: false,
      text: '/compact',
      nodePath: process.execPath,
      env: {}, // no providers -> injection is attempted but finds nothing
      tty: null,
      claudePid: process.pid,
      timerPid: null,
      fired: null,
    },
    overrides || {}
  );
  fs.mkdirSync(path.dirname(statePath(id)), { recursive: true });
  fs.writeFileSync(statePath(id), JSON.stringify(record, null, 2) + '\n');
  return record;
}

function runTimer(id, armId) {
  return spawnSync(process.execPath, [path.join(PLUGIN, 'scripts/timer.js'), statePath(id), armId], {
    encoding: 'utf8',
    env: env(),
    timeout: 20000,
  });
}

{
  const rec = seedState('fire-now');
  writeTranscript(50000);
  const r = runTimer('fire-now', rec.armId);
  const after = sessionState('fire-now');
  check('exits promptly when due', r.status === 0, r.stderr);
  check('records a fire attempt', !!(after && after.fired), JSON.stringify(after && after.fired));
  check('reports failure when no provider exists', !!after && after.fired.ok === false);
}

{
  const rec = seedState('wrong-armid');
  const r = runTimer('wrong-armid', 'some-other-armid');
  const after = sessionState('wrong-armid');
  check('exits 0 on an armId mismatch', r.status === 0, r.stderr);
  check('does not fire on an armId mismatch', !!after && after.fired === null);
}

{
  // Armed long ago, transcript written just now => the session was active.
  const rec = seedState('activity', { armedAt: Date.now() - 10 * 60 * 1000 });
  writeTranscript(50000);
  const r = runTimer('activity', rec.armId);
  const after = sessionState('activity');
  check('exits 0 when activity is detected', r.status === 0, r.stderr);
  check(
    'aborts on post-arm transcript activity',
    !!after && after.fired && after.fired.reason === 'activity-detected',
    JSON.stringify(after && after.fired)
  );
}

{
  // Claude Code's own away_summary recap lands mid-window and bumps the file's
  // mtime. The user never touched anything, so the timer must still fire.
  const rec = seedState('system-noise', { armedAt: Date.now() - 10 * 60 * 1000 });
  writeTranscript(50000, {
    userTimestamp: Date.now() - 11 * 60 * 1000,
    extraLines: [
      {
        type: 'system',
        subtype: 'away_summary',
        content: 'recap of what we were doing',
        timestamp: new Date().toISOString(),
        isMeta: false,
        userType: 'external',
      },
    ],
  });
  const r = runTimer('system-noise', rec.armId);
  const after = sessionState('system-noise');
  check('exits 0 on a system-only transcript write', r.status === 0, r.stderr);
  check(
    'does not treat a system entry as user activity',
    !!after && after.fired && after.fired.reason !== 'activity-detected',
    JSON.stringify(after && after.fired)
  );
  check(
    'proceeds to fire after a system-only write',
    !!after && after.fired && after.fired.ok === false,
    JSON.stringify(after && after.fired)
  );
}

{
  // No parseable timestamp on the newest user turn: we cannot tell whether the
  // user came back, so the conservative answer is to skip the compaction.
  const rec = seedState('stale-stamp', { armedAt: Date.now() - 10 * 60 * 1000 });
  writeTranscript(50000, { omitUserTimestamp: true });
  const r = runTimer('stale-stamp', rec.armId);
  const after = sessionState('stale-stamp');
  check('exits 0 when user activity is indeterminate', r.status === 0, r.stderr);
  check(
    'skips the fire when the last user turn cannot be dated',
    !!after && after.fired && after.fired.detail === 'indeterminate',
    JSON.stringify(after && after.fired)
  );
}

{
  const rec = seedState('dead-claude', { claudePid: 999999 });
  const r = runTimer('dead-claude', rec.armId);
  check('exits 0 when the claude process is gone', r.status === 0, r.stderr);
  check('cleans up state when the claude process is gone', sessionState('dead-claude') === null);
}

{
  const rec = seedState('not-yet', { fireAt: Date.now() + 60 * 60 * 1000 });
  const r = spawnSync(
    process.execPath,
    [path.join(PLUGIN, 'scripts/timer.js'), statePath('not-yet'), rec.armId],
    { encoding: 'utf8', env: env(), timeout: 3000 }
  );
  const after = sessionState('not-yet');
  check('keeps polling before the deadline', r.error && r.error.code === 'ETIMEDOUT');
  check('does not fire before the deadline', !!after && after.fired === null);
}

// ---------------------------------------------------------------------------
console.log('\nconfig CLI');

function cli(argv) {
  return spawnSync(process.execPath, [path.join(PLUGIN, 'scripts/config-cli.js')].concat(argv), {
    encoding: 'utf8',
    env: env(),
    // Pinned so per-repo settings key off the plugin repo no matter where the
    // suite was invoked from.
    cwd: PLUGIN,
    timeout: 20000,
  });
}

{
  check('status exits 0', cli(['status']).status === 0);
  check('off disables', /idle-compactor: OFF/.test(cli(['off']).stdout));
  check('on enables', /idle-compactor: ON/.test(cli(['on']).stdout));
  check('ttl 5m -> 4 minutes', /idle threshold: 4 min/.test(cli(['set', 'ttl', '5m']).stdout));
  check('ttl 1h -> 55 minutes', /idle threshold: 55 min/.test(cli(['set', 'ttl', '1h']).stdout));
  check('minutes 25 overrides', /idle threshold: 25 min \(explicit override\)/.test(cli(['set', 'minutes', '25']).stdout));
  check('ttl clears the override', /idle threshold: 55 min \(derived/.test(cli(['set', 'ttl', '1h']).stdout));
  check('rejects a bad ttl', cli(['set', 'ttl', '2h']).status === 1);
  check('rejects non-numeric minutes', cli(['set', 'minutes', 'abc']).status === 1);
  check('rejects an unknown command', cli(['wat']).status === 1);
  check('blind on', /blind injection: allowed/.test(cli(['blind', 'on']).stdout));
  check('blind off', /blind injection: blocked/.test(cli(['blind', 'off']).stdout));
  check('min-tokens', /minimum context: 40000/.test(cli(['set', 'min-tokens', '40000']).stdout));
  check('min-tokens accepts 0', /minimum context: 0/.test(cli(['set', 'min-tokens', '0']).stdout));
  check('min-tokens rejects a negative floor', cli(['set', 'min-tokens', '-1']).status === 1);
  check('--json emits parseable json', (() => {
    try {
      return JSON.parse(cli(['status', '--json']).stdout).ok === true;
    } catch (_) {
      return false;
    }
  })());
  check('test dry run exits 0', cli(['test']).status === 0);
  check('paths reports an absolute node binary', /node: \//.test(cli(['paths']).stdout), cli(['paths']).stdout);
  check('setup-done records the flag', /setup recorded/.test(cli(['setup-done']).stdout));

  check('action rejects a bad value', cli(['set', 'action', 'bogus']).status === 1);
  check(
    'action keepalive rejects under a 5m ttl',
    (() => {
      cli(['set', 'ttl', '5m']);
      const r = cli(['set', 'action', 'keepalive']);
      cli(['set', 'ttl', '1h']);
      return r.status === 1;
    })()
  );
  check(
    'ttl 5m rejects while in keepalive mode',
    (() => {
      cli(['set', 'action', 'keepalive']);
      const r = cli(['set', 'ttl', '5m']);
      cli(['set', 'action', 'compact']);
      return r.status === 1;
    })()
  );
  check('action keepalive shows the mode line', /mode:( +)keepalive/.test(cli(['set', 'action', 'keepalive']).stdout));
  check(
    'max-pings shows in the mode line',
    /mode:( +)keepalive \(max 5 pings\)/.test(cli(['set', 'max-pings', '5']).stdout)
  );
  check('max-pings rejects zero', cli(['set', 'max-pings', '0']).status === 1);
  check('max-pings rejects a negative value', cli(['set', 'max-pings', '-1']).status === 1);
  check('max-pings rejects non-numeric', cli(['set', 'max-pings', 'abc']).status === 1);
  check('action compact shows the mode line', /mode:( +)compact$/m.test(cli(['set', 'action', 'compact']).stdout));

  check('reset restores defaults', /idle threshold: 55 min/.test(cli(['reset']).stdout));
}

// ---------------------------------------------------------------------------
console.log('\ncompaction prompt');
{
  const promptFile = path.join(SANDBOX, 'prompt.md');
  fs.writeFileSync(promptFile, 'Focus on the API changes\nand keep the file list.\n');

  check('none by default', /compaction prompt: none/.test(cli(['prompt', 'show']).stdout));
  check('rejects a missing file', cli(['prompt', 'use', path.join(SANDBOX, 'nope.md')]).status === 1);

  const emptyFile = path.join(SANDBOX, 'empty.md');
  fs.writeFileSync(emptyFile, '   \n\n');
  check('rejects an empty file', cli(['prompt', 'use', emptyFile]).status === 1);

  const used = cli(['prompt', 'use', promptFile]).stdout;
  check('records a repo-scoped prompt', /compaction prompt: repo/.test(used), used);
  check(
    'flattens newlines into a single line',
    /would send: \/compact Focus on the API changes and keep the file list\./.test(used),
    used
  );

  writeTranscript(50000);
  runScript('arm.js', { session_id: 'p1', transcript_path: TRANSCRIPT, cwd: PLUGIN });
  const record = sessionState('p1');
  check(
    'arm bakes the prompt into the text it will type',
    !!record && /^\/compact Focus on the API changes and keep the file list\.$/.test(record.text),
    record && record.text
  );
  if (record && record.timerPid) {
    try {
      process.kill(record.timerPid);
    } catch (_) {
      /* already gone */
    }
  }

  check('clear removes it', /compaction prompt: none/.test(cli(['prompt', 'clear']).stdout));

  const userScoped = cli(['prompt', 'use', promptFile, '--user']).stdout;
  check('--user records a user-level prompt', /compaction prompt: user/.test(userScoped), userScoped);
  cli(['prompt', 'clear', '--user']);
  check('clear --user removes it', /compaction prompt: none/.test(cli(['prompt', 'show']).stdout));

  const longFile = path.join(SANDBOX, 'long.md');
  fs.writeFileSync(longFile, 'x'.repeat(1200));
  const longOut = cli(['prompt', 'use', longFile]).stdout;
  check('warns when the prompt exceeds the cap', /only the first 800/.test(longOut), longOut);

  const missingOut = (() => {
    fs.rmSync(longFile);
    return cli(['status']).stdout;
  })();
  check('status flags a prompt file that has gone missing', /FILE MISSING/.test(missingOut), missingOut);
  cli(['prompt', 'clear']);

  check(
    'a session with no prompt still sends a bare /compact',
    (() => {
      runScript('arm.js', { session_id: 'p2', transcript_path: TRANSCRIPT, cwd: PLUGIN });
      const bare = sessionState('p2');
      if (bare && bare.timerPid) {
        try {
          process.kill(bare.timerPid);
        } catch (_) {
          /* already gone */
        }
      }
      return !!bare && bare.text === '/compact';
    })()
  );
}

// ---------------------------------------------------------------------------
console.log('\nsession-start hook');
{
  const r = runScript('session-start.js', { session_id: 's1', hook_event_name: 'SessionStart', source: 'startup' });
  check('exits 0 when setup is already done', r.status === 0, r.stderr);
  // reset() above cleared setupCompleted, so the first-run notice should appear.
  let payload = null;
  try {
    payload = JSON.parse(r.stdout);
  } catch (_) {
    /* no output */
  }
  check('emits a first-run systemMessage', !!(payload && payload.systemMessage), r.stdout.slice(0, 200));
  check(
    'systemMessage names the 55 minute default',
    !!(payload && /55 minutes/.test(payload.systemMessage)),
    payload && payload.systemMessage
  );
  const ctx = payload && payload.hookSpecificOutput && payload.hookSpecificOutput.additionalContext;
  check('emits SessionStart additionalContext', !!ctx);
  check('setup asks for the idle threshold', !!ctx && /set ttl 1h/.test(ctx));
  check('setup asks for the context floor', !!ctx && /set min-tokens <N>/.test(ctx));
  check('setup asks both in one question call', !!ctx && /SINGLE AskUserQuestion call/.test(ctx));

  const saved = JSON.parse(
    fs.readFileSync(path.join(SANDBOX, '.claude', 'idle-compactor', 'config.json'), 'utf8')
  );
  check('records pluginRoot for the slash command', saved.pluginRoot === PLUGIN, saved.pluginRoot);
  check('records the hooks’ own node binary', saved.nodePath === process.execPath, saved.nodePath);

  cli(['setup-done']);
  const r2 = runScript('session-start.js', { session_id: 's1', hook_event_name: 'SessionStart', source: 'startup' });
  check('stays silent once setup is done', r2.stdout.trim() === '', r2.stdout);
}

// ---------------------------------------------------------------------------
console.log('\nmalformed input');
{
  const r = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts/arm.js')], {
    input: 'not json at all',
    encoding: 'utf8',
    env: env(),
    timeout: 20000,
  });
  check('arm survives a malformed payload', r.status === 0, r.stderr);

  const r2 = runScript('disarm.js', {});
  check('disarm survives a payload with no session_id', r2.status === 0, r2.stderr);
}

// ---------------------------------------------------------------------------
console.log('\nfire stats');
{
  // 'fire-now' and 'system-noise' (failed, no injection provider) and
  // 'activity' and 'stale-stamp' (skipped, activity-detected) all fired
  // earlier in this run; 'wrong-armid', 'dead-claude', and 'not-yet' never
  // called finish() so left no record.
  const before = JSON.parse(cli(['stats', '--json']).stdout).stats;
  check('counts every finish() as an attempt', before.totalAttempts === 4, JSON.stringify(before));
  check('classifies the no-provider fire as failed', before.failed === 2, JSON.stringify(before));
  check('classifies activity-detected as skipped, not failed', before.activitySkipped === 2, JSON.stringify(before));
  check('an unfired session records nothing', !before.sessions['wrong-armid']);
  check('a dead-claude session records nothing', !before.sessions['dead-claude']);
  check('a not-yet-due session records nothing', !before.sessions['not-yet']);

  const fireLogPath = path.join(SANDBOX, '.claude', 'idle-compactor', 'fires.log');
  const fireLines = fs
    .readFileSync(fireLogPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  function lastDetailFor(sessionId) {
    const matches = fireLines.filter((e) => e.sessionId === sessionId);
    return matches.length ? matches[matches.length - 1].detail : undefined;
  }
  check(
    "'system-noise' reached real injection, so detail is null",
    lastDetailFor('system-noise') === null,
    String(lastDetailFor('system-noise'))
  );
  check(
    "'stale-stamp' aborted with an indeterminate last user turn",
    lastDetailFor('stale-stamp') === 'indeterminate',
    String(lastDetailFor('stale-stamp'))
  );
  check(
    "'activity' aborted on a genuine, timestamped user turn",
    lastDetailFor('activity') === 'user-turn',
    String(lastDetailFor('activity'))
  );

  const shown = cli(['stats']).stdout;
  check('text output lists the failed session by id', /fire-now/.test(shown), shown);
  check('text output lists the skipped session by id', /activity/.test(shown), shown);
  check('text output reports zero autocompactions when nothing succeeded', /autocompactions: 0/.test(shown), shown);

  check('stats reset clears the log', /compaction stats cleared/.test(cli(['stats', 'reset']).stdout));
  const after = JSON.parse(cli(['stats', '--json']).stdout).stats;
  check('reset leaves no attempts', after.totalAttempts === 0, JSON.stringify(after));
  check('reset leaves no sessions', Object.keys(after.sessions).length === 0, JSON.stringify(after));
  check('stats with no fires says so', /no recorded fires yet/.test(cli(['stats']).stdout));

  check('rejects an unknown stats subcommand', cli(['stats', 'bogus']).status === 1);
}

// ---------------------------------------------------------------------------
console.log('\nlive session view');
{
  // Wipe first: 'off' clears every state file, so the empty-case assertion is
  // deterministic no matter what earlier blocks left behind.
  cli(['off']);
  check('reports an empty live view', /no live sessions/.test(cli(['stats', 'sessions']).stdout));

  const now = Date.now();
  seedState('live-ticking', {
    fireAt: now + 10 * 60 * 1000,
    timerPid: process.pid,
    claudePid: process.pid,
  });
  seedState('live-due', {
    fireAt: now - 5000,
    timerPid: process.pid,
    claudePid: process.pid,
  });
  seedState('live-ok', {
    timerPid: process.pid,
    fired: { at: now - 60 * 1000, ok: true, provider: 'tmux' },
  });
  seedState('live-skipped', {
    timerPid: process.pid,
    fired: { at: now - 120 * 1000, ok: false, reason: 'activity-detected', detail: 'user-turn' },
  });
  seedState('live-orphan', { claudePid: 999999, timerPid: 999999 });
  seedState('live-notimer', {
    fireAt: now + 10 * 60 * 1000,
    timerPid: null,
    claudePid: process.pid,
  });

  const r = cli(['stats', 'sessions', '--json']);
  check('stats sessions exits 0', r.status === 0, r.stderr);

  const view = JSON.parse(r.stdout);
  const by = {};
  for (const s of view.sessions) by[s.sessionId] = s;

  check('classifies a counting-down session', by['live-ticking'].status === 'counting-down',
    JSON.stringify(by['live-ticking']));
  check('reports time to compact', by['live-ticking'].dueInMs > 9 * 60 * 1000,
    String(by['live-ticking'].dueInMs));
  check('classifies an overdue session as due', by['live-due'].status === 'due',
    JSON.stringify(by['live-due']));
  check('gives a due session no countdown', by['live-due'].dueInMs === null,
    String(by['live-due'].dueInMs));
  check('classifies a successful fire', by['live-ok'].status === 'fired' && by['live-ok'].detail === 'ok',
    JSON.stringify(by['live-ok']));
  check('classifies an activity-skipped fire',
    by['live-skipped'].status === 'fired' && by['live-skipped'].detail === 'activity-skipped',
    JSON.stringify(by['live-skipped']));
  check('classifies a dead claude process as orphaned',
    by['live-orphan'].status === 'orphaned' && by['live-orphan'].detail === 'session-gone',
    JSON.stringify(by['live-orphan']));
  // An unrecorded timer pid is unknown, not dead: arm.js writes the record
  // before it knows the pid, so treating null as dead would libel a healthy arm.
  check('treats an unrecorded timer pid as still counting down',
    by['live-notimer'].status === 'counting-down' && by['live-notimer'].timerAlive === false,
    JSON.stringify(by['live-notimer']));

  const shown = cli(['stats', 'sessions']).stdout;
  check('text view names the counting-down state', /counting down/.test(shown), shown);
  check('text view names the orphaned state', /orphaned/.test(shown), shown);
  check('text view formats a countdown as minutes and seconds', /fires in \d+m \d\ds/.test(shown), shown);

  check('stats show carries the live block too', /live sessions:/.test(cli(['stats']).stdout));
  check('status carries the live block too', /live sessions:/.test(cli(['status']).stdout));
  check('rejects an unknown stats subcommand', cli(['stats', 'bogus']).status === 1);
}

// ---------------------------------------------------------------------------
console.log('\nkeepalive mode');
{
  const KEEPALIVE_SENTINEL = require(path.join(PLUGIN, 'scripts/lib/prompt.js')).KEEPALIVE_SENTINEL;

  function killIfSet(s) {
    if (s && s.timerPid) {
      try {
        process.kill(s.timerPid, 'SIGTERM');
      } catch (_) {
        /* already gone */
      }
    }
  }

  cli(['reset']);
  cli(['set', 'action', 'keepalive']);

  writeTranscript(50000);
  const r1 = runScript('arm.js', {
    session_id: 'ka-first',
    transcript_path: TRANSCRIPT,
    cwd: SANDBOX,
    hook_event_name: 'Stop',
  });
  const s1 = sessionState('ka-first');
  check('exits 0 arming the first keepalive ping', r1.status === 0, r1.stderr);
  check('mode is recorded as keepalive', !!s1 && s1.mode === 'keepalive', s1 && s1.mode);
  check('pingCount starts at 0', !!s1 && s1.pingCount === 0, s1 && String(s1.pingCount));
  check('injects the sentinel, not /compact', !!s1 && s1.text === KEEPALIVE_SENTINEL, s1 && s1.text);
  check('derives the keepalive cadence', !!s1 && s1.idleMinutes === 55, s1 && String(s1.idleMinutes));
  killIfSet(s1);

  // A confirmed ping: seed a "previous" record as timer.js would have left it
  // after successfully injecting the sentinel and Claude replying, then let
  // arm.js's own Stop handler — which fires for that reply exactly as it
  // would for any other turn — pick it up.
  writeTranscript(50000); // read-dominated usage: read=49990, creation=0 -> hit
  seedState('ka-confirm', {
    mode: 'keepalive',
    pingCount: 3,
    fired: { at: Date.now(), ok: true, provider: 'tmux' },
  });
  const r2 = runScript('arm.js', {
    session_id: 'ka-confirm',
    transcript_path: TRANSCRIPT,
    cwd: SANDBOX,
    hook_event_name: 'Stop',
  });
  const s2 = sessionState('ka-confirm');
  check('a confirmed ping re-arms', r2.status === 0, r2.stderr);
  check('pingCount carries forward incremented', !!s2 && s2.pingCount === 4, s2 && String(s2.pingCount));
  const pingLines = fs
    .readFileSync(path.join(SANDBOX, '.claude', 'idle-compactor', 'pings.log'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  check(
    'records a hit for the confirmed ping',
    pingLines.some((e) => e.sessionId === 'ka-confirm' && e.result === 'hit'),
    JSON.stringify(pingLines)
  );
  killIfSet(s2);

  // Reaching the cap stops the loop instead of re-arming.
  cli(['set', 'max-pings', '5']);
  writeTranscript(50000);
  seedState('ka-cap', {
    mode: 'keepalive',
    pingCount: 4,
    fired: { at: Date.now(), ok: true, provider: 'tmux' },
  });
  const r3 = runScript('arm.js', {
    session_id: 'ka-cap',
    transcript_path: TRANSCRIPT,
    cwd: SANDBOX,
    hook_event_name: 'Stop',
  });
  check('exhausting the cap exits 0', r3.status === 0, r3.stderr);
  check('does not re-arm once the cap is reached', sessionState('ka-cap') === null);
  cli(['set', 'max-pings', '12']);

  // A ping whose injection failed outright does not keep the loop going —
  // the next Stop just arms a fresh cycle instead of continuing the count.
  writeTranscript(50000);
  seedState('ka-failed', {
    mode: 'keepalive',
    pingCount: 1,
    fired: { at: Date.now(), ok: false, attempts: [] },
  });
  const r4 = runScript('arm.js', {
    session_id: 'ka-failed',
    transcript_path: TRANSCRIPT,
    cwd: SANDBOX,
    hook_event_name: 'Stop',
  });
  const s4 = sessionState('ka-failed');
  check('a failed ping does not carry the count forward', !!s4 && s4.pingCount === 0, s4 && String(s4.pingCount));
  killIfSet(s4);

  // disarm.js: the sentinel being submitted must not kill the loop...
  seedState('ka-disarm-own', { mode: 'keepalive', pingCount: 1 });
  const r5 = runScript('disarm.js', {
    session_id: 'ka-disarm-own',
    hook_event_name: 'UserPromptSubmit',
    prompt: KEEPALIVE_SENTINEL,
  });
  check('exits 0', r5.status === 0, r5.stderr);
  check('does not disarm its own ping', sessionState('ka-disarm-own') !== null);

  // ...but real activity in keepalive mode still disarms normally.
  seedState('ka-disarm-real', { mode: 'keepalive', pingCount: 2 });
  const r6 = runScript('disarm.js', {
    session_id: 'ka-disarm-real',
    hook_event_name: 'UserPromptSubmit',
    prompt: 'what does this function do?',
  });
  check('exits 0', r6.status === 0, r6.stderr);
  check('real activity still disarms a keepalive session', sessionState('ka-disarm-real') === null);

  // Sentinel-looking text alone is not enough without matching mode: defence
  // in depth against a stray coincidental match outside keepalive mode.
  seedState('ka-disarm-wrongmode', { mode: 'compact', pingCount: 0 });
  const r7 = runScript('disarm.js', {
    session_id: 'ka-disarm-wrongmode',
    hook_event_name: 'UserPromptSubmit',
    prompt: KEEPALIVE_SENTINEL,
  });
  check('exits 0', r7.status === 0, r7.stderr);
  check(
    'sentinel text alone does not suppress disarm outside keepalive mode',
    sessionState('ka-disarm-wrongmode') === null
  );

  cli(['reset']);
}

// ---------------------------------------------------------------------------
console.log('\ntoken savings tracking');
{
  const transcript = require(path.join(PLUGIN, 'scripts/lib/transcript.js'));

  const FIRES_LOG = path.join(SANDBOX, '.claude', 'idle-compactor', 'fires.log');
  const PINGS_LOG = path.join(SANDBOX, '.claude', 'idle-compactor', 'pings.log');

  function killTimer(pid) {
    if (!pid) return;
    try {
      process.kill(pid, 'SIGTERM');
    } catch (_) {
      /* already gone */
    }
  }

  // Simulates what timer.js leaves behind after successfully injecting a
  // keepalive ping, without going through the real detached-timer/inject
  // machinery, so a chain can be advanced deterministically in-test.
  function markFired(sessionId, outcome) {
    const p = statePath(sessionId);
    const record = JSON.parse(fs.readFileSync(p, 'utf8'));
    record.fired = Object.assign({ at: Date.now() }, outcome);
    fs.writeFileSync(p, JSON.stringify(record, null, 2) + '\n');
    return record;
  }

  function readRawLog(p) {
    try {
      return fs
        .readFileSync(p, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
    } catch (_) {
      return [];
    }
  }

  function appendFireRow(obj) {
    fs.mkdirSync(path.dirname(FIRES_LOG), { recursive: true });
    fs.appendFileSync(FIRES_LOG, JSON.stringify(obj) + '\n');
  }

  function appendPingRow(obj) {
    fs.mkdirSync(path.dirname(PINGS_LOG), { recursive: true });
    fs.appendFileSync(PINGS_LOG, JSON.stringify(obj) + '\n');
  }

  // Runs code against the real stats.js module inside a freshly spawned,
  // HOME-sandboxed process (mirroring cli()/runScript()) so tests that call
  // stats.record()/recordPing() directly never touch the real
  // ~/.claude/idle-compactor. `code` must write its result to stdout via
  // process.stdout.write(JSON.stringify(...)).
  function statsCall(code) {
    const script = 'const stats = require(' + JSON.stringify(path.join(PLUGIN, 'scripts/lib/stats.js')) + ');\n' + code;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: env(), timeout: 20000 });
    if (r.status !== 0) return { __error: r.stderr };
    try {
      return JSON.parse(r.stdout);
    } catch (_) {
      return { __error: 'unparseable stdout: ' + r.stdout };
    }
  }

  // Case 1: sidechain entries must not poison lastAssistantInfo/contextTokens.
  writeTranscript(50000, { model: 'claude-sonnet-5', sidechain: true });
  check(
    'contextTokens ignores a trailing sidechain entry',
    transcript.contextTokens(TRANSCRIPT) === 50000,
    String(transcript.contextTokens(TRANSCRIPT))
  );
  check(
    'lastAssistantInfo().model ignores a trailing sidechain entry',
    transcript.lastAssistantInfo(TRANSCRIPT) &&
      transcript.lastAssistantInfo(TRANSCRIPT).model === 'claude-sonnet-5',
    JSON.stringify(transcript.lastAssistantInfo(TRANSCRIPT))
  );

  // Case 2: lastAssistantInfo returns null with no usage block at all.
  fs.writeFileSync(TRANSCRIPT, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');
  check(
    'lastAssistantInfo is null when the transcript has no usage block',
    transcript.lastAssistantInfo(TRANSCRIPT) === null
  );

  // Case 3: effort absent -> null (older-build transcripts).
  writeTranscript(40000);
  {
    const info = transcript.lastAssistantInfo(TRANSCRIPT);
    check('effort is null when absent from the transcript', !!info && info.effort === null, JSON.stringify(info));
  }

  // Case 4: arm.js stamps model/effort/contextTokens/chainId into state.
  writeTranscript(50000, { model: 'claude-opus-4-8', effort: 'high' });
  {
    const r = runScript('arm.js', {
      session_id: 'stamp-identity',
      transcript_path: TRANSCRIPT,
      cwd: SANDBOX,
      hook_event_name: 'Stop',
    });
    const s = sessionState('stamp-identity');
    check('arm exits 0 stamping identity', r.status === 0, r.stderr);
    check('state records the model', !!s && s.model === 'claude-opus-4-8', s && s.model);
    check('state records the effort', !!s && s.effort === 'high', s && s.effort);
    check('state records contextTokens', !!s && s.contextTokens === 50000, s && String(s.contextTokens));
    check(
      'state records a non-empty chainId',
      !!s && typeof s.chainId === 'string' && s.chainId.length > 0,
      s && s.chainId
    );
    killTimer(s && s.timerPid);
  }

  cli(['set', 'action', 'keepalive']);

  // Case 5: chainId is carried across a confirmed re-arm.
  writeTranscript(50000);
  {
    runScript('arm.js', {
      session_id: 'chain-carry',
      transcript_path: TRANSCRIPT,
      cwd: SANDBOX,
      hook_event_name: 'Stop',
    });
    const before = sessionState('chain-carry');
    killTimer(before && before.timerPid);
    markFired('chain-carry', { ok: true });
    const r = runScript('arm.js', {
      session_id: 'chain-carry',
      transcript_path: TRANSCRIPT,
      cwd: SANDBOX,
      hook_event_name: 'Stop',
    });
    const after = sessionState('chain-carry');
    check('re-arm exits 0 (chain carry)', r.status === 0, r.stderr);
    check(
      'chainId is carried forward across a confirmed re-arm',
      !!before && !!after && after.chainId === before.chainId,
      JSON.stringify({ before: before && before.chainId, after: after && after.chainId })
    );
    check('pingCount increments on the carried chain', !!after && after.pingCount === 1, after && String(after.pingCount));
    killTimer(after && after.timerPid);
  }

  // Case 6: chainId resets when the chain breaks (mode flips mid-chain, §3.1).
  writeTranscript(50000);
  {
    runScript('arm.js', {
      session_id: 'chain-break',
      transcript_path: TRANSCRIPT,
      cwd: SANDBOX,
      hook_event_name: 'Stop',
    });
    const before = sessionState('chain-break');
    killTimer(before && before.timerPid);
    markFired('chain-break', { ok: true });
    cli(['set', 'action', 'compact']);
    const r = runScript('arm.js', {
      session_id: 'chain-break',
      transcript_path: TRANSCRIPT,
      cwd: SANDBOX,
      hook_event_name: 'Stop',
    });
    const after = sessionState('chain-break');
    check('re-arm exits 0 (chain break)', r.status === 0, r.stderr);
    check(
      'chainId differs when the mode flips mid-chain',
      !!before && !!after && after.chainId !== before.chainId,
      JSON.stringify({ before: before && before.chainId, after: after && after.chainId })
    );
    check('pingCount resets to 0 when the chain breaks', !!after && after.pingCount === 0, after && String(after.pingCount));
    killTimer(after && after.timerPid);
  }

  // Case 7: record() with no meta writes exactly today's legacy key set.
  cli(['stats', 'reset']);
  {
    const line = statsCall(
      "stats.record('meta-omitted', { ok: true, reason: null, detail: null });\n" +
        'const rows = stats.readAll();\n' +
        'process.stdout.write(JSON.stringify(rows[rows.length - 1]));'
    );
    check(
      'record() with no meta writes exactly {at, sessionId, ok, reason, detail}',
      line &&
        !line.__error &&
        Object.keys(line).sort().join(',') === ['at', 'detail', 'ok', 'reason', 'sessionId'].sort().join(','),
      JSON.stringify(line)
    );
  }

  // Case 8: recordPing() hit records measured tokens from cache_read_input_tokens.
  {
    const line = statsCall(
      "stats.recordPing('ping-hit-case', 'hit', { chainId: 'c8', model: 'claude-sonnet-5', effort: 'xhigh', usage: { cache_read_input_tokens: 50000, cache_creation_input_tokens: 10 } });\n" +
        'const rows = stats.readPings();\n' +
        'process.stdout.write(JSON.stringify(rows[rows.length - 1]));'
    );
    check('recordPing hit records the measured cache_read_input_tokens value', !!line && line.tokens === 50000, JSON.stringify(line));
    check('recordPing hit basis is measured', !!line && line.basis === 'measured', JSON.stringify(line));
  }

  // Case 9: recordPing() miss records zero protected, carries cacheCreationTokens through.
  {
    const line = statsCall(
      "stats.recordPing('ping-miss-case', 'miss', { chainId: 'c9', usage: { cache_read_input_tokens: 5, cache_creation_input_tokens: 40000 } });\n" +
        'const rows = stats.readPings();\n' +
        'process.stdout.write(JSON.stringify(rows[rows.length - 1]));'
    );
    check('recordPing miss records zero protected tokens', !!line && line.tokens === 0, JSON.stringify(line));
    check('recordPing miss carries cacheCreationTokens through verbatim', !!line && line.cacheCreationTokens === 40000, JSON.stringify(line));
  }

  // Case 10: THE load-bearing assertion — a chain collapses to its max, not its sum.
  cli(['stats', 'reset']);
  {
    const chainId = 'chain-10';
    [100, 900, 300, 900, 200].forEach((tok, i) => {
      appendPingRow({
        at: 10000 + i,
        sessionId: 'sess-10',
        result: 'hit',
        chainId,
        tokens: tok,
        model: 'claude-sonnet-5',
        effort: 'xhigh',
        basis: 'measured',
      });
    });
    const savings = JSON.parse(cli(['stats', '--json']).stdout).savings;
    const events = JSON.parse(cli(['log', '--json']).stdout).events;
    const event = events.find((e) => e.chainKey === 'sess-10:' + chainId);
    check('a five-ping chain collapses to one event', !!event, JSON.stringify(events));
    check('the event value is the chain max, not the sum', !!event && event.tokens === 900, event && String(event.tokens));
    check('the event counts all five pings', !!event && event.pings === 5, event && String(event.pings));
    check(
      'summarizeSavings().tokensProtected is the max (900), explicitly not the sum (2400)',
      savings.tokensProtected === 900,
      String(savings.tokensProtected)
    );
  }

  // Case 11: two distinct chainIds in one session stay separate events.
  cli(['stats', 'reset']);
  {
    appendPingRow({ at: 11000, sessionId: 'sess-11', result: 'hit', chainId: 'chain-11a', tokens: 500, model: 'claude-sonnet-5', basis: 'measured' });
    appendPingRow({ at: 11001, sessionId: 'sess-11', result: 'hit', chainId: 'chain-11b', tokens: 700, model: 'claude-sonnet-5', basis: 'measured' });
    const savings = JSON.parse(cli(['stats', '--json']).stdout).savings;
    check('two distinct chainIds yield two events', savings.events === 2, String(savings.events));
    check('tokensProtected sums the two chain maxima', savings.tokensProtected === 1200, String(savings.tokensProtected));
  }

  // Case 12: a chain of only misses is an empty chain, not a zero-token event.
  cli(['stats', 'reset']);
  {
    appendPingRow({ at: 12000, sessionId: 'sess-12', result: 'miss', chainId: 'chain-12', tokens: 0, cacheCreationTokens: 10000, model: 'claude-sonnet-5', basis: 'measured' });
    appendPingRow({ at: 12001, sessionId: 'sess-12', result: 'miss', chainId: 'chain-12', tokens: 0, cacheCreationTokens: 12000, model: 'claude-sonnet-5', basis: 'measured' });
    const savings = JSON.parse(cli(['stats', '--json']).stdout).savings;
    check('an all-miss chain reports zero savings events', savings.events === 0, String(savings.events));
    check('an all-miss chain is counted as an empty chain', savings.emptyChains === 1, String(savings.emptyChains));
  }

  // Case 13: rows with no chainId (pre-upgrade) do not merge.
  cli(['stats', 'reset']);
  {
    appendPingRow({ at: 13000, sessionId: 'sess-13', result: 'hit', tokens: 300, model: 'claude-sonnet-5', basis: 'measured' });
    appendPingRow({ at: 13001, sessionId: 'sess-13', result: 'hit', tokens: 400, model: 'claude-sonnet-5', basis: 'measured' });
    const savings = JSON.parse(cli(['stats', '--json']).stdout).savings;
    check('legacy ping rows with no chainId do not merge into one event', savings.events === 2, String(savings.events));
  }

  // Case 14: keepalive-exhausted is excluded from savings but still counted by summarize().ok.
  cli(['stats', 'reset']);
  {
    appendFireRow({
      at: 14000,
      sessionId: 'sess-14',
      ok: true,
      reason: 'keepalive-exhausted',
      detail: 'pings:12',
      mode: 'keepalive',
      chainId: 'chain-14',
      tokens: 50000,
      model: 'claude-sonnet-5',
    });
    const savings = JSON.parse(cli(['stats', '--json']).stdout).savings;
    const legacy = JSON.parse(cli(['stats', '--json']).stdout).stats;
    check('summarizeSavings excludes a keepalive-exhausted row', savings.events === 0, String(savings.events));
    check(
      "summarize().ok still counts it, pinning the deliberate divergence from summarizeSavings()",
      legacy.ok === 1,
      String(legacy.ok)
    );
  }

  // Case 15: a disarmed arm (never fired) emits nothing to fires.log.
  cli(['stats', 'reset']);
  writeTranscript(50000);
  {
    const r = runScript('arm.js', { session_id: 'sess-15', transcript_path: TRANSCRIPT, cwd: SANDBOX, hook_event_name: 'Stop' });
    check('arm exits 0 (case 15 setup)', r.status === 0, r.stderr);
    const s = sessionState('sess-15');
    killTimer(s && s.timerPid);
    runScript('disarm.js', { session_id: 'sess-15', hook_event_name: 'UserPromptSubmit', prompt: 'hello there' });
    const fires = readRawLog(FIRES_LOG);
    check('disarming an armed session before it fires writes no fires.log line', !fires.some((e) => e.sessionId === 'sess-15'), JSON.stringify(fires));
  }

  // Case 16: disarm.js writes no savings row on a chain close (§2.5 regression guard).
  cli(['set', 'action', 'keepalive']);
  cli(['stats', 'reset']);
  writeTranscript(50000);
  {
    runScript('arm.js', { session_id: 'sess-16', transcript_path: TRANSCRIPT, cwd: SANDBOX, hook_event_name: 'Stop' });
    let s = sessionState('sess-16');
    killTimer(s && s.timerPid);
    markFired('sess-16', { ok: true });
    runScript('arm.js', { session_id: 'sess-16', transcript_path: TRANSCRIPT, cwd: SANDBOX, hook_event_name: 'Stop' });
    s = sessionState('sess-16');
    killTimer(s && s.timerPid);
    const beforeFires = readRawLog(FIRES_LOG).length;
    const beforePings = readRawLog(PINGS_LOG).length;
    runScript('disarm.js', { session_id: 'sess-16', hook_event_name: 'UserPromptSubmit', prompt: 'ok thanks' });
    check('disarm.js on a live keepalive chain writes no fires.log line', readRawLog(FIRES_LOG).length === beforeFires);
    check('disarm.js on a live keepalive chain writes no pings.log line', readRawLog(PINGS_LOG).length === beforePings);
    check('disarm.js removes the state file', sessionState('sess-16') === null);
  }
  cli(['set', 'action', 'compact']);

  // Case 17: byModel aggregates events/tokens per model; a null model lands under (unknown).
  cli(['stats', 'reset']);
  {
    appendPingRow({ at: 17000, sessionId: 's17a', result: 'hit', chainId: 'c17a', tokens: 1000, model: 'claude-sonnet-5', basis: 'measured' });
    appendPingRow({ at: 17001, sessionId: 's17b', result: 'hit', chainId: 'c17b', tokens: 2000, model: 'claude-sonnet-5', basis: 'measured' });
    appendFireRow({ at: 17002, sessionId: 's17c', ok: true, reason: null, detail: null, mode: 'compact', chainId: 'c17c', tokens: 3000, model: 'claude-opus-4-8' });
    appendFireRow({ at: 17003, sessionId: 's17d', ok: true, reason: null, detail: null, mode: 'compact', chainId: 'c17d', tokens: 4000, model: null });
    const savings = JSON.parse(cli(['stats', '--json']).stdout).savings;
    check(
      'byModel aggregates the first model (two chains)',
      !!savings.byModel['claude-sonnet-5'] && savings.byModel['claude-sonnet-5'].events === 2 && savings.byModel['claude-sonnet-5'].tokens === 3000,
      JSON.stringify(savings.byModel)
    );
    check(
      'byModel aggregates the second model separately',
      !!savings.byModel['claude-opus-4-8'] && savings.byModel['claude-opus-4-8'].events === 1 && savings.byModel['claude-opus-4-8'].tokens === 3000,
      JSON.stringify(savings.byModel)
    );
    check(
      'a null model lands under (unknown)',
      !!savings.byModel['(unknown)'] && savings.byModel['(unknown)'].events === 1 && savings.byModel['(unknown)'].tokens === 4000,
      JSON.stringify(savings.byModel)
    );
  }

  // Case 18: old log lines with no tokens key abstain rather than counting as zero.
  cli(['stats', 'reset']);
  {
    appendFireRow({ at: 18000, sessionId: 's18', ok: true, reason: null, detail: null });
    const savings = JSON.parse(cli(['stats', '--json']).stdout).savings;
    check('a legacy row with no tokens key increments eventsMissingTokens', savings.eventsMissingTokens === 1, String(savings.eventsMissingTokens));
    check('a legacy row with no tokens key does not add to tokensProtected', savings.tokensProtected === 0, String(savings.tokensProtected));
  }

  // Case 19: log with nothing recorded prints the empty-state message.
  cli(['stats', 'reset']);
  check('log with nothing recorded prints the empty message', /no idle compaction events recorded yet/.test(cli(['log']).stdout));

  // Case 20: log returns at most 10 chain events, newest first by lastAt.
  cli(['stats', 'reset']);
  {
    for (let i = 0; i < 13; i++) {
      appendFireRow({ at: 20000 + i, sessionId: 'sess-20-' + i, ok: true, reason: null, detail: null, mode: 'compact', chainId: 'c20-' + i, tokens: 100 + i, model: 'claude-sonnet-5' });
    }
    const events = JSON.parse(cli(['log', '--json']).stdout).events;
    check('log returns at most 10 events', events.length === 10, String(events.length));
    check(
      'log is ordered newest first by lastAt',
      events.length === 10 && events[0].lastAt === 20012 && events[9].lastAt === 20003,
      JSON.stringify(events.map((e) => e.lastAt))
    );
  }

  // Case 21: log shows x<n> only for multi-ping chains.
  cli(['stats', 'reset']);
  {
    for (let i = 0; i < 5; i++) {
      appendPingRow({ at: 21000 + i, sessionId: 'sess-21a', result: 'hit', chainId: 'c21a', tokens: 100 + i, model: 'claude-sonnet-5' });
    }
    appendFireRow({ at: 21100, sessionId: 'sess-21b', ok: true, reason: null, detail: null, mode: 'compact', chainId: 'c21b', tokens: 5000, model: 'claude-sonnet-5' });
    const events = JSON.parse(cli(['log', '--json']).stdout).events;
    const chainA = events.find((e) => e.sessionId === 'sess-21a');
    const chainB = events.find((e) => e.sessionId === 'sess-21b');
    check('a 5-ping chain has pings === 5', !!chainA && chainA.pings === 5, chainA && String(chainA.pings));
    check('a compact fire has pings === 1', !!chainB && chainB.pings === 1, chainB && String(chainB.pings));
    const text = cli(['log']).stdout;
    const lineA = text.split('\n').find((l) => l.indexOf('sess-21a') !== -1);
    const lineB = text.split('\n').find((l) => l.indexOf('sess-21b') !== -1);
    check('log renders x5 for the 5-ping chain', !!lineA && /x5\s*$/.test(lineA), lineA);
    check('log renders no ping-count column for the compact fire', !!lineB && !/x\d+\s*$/.test(lineB), lineB);
  }

  // Case 22: log <number> bounds — log 3 returns 3, log 0 and log 500 exit 1.
  cli(['stats', 'reset']);
  {
    for (let i = 0; i < 5; i++) {
      appendFireRow({ at: 22000 + i, sessionId: 'sess-22-' + i, ok: true, reason: null, detail: null, mode: 'compact', chainId: 'c22-' + i, tokens: 100, model: 'claude-sonnet-5' });
    }
    const events = JSON.parse(cli(['log', '3', '--json']).stdout).events;
    check('log 3 returns 3 events', events.length === 3, String(events.length));
    check('log 0 exits 1', cli(['log', '0']).status === 1);
    check('log 500 exits 1', cli(['log', '500']).status === 1);
  }

  // Case 23: log all shows raw rows, including failures and individual pings a chain collapses.
  cli(['stats', 'reset']);
  {
    appendFireRow({ at: 23000, sessionId: 'sess-23-fail', ok: false, reason: 'inject-failed', detail: 'no-provider' });
    for (let i = 0; i < 3; i++) {
      appendPingRow({ at: 23100 + i, sessionId: 'sess-23-chain', result: 'hit', chainId: 'c23', tokens: 100 + i, model: 'claude-sonnet-5' });
    }
    const all = JSON.parse(cli(['log', 'all', '--json']).stdout).events;
    check('log all includes a failed row that plain log omits', all.some((e) => e.sessionId === 'sess-23-fail'), JSON.stringify(all));
    const plain = JSON.parse(cli(['log', '--json']).stdout).events;
    check('plain log omits the failed row', !plain.some((e) => e.sessionId === 'sess-23-fail'), JSON.stringify(plain));
    check(
      'log all includes individual pings from a chain that log collapses',
      all.filter((e) => e.sessionId === 'sess-23-chain').length === 3,
      JSON.stringify(all)
    );
  }

  // Case 24: log --json exits 0 and parses.
  {
    const r = cli(['log', '--json']);
    check('log --json exits 0', r.status === 0, r.stderr);
    check(
      'log --json parses',
      (() => {
        try {
          JSON.parse(r.stdout);
          return true;
        } catch (_) {
          return false;
        }
      })()
    );
  }

  // Case 25: stats prints the savings block when events exist, the empty line otherwise, never the old note.
  cli(['stats', 'reset']);
  {
    appendFireRow({ at: 25000, sessionId: 'sess-25', ok: true, reason: null, detail: null, mode: 'compact', chainId: 'c25', tokens: 8000, model: 'claude-sonnet-5' });
    const withEvents = cli(['stats']).stdout;
    check('stats prints the savings block when events exist', /idle events:/.test(withEvents) && /tokens protected:/.test(withEvents), withEvents);
    check('stats never prints the old double-counting note', !/note:/.test(withEvents), withEvents);

    cli(['stats', 'reset']);
    const noEvents = cli(['stats']).stdout;
    check('stats prints the empty-savings line when none exist', /no token-savings events recorded yet/.test(noEvents), noEvents);
    check('stats (empty) never prints the old double-counting note', !/note:/.test(noEvents), noEvents);
  }

  // Case 26: stats reset clears pings.log too.
  {
    appendFireRow({ at: 26000, sessionId: 'sess-26', ok: true, reason: null, detail: null, mode: 'compact', chainId: 'c26', tokens: 9000, model: 'claude-sonnet-5' });
    appendPingRow({ at: 26001, sessionId: 'sess-26', result: 'hit', chainId: 'c26', tokens: 500, model: 'claude-sonnet-5' });
    check('stats reset reports cleared', /compaction stats cleared/.test(cli(['stats', 'reset']).stdout));
    check('stats reset removes fires.log', !fs.existsSync(FIRES_LOG));
    check('stats reset removes pings.log', !fs.existsSync(PINGS_LOG));
    const savings = JSON.parse(cli(['stats', '--json']).stdout).savings;
    check('stats reset leaves summarizeSavings with zero events', savings.events === 0, String(savings.events));
  }

  cli(['stats', 'reset']);
}

// ---------------------------------------------------------------------------
console.log('\nrecorded plugin root');
{
  const CONFIG = path.join(SANDBOX, '.claude', 'idle-compactor', 'config.json');
  const readCfg = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const patchCfg = (patch) =>
    fs.writeFileSync(CONFIG, JSON.stringify(Object.assign(readCfg(), patch), null, 2));

  // A second copy of the plugin standing in for a superseded install-cache
  // version: enough of a tree that the usable() check passes.
  const oldCopy = path.join(SANDBOX, 'plugin-0.1.0');
  fs.mkdirSync(path.join(oldCopy, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(oldCopy, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(oldCopy, 'scripts', 'config-cli.js'), '');
  fs.writeFileSync(
    path.join(oldCopy, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'idle-compactor', version: '0.1.0' })
  );

  runScript('session-start.js', { session_id: 'root-probe', source: 'startup' });
  check('session start records the running root', readCfg().pluginRoot === PLUGIN, readCfg().pluginRoot);
  check('session start records the running version', /^\d+\.\d+\.\d+$/.test(readCfg().pluginVersion || ''), readCfg().pluginVersion);

  patchCfg({ pluginRoot: oldCopy, pluginVersion: '0.1.0' });
  runScript('session-start.js', { session_id: 'root-probe', source: 'startup' });
  check('a newer copy reclaims a root recorded by an older one', readCfg().pluginRoot === PLUGIN, readCfg().pluginRoot);

  const newerCopy = path.join(SANDBOX, 'plugin-99.0.0');
  fs.mkdirSync(path.join(newerCopy, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(newerCopy, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(newerCopy, 'scripts', 'config-cli.js'), '');
  fs.writeFileSync(
    path.join(newerCopy, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'idle-compactor', version: '99.0.0' })
  );
  patchCfg({ pluginRoot: newerCopy, pluginVersion: '99.0.0' });
  runScript('session-start.js', { session_id: 'root-probe', source: 'startup' });
  check(
    'an older copy cannot overwrite a newer recorded root',
    readCfg().pluginRoot === newerCopy,
    readCfg().pluginRoot
  );

  // The pre-fix configs in the wild have a root but no version at all.
  patchCfg({ pluginRoot: oldCopy, pluginVersion: undefined });
  runScript('session-start.js', { session_id: 'root-probe', source: 'startup' });
  check(
    'a root recorded without a version is repaired',
    readCfg().pluginRoot === PLUGIN,
    readCfg().pluginRoot
  );

  patchCfg({ pluginRoot: path.join(SANDBOX, 'deleted-copy'), pluginVersion: '99.0.0' });
  runScript('session-start.js', { session_id: 'root-probe', source: 'startup' });
  check(
    'a recorded root that no longer exists is reclaimed',
    readCfg().pluginRoot === PLUGIN,
    readCfg().pluginRoot
  );

  patchCfg({ pluginRoot: path.join(SANDBOX, 'deleted-copy') });
  const paths = cli(['paths']).stdout;
  check('paths falls back to the running copy when the recorded root is gone', paths.includes('root: ' + PLUGIN), paths);

  patchCfg({ pluginRoot: newerCopy, pluginVersion: '99.0.0' });
  check('paths honours a recorded root that still exists', cli(['paths']).stdout.includes('root: ' + newerCopy));

  runScript('session-start.js', { session_id: 'root-probe', source: 'startup' });
}

// ---------------------------------------------------------------------------
console.log('\ninjection providers');
{
  const inject = require(path.join(PLUGIN, 'scripts', 'lib', 'inject.js'));

  check(
    'herdr pane id is captured from the environment',
    inject.captureEnv({ HERDR_PANE_ID: 'p7', HERDR_SOCKET_PATH: '/s.sock' }).HERDR_PANE_ID === 'p7'
  );
  check(
    'no herdr pane id means no herdr provider',
    !inject.detect(inject.makeContext({ env: {} })).some((p) => p.name === 'herdr')
  );

  // The Windows providers cannot be exercised here, but they must not leak
  // into the candidate list on the platforms that can run this suite.
  if (process.platform !== 'win32') {
    const elsewhere = inject.detect(inject.makeContext({ env: {}, terminalPid: 1234 }));
    check(
      'windows providers stay off non-windows platforms',
      !elsewhere.some((p) => p.name === 'windows-console' || p.name === 'windows-sendkeys')
    );

    // A stub binary stands in for herdr so the exact argv can be asserted.
    const stub = (name, body) => {
      const file = path.join(SANDBOX, name);
      fs.writeFileSync(file, '#!/bin/sh\n' + body);
      fs.chmodSync(file, 0o755);
      return file;
    };
    const argvLog = path.join(SANDBOX, 'herdr-argv.txt');
    const bin = stub(
      'fake-herdr',
      'printf "%s " "$@" >> ' + JSON.stringify(argvLog) + '\nprintf "\\n" >> ' +
        JSON.stringify(argvLog) + '\nexit 0\n'
    );

    const ctx = inject.makeContext({
      env: { HERDR_PANE_ID: 'w1:t2:p3', HERDR_BIN_PATH: bin },
      text: '/compact keep the plan',
    });
    const found = inject.detect(ctx);
    const herdr = found.find((p) => p.name === 'herdr');
    check('herdr is detected from HERDR_PANE_ID plus HERDR_BIN_PATH', !!herdr);
    check('herdr is targeted, not blind', !!herdr && herdr.blind === false);
    check('herdr is tried ahead of every other provider', !!found[0] && found[0].name === 'herdr');

    const sent = herdr.send();
    const argv = fs.readFileSync(argvLog, 'utf8').trim();
    check(
      'herdr submits through `pane run <id> <text>`',
      sent.ok && argv === 'pane run w1:t2:p3 /compact keep the plan',
      JSON.stringify(argv)
    );

    const fallbackLog = path.join(SANDBOX, 'herdr-fallback.txt');
    const flaky = stub(
      'fake-herdr-flaky',
      'printf "%s " "$@" >> ' + JSON.stringify(fallbackLog) + '\nprintf "\\n" >> ' +
        JSON.stringify(fallbackLog) + '\nif [ "$2" = "run" ]; then exit 3; fi\nexit 0\n'
    );
    const flakyCtx = inject.makeContext({
      env: { HERDR_PANE_ID: 'p9', HERDR_BIN_PATH: flaky },
      text: '/compact',
    });
    const flakyRes = inject.detect(flakyCtx).find((p) => p.name === 'herdr').send();
    const steps = fs
      .readFileSync(fallbackLog, 'utf8')
      .trim()
      .split('\n')
      .map((s) => s.trim());
    check(
      'herdr falls back to send-text then send-keys when `pane run` fails',
      flakyRes.ok &&
        steps.length === 3 &&
        steps[0] === 'pane run p9 /compact' &&
        steps[1] === 'pane send-text p9 /compact' &&
        steps[2] === 'pane send-keys p9 enter',
      JSON.stringify(steps)
    );

    const missing = inject.makeContext({
      env: { HERDR_PANE_ID: 'p1', HERDR_BIN_PATH: path.join(SANDBOX, 'no-such-herdr') },
    });
    check(
      'a bad HERDR_BIN_PATH falls through to the PATH lookup',
      !inject.detect(missing).some((p) => p.name === 'herdr') || inject.have('herdr')
    );
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
