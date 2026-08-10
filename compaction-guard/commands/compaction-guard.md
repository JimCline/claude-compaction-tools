---
name: compaction-guard
description: Keep standing directives alive across compaction — turn the guard on or off for this repo, inspect the injected text, or replace it with your own
argument-hint: "[status | show | on | off | mode default|append|replace | set <file> | reset]"
disable-model-invocation: true
---

Run the backend and show its output verbatim:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/guard-cli.js" <command>
```

Commands:

- `status` — whether the guard is on for this repo, which mode, where config lives
- `show` — the directive exactly as it would be injected after a compaction
- `on` / `off` — enable or disable for this repo
- `mode default|append|replace` — `default` ships the built-in policy, `append`
  keeps it and adds yours after it, `replace` uses only yours
- `set <file>` — read the custom directive text from a file
- `reset` — drop this repo's overrides and fall back to the global config

With no argument, run `status`.

Note when it comes up: the directive is stated at session start and re-stated
after each compaction. The re-statement lands *after* the summary, so it cannot
steer the compaction that just ran — it survives into the next one, and makes a
loss that already happened visible now.
