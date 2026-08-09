#!/usr/bin/env node
'use strict';

// SessionStart and PostCompact hook. States the standing directive when a
// session begins and re-states it once a compaction has finished, so rules the
// summary dropped are back in context before the next turn.

const config = require('./lib/config');
const directive = require('./lib/directive');
const { readInput, emit } = require('./lib/hookio');

// SessionStart fires on resume as well as startup. A resumed session restores
// the transcript that already carries the directive, so re-stating duplicates
// it. Clear is not skipped: it empties the working context, which is exactly
// when a standing policy has to be restated.
const SKIP_SOURCES = new Set(['resume']);

async function main() {
  const payload = await readInput();
  const event = payload.hook_event_name || 'SessionStart';

  if (event === 'SessionStart' && SKIP_SOURCES.has(payload.source)) return;

  const resolved = config.resolve(payload.cwd);
  if (!resolved.enabled) return;

  emit(directive.render(event, resolved));
}

// A hook that throws would surface an error on every session start and every
// compaction, and nothing here is worth interrupting a session for. But a
// silent catch turns any fault into "the directive simply never appeared",
// which is indistinguishable from working correctly — so the reason goes to
// stderr, which hook debugging shows and the model's context does not.
main().catch((err) => {
  process.stderr.write('compaction-guard: ' + (err && err.message ? err.message : err) + '\n');
});
