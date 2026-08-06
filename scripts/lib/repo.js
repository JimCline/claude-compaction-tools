'use strict';

const fs = require('fs');
const path = require('path');

// Walk up looking for a .git entry rather than shelling out to git. These run
// inside hooks, where a subprocess per call is latency the user feels, and a
// linked worktree's .git is a file rather than a directory — existsSync covers
// both without caring which.
// Collapse symlinks before anything is keyed off a path. macOS hands out
// /var/folders/... in some places and the physical /private/var/folders/...
// in others; without this the same repo keys two different ways and a
// per-repo setting saved under one is invisible under the other.
function canonical(dir) {
  const abs = path.resolve(dir || process.cwd());
  try {
    return fs.realpathSync(abs);
  } catch (_) {
    return abs;
  }
}

function root(startDir) {
  let dir = canonical(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The key a per-repo setting is filed under. Outside a repo the directory
// itself is the key, so a non-repo working directory still gets its own slot
// instead of silently sharing one.
function key(cwd) {
  return root(cwd) || canonical(cwd);
}

function name(cwd) {
  return path.basename(key(cwd));
}

module.exports = { root, key, name, canonical };
