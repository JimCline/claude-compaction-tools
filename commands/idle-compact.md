---
name: idle-compact
description: Turn idle auto-compaction on or off, set the idle threshold, test injection, show fire stats, or run diagnostics
argument-hint: "[status | on | off | 1h | 5m | <minutes> | min-tokens <n> | blind on|off | prompt | test | stats | doctor | reset | setup]"
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
| `prompt` | Run the prompt conversation described below |
| `prompt show` | `CLI prompt show` |
| `prompt clear` | `CLI prompt clear` |
| `test` | `CLI test` |
| `test send` | `CLI test --send` |
| `stats` | `CLI stats` |
| `stats sessions` | `CLI stats sessions` |
| `stats reset` | `CLI stats reset` |
| `doctor` | `DOCTOR` |
| `reset` | `CLI reset` |
| `setup` | Run the setup conversation described below |

Run the command, then show the user its output. Do not paraphrase the numbers —
report the threshold and state exactly as printed. Add at most one sentence of
context.

If the arguments match nothing in the table, run `CLI status` and show the user
the table of accepted forms.

## The `prompt` conversation

Only for `prompt` with no further arguments. A compaction prompt is extra text
appended to the injected command, so the plugin types `/compact <their text>`
instead of a bare `/compact`, and Claude Code uses it as focus instructions for
the summary.

1. Ask both of these in a **single AskUserQuestion call**.

   Question 1 — header **Prompt text**, what the summary should focus on:
   - **Preserve exact identifiers** — "Keep file paths, function names, and
     command invocations verbatim rather than describing them."
   - **Unresolved work first** — "Lead with unfinished work, open bugs, and the
     next concrete step. Keep decisions and their rationale; drop tool output."
   - **Decisions and rationale** — "Preserve every decision made and why,
     including the options considered and rejected."
   - **Other** — whatever they type becomes the prompt verbatim.

   Question 2 — header **Save to**, where the prompt file lives:
   - **This repo** — `.claude/compaction-prompt.md` in the repo root. Applies to
     this repo only, and can be committed so a team shares it.
   - **User level** — `~/.claude/compaction-prompt.md`. Applies to every repo
     that has not set its own.
   - **Other** — any path they name.

2. Write their chosen text to the chosen path with the Write tool, creating
   parent directories if needed. Keep it to a few sentences of plain prose — no
   headings or lists.
3. Register it: `CLI prompt use <absolute path>`, or
   `CLI prompt use <absolute path> --user` for the user-level one.
4. Show the `would send:` line from that output so the user sees the exact text
   that will be typed.
5. Close by telling them plainly: **this applies to the idle compactions the
   plugin fires. A `/compact` they type themselves is unaffected.**

Newlines are flattened to spaces before sending, because the text goes out as
one terminal line and a newline would submit the command early. Anything past
800 characters is dropped, and `CLI prompt use` says so when that happens.

## The `setup` conversation

Only for `setup` (or when a SessionStart notice asked you to configure the
plugin):

1. Explain in one sentence that the plugin runs `/compact` after a period of
   inactivity, timed to land just before the Anthropic prompt cache expires so
   the compaction itself still reads a warm cache.
2. Ask both of these in a **single AskUserQuestion call**.

   Question 1 — header **Idle wait**, how long a session may sit idle:
   - **55 minutes (recommended)** — the 1-hour cache TTL minus 5 minutes.
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
