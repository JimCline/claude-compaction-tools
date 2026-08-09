#!/usr/bin/env node
'use strict';

// SessionStart and PostCompact hook. States the standing directive when a
// session begins and re-states it once a compaction has finished, so rules the
// summary dropped are back in context before the next turn.

const config = require('./lib/config');
const directive = require('./lib/directive');
const { readInput, emit } = require('./lib/hookio');

// SessionStart fires on resume and clear as well as startup. Those already
// carry the directive from the run that armed it, and clear is the user
// deliberately emptying the context — re-stating on either is noise.
const SKIP_SOURCES = new Set(['resume', 'clear']);

async function main() {
  const payload = await readInput();
  const event = payload.hook_event_name || 'SessionStart';

  if (event === 'SessionStart' && SKIP_SOURCES.has(payload.source)) return;

  const resolved = config.resolve(payload.cwd);
  if (!resolved.enabled) return;

  emit(directive.render(event, resolved));
}

// A hook that throws would surface an error on every session start and every
// compaction. Nothing here is worth interrupting the session for.
main().catch(() => {});
