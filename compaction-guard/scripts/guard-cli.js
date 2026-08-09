#!/usr/bin/env node
'use strict';

// Backend for the /compaction-guard slash command.

const fs = require('fs');
const config = require('./lib/config');
const directive = require('./lib/directive');

function status() {
  const resolved = config.resolve(process.cwd());
  const cfg = config.read();
  return {
    enabled: resolved.enabled,
    repo: config.repoRoot(process.cwd()) || process.cwd(),
    mode: resolved.mode || cfg.mode,
    config_path: config.CONFIG_PATH,
    custom_directive: !!(resolved.text && resolved.text !== directive.POLICY),
    chars: resolved.text ? resolved.text.length : 0,
  };
}

function usage() {
  return [
    'Usage: guard-cli.js <command>',
    '',
    '  status              show whether the guard is on for this repo',
    '  show                print the directive exactly as it would be injected',
    '  on | off            enable or disable for this repo',
    '  mode <name>         default | append | replace',
    '  set <file>          use <file> contents as the custom directive text',
    '  reset               drop this repo\'s overrides',
  ].join('\n');
}

function main(argv) {
  const [cmd, arg] = argv;

  switch (cmd) {
    case 'status':
      process.stdout.write(JSON.stringify(status(), null, 2) + '\n');
      return 0;

    case 'show':
      process.stdout.write(directive.render('PostCompact', config.resolve(process.cwd())));
      return 0;

    case 'on':
    case 'off':
      config.setRepo(process.cwd(), { enabled: cmd === 'on' });
      process.stdout.write('compaction-guard ' + cmd + ' for this repo\n');
      return 0;

    case 'mode':
      if (!['default', 'append', 'replace'].includes(arg)) {
        process.stderr.write('mode must be one of: default, append, replace\n');
        return 2;
      }
      config.setRepo(process.cwd(), { mode: arg });
      process.stdout.write('mode set to ' + arg + '\n');
      return 0;

    case 'set': {
      if (!arg) {
        process.stderr.write('set needs a path to a file holding the directive text\n');
        return 2;
      }
      const text = fs.readFileSync(arg, 'utf8').trim();
      config.setRepo(process.cwd(), { directive: text });
      process.stdout.write('directive set from ' + arg + ' (' + text.length + ' chars)\n');
      return 0;
    }

    case 'reset':
      config.setRepo(process.cwd(), { enabled: undefined, mode: undefined, directive: undefined });
      process.stdout.write('overrides cleared for this repo\n');
      return 0;

    default:
      process.stdout.write(usage() + '\n');
      return cmd ? 2 : 0;
  }
}

process.exit(main(process.argv.slice(2)));
