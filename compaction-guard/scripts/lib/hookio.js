'use strict';

const STDIN_TIMEOUT_MS = 2000;

// Hooks are handed their payload on stdin, but a hook that blocks waiting for
// input it never receives would stall the event it fires on. Resolve empty on
// timeout so the caller degrades to its defaults instead.
function readInput() {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data));
      } catch (_) {
        resolve({});
      }
    };

    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    timer.unref();

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

// SessionStart and PostCompact both take context as plain stdout. The
// structured hookSpecificOutput envelope is not read on either event, so
// writing JSON here would inject nothing.
function emit(text) {
  if (text) process.stdout.write(text);
}

module.exports = { readInput, emit };
