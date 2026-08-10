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
  const lines = [
    JSON.stringify(user),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: Math.max(0, tokens - 10),
        },
      },
    }),
  ];
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
  check('1h TTL -> 59 minutes', config.defaultMinutesFor('1h') === 59, String(config.defaultMinutesFor('1h')));
  check('5m TTL -> 4 minutes', config.defaultMinutesFor('5m') === 4, String(config.defaultMinutesFor('5m')));
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
  check('defaults to a 59 minute window', !!s && s.idleMinutes === 59, s && String(s.idleMinutes));
  check('fireAt is armedAt + 59 min', !!s && s.fireAt - s.armedAt === 59 * 60 * 1000);
  check('records the absolute node path', !!s && s.nodePath === process.execPath);
  check('injects /compact', !!s && s.text === '/compact');
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
      idleMinutes: 59,
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
  check('ttl 1h -> 59 minutes', /idle threshold: 59 min/.test(cli(['set', 'ttl', '1h']).stdout));
  check('minutes 25 overrides', /idle threshold: 25 min \(explicit override\)/.test(cli(['set', 'minutes', '25']).stdout));
  check('ttl clears the override', /idle threshold: 59 min \(derived/.test(cli(['set', 'ttl', '1h']).stdout));
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
  check('reset restores defaults', /idle threshold: 59 min/.test(cli(['reset']).stdout));
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
    'systemMessage names the 59 minute default',
    !!(payload && /59 minutes/.test(payload.systemMessage)),
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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
