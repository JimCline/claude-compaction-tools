---
name: compaction-capture
description: Save each compaction summary to a file — turn capture on or off for this repo, or check where captures are going
disable-model-invocation: true
---

Manage the **compaction-capture** plugin.

Arguments given by the user: `$ARGUMENTS`

Let `CLI` be `node "${CLAUDE_PLUGIN_ROOT}/scripts/capture-cli.js"`.

If that path does not resolve — because `${CLAUDE_PLUGIN_ROOT}` came through
literally, or `node` is not on `PATH` — read `nodePath` and `pluginRoot` from
`~/.claude/compaction-capture/config.json` and use those absolute paths
instead. Both are rewritten every time the hook or the CLI runs. If that file
does not exist yet either, look for the plugin at
`~/.claude/plugins/marketplaces/*/compaction-capture`.

Map the arguments to exactly one Bash command:

| Arguments | Command |
|---|---|
| *(empty)* or `status` | `CLI status` |
| `on` | Run the location conversation described below |
| `off` | `CLI disable` |
| `where` | `CLI presets` |
| `now` | `CLI capture` |

Run the command, then show the user its output. Report the paths exactly as
printed — do not shorten or rewrite them.

If the arguments match nothing in the table, run `CLI status` and show the user
the table of accepted forms.

## The `on` conversation

Only for `on`. Captures are configured per repo, so this sets the folder for
whichever repo the session is in.

1. Run `CLI presets --json` first. It reports the exact `repo` and `central`
   paths for the current repo — use those strings verbatim in the question
   rather than composing paths yourself.
2. Ask with a **single AskUserQuestion call**, header **Save to**:
   - **Inside this repo** — the `repo` preset, `<repo>/.claude/compaction-captures/`.
     Captures live beside the code they describe and can be committed or
     gitignored. No per-repo subfolder, because the repo is already the scope.
   - **Shared folder** — the `central` preset,
     `~/.claude/compaction-captures/<repo-name>/`. Every repo's captures in one
     place, filed by repo name, and nothing is ever added to the working tree.
   - **Other** — any absolute path they name.
3. Apply it:
   - repo preset → `CLI enable --mode repo`
   - central preset → `CLI enable --mode central`
   - a path they typed → `CLI enable --location <absolute path>`

   The folder is created if it does not exist.
4. Show the `saving to:` line from the output.
5. If they chose a folder inside the repo, mention in one sentence that they may
   want to gitignore it — captures are conversation summaries and can be long.

The chosen folder is recorded per repo in
`~/.claude/compaction-capture/config.json`, at the user level, regardless of
where the capture files themselves are written.

## Verifying it works

`CLI capture` writes a capture immediately from the current transcript instead
of waiting for a real compaction. It fails with `no-summary-found` when the
session has never been compacted — that is the expected answer in a fresh
session, not a fault.

`CLI status` reports `hook last ran:` with the field names the `PostCompact`
payload actually carried. If that says `never` after a compaction has happened,
the hook is not firing and the plugin is not installed correctly.
