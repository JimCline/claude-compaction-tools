'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');

function sessionFile(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(config.SESSION_DIR, safe + '.json');
}

function newArmId() {
  return crypto.randomBytes(9).toString('hex');
}

function read(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(sessionId), 'utf8'));
  } catch (_) {
    return null;
  }
}

function readPath(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function write(sessionId, state) {
  config.ensureRoot();
  const file = sessionFile(sessionId);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return file;
}

function remove(sessionId) {
  try {
    fs.unlinkSync(sessionFile(sessionId));
    return true;
  } catch (_) {
    return false;
  }
}

// A recorded pid can be recycled by the OS long after our timer exited, so
// every kill is paired with an armId the timer re-verifies before it fires.
function killIfRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch (_) {
    return false;
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function listSessions() {
  try {
    return fs
      .readdirSync(config.SESSION_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(config.SESSION_DIR, f));
  } catch (_) {
    return [];
  }
}

module.exports = {
  sessionFile,
  newArmId,
  read,
  readPath,
  write,
  remove,
  killIfRunning,
  isAlive,
  listSessions,
};
