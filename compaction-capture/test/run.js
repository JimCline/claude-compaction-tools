'use strict';

// Exercises the PostCompact capture path against a sandboxed HOME so the real
// ~/.claude/compaction-capture is never touched.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN = path.resolve(__dirname, '..');
// realpath'd because the plugin canonicalises every repo key, and on macOS
// os.tmpdir() is the symlinked /var/folders view of /private/var/folders.
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-')));
const REPO = path.join(SANDBOX, 'fake-repo');
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

function cli(argv, cwd) {
  return spawnSync(process.execPath, [path.join(PLUGIN, 'scripts/capture-cli.js')].concat(argv), {
    encoding: 'utf8',
    env: env(),
    cwd: cwd || REPO,
    timeout: 20000,
  });
}

function hook(input, cwd) {
  return spawnSync(process.execPath, [path.join(PLUGIN, 'scripts/capture.js')], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: env(),
    cwd: cwd || REPO,
    timeout: 20000,
  });
}

// A transcript shaped like the real thing: ordinary turns, then a compaction
// summary entry, then more turns after it.
function writeTranscript(summaries) {
  const lines = [JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } })];
  for (const s of summaries) {
    lines.push(
      JSON.stringify({
        type: 'user',
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        uuid: s.uuid,
        parentUuid: 'parent-' + s.uuid,
        timestamp: s.timestamp,
        cwd: REPO,
        gitBranch: 'main',
        version: '2.1.217',
        sessionId: 'sess-1',
        compactMetadata: s.metadata || null,
        message: { role: 'user', content: [{ type: 'text', text: s.text }] },
      })
    );
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'ok' } }));
  }
  fs.writeFileSync(TRANSCRIPT, lines.join('\n') + '\n');
}

fs.mkdirSync(path.join(REPO, '.git'), { recursive: true });
console.log('sandbox HOME: ' + SANDBOX + '\n');

