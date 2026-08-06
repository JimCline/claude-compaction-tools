'use strict';

const STDIN_TIMEOUT_MS = 3000;

// Hook payloads arrive on stdin as a single JSON object. Never reject: a hook
// that throws is noise in the user's session, and every caller here treats an
// unreadable payload as "do nothing".
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

function emit(payload) {
  if (payload) process.stdout.write(JSON.stringify(payload));
}

module.exports = { readInput, emit };
