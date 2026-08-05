---
name: idle-compact
description: Turn idle auto-compaction on or off, set the idle threshold, test injection, or run diagnostics
disable-model-invocation: true
---

Manage the **idle-compactor** plugin.

Arguments given by the user: `$ARGUMENTS`

Let `CLI` be `node "${CLAUDE_PLUGIN_ROOT}/scripts/config-cli.js"` and
`DOCTOR` be `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.js"`.

If that path does not resolve — because `${CLAUDE_PLUGIN_ROOT}` came through
literally, or `node` is not on `PATH` — read `nodePath` and `pluginRoot` from
`~/.claude/idle-compactor/config.json` and use those absolute paths instead.
The SessionStart hook rewrites both on every session.

Map the arguments to exactly one Bash command:

| Arguments | Command |
|---|---|
| *(empty)* or `status` | `CLI status` |
| `on` | `CLI on` |
| `off` | `CLI off` |
| `1h` or `ttl 1h` | `CLI set ttl 1h` |
| `5m` or `ttl 5m` | `CLI set ttl 5m` |
| `<number>` or `minutes <number>` | `CLI set minutes <number>` |
| `min-tokens <number>` | `CLI set min-tokens <number>` |
| `blind on` / `blind off` | `CLI blind on` / `CLI blind off` |
| `test` | `CLI test` |
| `test send` | `CLI test --send` |
| `doctor` | `DOCTOR` |
| `reset` | `CLI reset` |
| `setup` | Run the setup conversation described below |

Run the command, then show the user its output. Do not paraphrase the numbers —
report the threshold and state exactly as printed. Add at most one sentence of
context.

If the arguments match nothing in the table, run `CLI status` and show the user
the table of accepted forms.

## The `setup` conversation

Only for `setup` (or when a SessionStart notice asked you to configure the
plugin):

1. Explain in one sentence that the plugin runs `/compact` after a period of
   inactivity, timed to land just before the Anthropic prompt cache expires so
   the compaction itself still reads a warm cache.
2. Ask both of these in a **single AskUserQuestion call**.

   Question 1 — header **Idle wait**, how long a session may sit idle:
   - **59 minutes (recommended)** — the 1-hour cache TTL minus 1 minute.
   - **4 minutes** — the 5-minute default cache TTL minus 1 minute.
   - **Custom** — any number of minutes they name.
   - **Disable for now** — leave it off.

   Question 2 — header **Min context**, the smallest context worth compacting.
   Below this the plugin stays dormant, because compacting a small context
   discards a cheap warm cache and reclaims almost nothing:
   - **20,000 tokens (recommended)** — skips short sessions.
   - **50,000 tokens** — only compact sessions that have grown large.
   - **Always** — no floor; compact whenever idle.
   - **Custom** — any token count they name.
3. Apply the answers with Bash: one of `CLI set ttl 1h`, `CLI set ttl 5m`,
   `CLI set minutes <N>`, or `CLI off`; then `CLI set min-tokens <N>` (use `0`
   for **Always**). Set the floor even if they disabled the plugin, so it is
   right when they turn it back on.
4. Run `CLI setup-done` so the first-run notice stops appearing — including when
   the user chose to disable.
5. Run `CLI test` and tell the user which injection provider was selected. If it
   reports `NONE`, say plainly that the plugin cannot type into their terminal
   and point them at the Terminal support table in the README.