// ---------------------------------------------------------------------------
console.log('summary extraction');
{
  const summary = require(path.join(PLUGIN, 'scripts/lib/summary.js'));

  writeTranscript([
    { uuid: 'u1', timestamp: '2026-08-01T10:00:00.000Z', text: 'first summary' },
    { uuid: 'u2', timestamp: '2026-08-02T11:30:00.000Z', text: 'second summary' },
  ]);

  const found = summary.lastSummary(TRANSCRIPT);
  check('finds the most recent summary, not the first', !!found && found.uuid === 'u2', found && found.uuid);
  check('reads text out of a content array', !!found && found.text === 'second summary');
  check('carries provenance', !!found && found.gitBranch === 'main' && found.version === '2.1.217');
  check('returns null for a transcript with no summary', (() => {
    const plain = path.join(SANDBOX, 'plain.jsonl');
    fs.writeFileSync(plain, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
    return summary.lastSummary(plain) === null;
  })());
  check('returns null for a missing file', summary.lastSummary(path.join(SANDBOX, 'nope.jsonl')) === null);
  check('survives a malformed line', (() => {
    const broken = path.join(SANDBOX, 'broken.jsonl');
    fs.writeFileSync(broken, 'isCompactSummary but not json\n');
    return summary.lastSummary(broken) === null;
  })());
}

// ---------------------------------------------------------------------------
console.log('\nCLI');
{
  check('status exits 0 before any configuration', cli(['status']).status === 0);
  check('status reports OFF by default', /compaction-capture: OFF/.test(cli(['status']).stdout));
  check('presets offers a repo path', new RegExp('repo\\s+' + REPO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(cli(['presets']).stdout), cli(['presets']).stdout);
  check('presets files the shared folder by repo name', /compaction-captures\/fake-repo/.test(cli(['presets']).stdout), cli(['presets']).stdout);
  check('enable needs a location', cli(['enable']).status === 1);

  const enabled = cli(['enable', '--mode', 'repo']).stdout;
  check('enable --mode repo turns it on', /compaction-capture: ON/.test(enabled), enabled);
  check('enable records the repo preset path', /fake-repo\/\.claude\/compaction-captures/.test(enabled), enabled);
  check('enable creates the folder', fs.existsSync(path.join(REPO, '.claude', 'compaction-captures')));

  const cfg = JSON.parse(fs.readFileSync(path.join(SANDBOX, '.claude', 'compaction-capture', 'config.json'), 'utf8'));
  check('location is stored at user level, keyed by repo', !!cfg.repos[REPO] && cfg.repos[REPO].enabled === true, JSON.stringify(cfg.repos));
  check('records pluginRoot for the slash command', cfg.pluginRoot === PLUGIN, cfg.pluginRoot);

  check('disable turns it off', /compaction-capture: OFF/.test(cli(['disable']).stdout));
  check('disable keeps the location', (() => {
    const after = JSON.parse(fs.readFileSync(path.join(SANDBOX, '.claude', 'compaction-capture', 'config.json'), 'utf8'));
    return !!after.repos[REPO].location;
  })());
  check('rejects an unknown command', cli(['wat']).status === 1);
}

// ---------------------------------------------------------------------------
console.log('\nPostCompact hook');
{
  cli(['enable', '--mode', 'repo']);
  const dir = path.join(REPO, '.claude', 'compaction-captures');

  const r = hook({
    session_id: 'sess-1',
    transcript_path: TRANSCRIPT,
    cwd: REPO,
    hook_event_name: 'PostCompact',
    trigger: 'manual',
  });
  check('hook exits 0', r.status === 0, r.stderr);

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  check('writes exactly one capture', files.length === 1, files.join(', '));

  const body = files.length ? fs.readFileSync(path.join(dir, files[0]), 'utf8') : '';
  check('names the file by compaction time and trigger', files.length && /^2026-08-02-\d{6}-manual\.md$/.test(files[0]), files[0]);
  check('captures the summary text', /second summary/.test(body));
  check('writes front matter', /^---\n/.test(body) && /\nsession: sess-1\n/.test(body), body.slice(0, 120));
  check('front matter records the repo', /\nrepo: fake-repo\n/.test(body));
  check('front matter records the trigger', /\ntrigger: manual\n/.test(body));

  const again = hook({ session_id: 'sess-1', transcript_path: TRANSCRIPT, cwd: REPO, trigger: 'manual' });
  check('re-firing on the same summary writes nothing new', again.status === 0 && fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length === 1);

  writeTranscript([
    { uuid: 'u1', timestamp: '2026-08-01T10:00:00.000Z', text: 'first summary' },
    { uuid: 'u2', timestamp: '2026-08-02T11:30:00.000Z', text: 'second summary' },
    { uuid: 'u3', timestamp: '2026-08-03T09:15:00.000Z', text: 'third summary', metadata: { trigger: 'auto', preTokens: 200000, postTokens: 15000 } },
  ]);
  hook({ session_id: 'sess-1', transcript_path: TRANSCRIPT, cwd: REPO });
  const after = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  check('a new compaction produces a new capture', after.length === 2, after.join(', '));
  const newest = fs.readFileSync(path.join(dir, after[1]), 'utf8');
  check('takes the trigger from compactMetadata when the payload omits it', /\ntrigger: auto\n/.test(newest), newest.slice(0, 200));
  check('records token counts when the metadata carries them', /\npre_tokens: 200000\n/.test(newest) && /\npost_tokens: 15000\n/.test(newest));

  check('status counts the captures', /captures:\s+2/.test(cli(['status']).stdout), cli(['status']).stdout);
  check('status reports the hook payload fields it saw', /hook last ran:.*session_id/.test(cli(['status']).stdout));
}

// ---------------------------------------------------------------------------
console.log('\nsafety');
{
  const dir = path.join(REPO, '.claude', 'compaction-captures');
  const before = fs.readdirSync(dir).length;

  cli(['disable']);
  const r = hook({ session_id: 'sess-2', transcript_path: TRANSCRIPT, cwd: REPO });
  check('writes nothing while disabled', r.status === 0 && fs.readdirSync(dir).length === before);

  const outside = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts/capture.js')], {
    input: 'not json at all',
    encoding: 'utf8',
    env: env(),
    cwd: REPO,
    timeout: 20000,
  });
  check('survives a malformed payload', outside.status === 0, outside.stderr);

  cli(['enable', '--mode', 'repo']);
  const missing = hook({ session_id: 'sess-3', transcript_path: path.join(SANDBOX, 'gone.jsonl'), cwd: REPO });
  check('survives a transcript that does not exist', missing.status === 0, missing.stderr);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
