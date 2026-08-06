#!/usr/bin/env node
'use strict';

// PostCompact hook. A compaction has just completed, so the summary it
// produced is now the last isCompactSummary entry in the transcript. Copy it
// to the folder configured for this repo.

const fs = require('fs');
const path = require('path');

const capture = require('./lib/capture');
const config = require('./lib/config');
const { readInput, emit } = require('./lib/hookio');

// PostCompact's payload is not documented field-by-field. Keeping the last one
// makes /compaction-capture status able to show what actually arrived instead
// of guessing.
function recordPayload(input) {
  try {
    config.ensureRoot();
    fs.writeFileSync(
      path.join(config.STATE_DIR, 'last-payload.json'),
      JSON.stringify({ at: new Date().toISOString(), keys: Object.keys(input || {}), input }, null, 2) + '\n'
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
