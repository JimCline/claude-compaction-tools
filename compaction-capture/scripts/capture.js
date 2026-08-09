#!/usr/bin/env node
'use strict';

// PostCompact hook. A compaction has just completed; its summary arrives in
// the payload, and the transcript holds the matching entry. Copy it to the
// folder configured for this repo.

const fs = require('fs');
const path = require('path');

const capture = require('./lib/capture');
const config = require('./lib/config');
const { readInput, emit } = require('./lib/hookio');

// PostCompact's payload is not documented field-by-field. Keeping the last one
// makes /compaction-capture status able to show what actually arrived instead
// of guessing. compact_summary runs to tens of kilobytes and the capture file
// already holds it, so long values are kept only as a preview.
function abbreviate(input) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    out[key] =
      typeof value === 'string' && value.length > 200
        ? value.slice(0, 200) + '… [' + value.length + ' chars]'
        : value;
  }
  return out;
}

function recordPayload(input) {
  try {
    config.ensureRoot();
    fs.writeFileSync(
      path.join(config.STATE_DIR, 'last-payload.json'),
      JSON.stringify(
        { at: new Date().toISOString(), keys: Object.keys(input || {}), input: abbreviate(input) },
        null,
        2
      ) + '\n'
    );
  } catch (_) {
    /* diagnostic only */
  }
}

async function main() {
  const input = await readInput();
  recordPayload(input);
  try {
    config.setPaths(path.resolve(__dirname, '..'), process.execPath);
  } catch (_) {
    /* best effort */
  }

  const result = await capture.run(input);
  if (!result.ok) return;

  emit({
    systemMessage: 'Compaction summary saved to ' + result.file,
  });
}

main().then(
  () => process.exit(0),
  () => process.exit(0)
);
