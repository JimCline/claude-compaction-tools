# compaction-guard — design record

What the plugin does, why it is built this way, and what was measured to get
there. Written after the fact, so it records the approaches that were rejected
alongside the one that shipped — several of the rejections are the useful part.

## The problem

A compaction summary can drop the rules a task is running under. The failure is
not the loss itself but what it looks like afterwards: **a dropped constraint is
indistinguishable from a constraint that never existed.** There is no gap in the
context where it used to be, so the next turn proceeds confidently past it.

Explicit directives are the worst case — user instructions, standing rules, and
especially negative constraints ("don't use X", "we rejected Y"), whose absence
silently re-enables the exact path they forbade.

## Mechanism: what was measured

Everything in this section was verified against a running Claude Code (~2.1.226),
not taken from documentation. Doc research got two of these wrong.

### Hook context injection uses two different channels

| Event | Channel that reaches the model | Notes |
| --- | --- | --- |
| `SessionStart` | **plain stdout** | Also supports `hookSpecificOutput.additionalContext` |
| `PostCompact` | **plain stdout** | Structured envelope is *not* read |
| `SubagentStart` | **structured JSON only** | Plain stdout is discarded |

`PostCompact`'s documented "supported output fields" are `continue`,
`stopReason`, `suppressOutput`, `systemMessage`, `terminalSequence`, with
decision control `None`. That table describes the *structured JSON* channel only,
which makes `PostCompact` look incapable of injecting context. It is not — it
injects via stdout.

The question "does `PostCompact` support `additionalContext`?" returns a
misleading **no**. The right question is "can it inject at all?", and the answer
is **yes, via stdout**. Three separate documentation passes answered the wrong
question and concluded the design was impossible.

`SubagentStart` inverts the rule, which is what makes the whole area a trap: a
plain-stdout hook that works on `SessionStart` silently injects nothing on
`SubagentStart`, and vice versa. A working reference implementation in another
repo had already paid for this lesson, recording it as *"the event was never the
problem — the output format was."*

### PostCompact stdout lands after the summary

Proven by canary test (see [Verification](#verification)). The injected text sits
in the **new** post-compaction context. Two consequences:

- It **cannot** steer the compaction that just ran — too late by construction.
- It **cannot** be compacted away by that compaction — so it is a reliable
  re-arming channel for the next one.

### The transcript is append-only

Compaction does not truncate or rewrite the transcript JSONL. Measured on a real
transcript: 438 pre-compaction turns (160 user, 278 assistant) still intact, with
the compaction summary simply appended as a new entry at line 809 of 832.

This kills the premise that state must be snapshotted *before* compaction
destroys it. Nothing on disk is destroyed.

### PreCompact cannot be used to steer the model

- A `PreCompact` block's `reason` is surfaced to the **user**, never to the
  model. Unlike a `PreToolUse` denial — whose reason returns as the tool result
  and is read on the next turn — the model never sees it.
- A blocked auto-compaction **continues uncompacted** rather than retrying.
  Blocking does not even prevent the loss; it defers it, with an infinite-block
  loop or a context-limit error as the realistic outcome.

### There is no persistent compaction-instruction setting

Only `autoCompactEnabled` and `autoCompactWindow` exist (the latter is what
`/autocompact <size>` sets). Documented steering channels are a
`## Compact Instructions` section in CLAUDE.md, or `/compact <focus>` per
invocation. Neither is a plugin-distributable mechanism, which is why this
plugin exists.

## Rejected approaches

**Block-then-nudge on `PreCompact`.** Deny the compaction with a reason telling
the model to preserve state first, then let it retry — the pattern used
successfully by several `PreToolUse` gates elsewhere. Rejected: the reason never
reaches the model, and a blocked auto-compaction proceeds uncompacted anyway. The
`PreToolUse` precedent does not transfer, because that fires on a tool call the
model itself invoked.

**Computing a delta against the summary.** Have a hook read the transcript,
determine what the summary dropped, and re-inject only the gap. Rejected on
economics: a *script* can do this for zero model tokens but cannot judge what
matters; making the judgment requires a model, which means paying to re-read the
content being discarded. Self-defeating — the mechanical version dodges the cost
only by being too dumb to do the job.

**Preserving content at all.** Both of the above try to carry *data* across the
boundary, which scales with conversation size. Injecting *instructions* is O(1) —
a fixed few hundred tokens regardless of how much context exists.

## Design

Two hooks, both emitting plain stdout.

| Hook | Fires | Purpose |
| --- | --- | --- |
| `SessionStart` | session start, `clear` | Arms the directive |
| `PostCompact` | after any compaction | Re-arms it, plus a recovery check |

The division of labour follows what a hook can and cannot know:

- **Static directives** — rules, constraints, standing instructions. The hook
  knows this text, so it can restate it verbatim after every compaction. Fully
  reliable; does not depend on the summarizer cooperating at all.
- **Dynamic in-flight state** — which task is underway, what was just decided. A
  hook cannot know this, so it cannot restate it. The only lever is steering the
  summarizer via CLAUDE.md, which is outside this plugin.

### Deliberate details

**The directive names itself as operator-configured policy.** A receiving model
reads hook stdout as untrusted third-party content and may discount an anonymous
block that issues orders — measured: an agent given this text flagged exactly
that, unprompted, and said it was complying only because separately asked to.

**`PostCompact` adds a paragraph `SessionStart` does not.** Since the
re-statement lands after the summary, it cannot protect the compaction that just
ran. Its second job is to make an already-happened loss *sayable*: asking whether
the governing directives can still be stated, and to recover or ask rather than
proceed on assumption. This addresses the actual failure mode — confident silence.

**`resume` is skipped; `clear` is not.** A resumed session restores a transcript
that already carries the directive, so re-stating duplicates it. A cleared
session is a fresh working context, which is exactly when a standing policy must
be present. The right analogy for `clear` is CLAUDE.md — which *is* re-injected
after `/clear` — not conversation content, which is not.

**Failures report on stderr.** An earlier `main().catch(() => {})` rendered every
fault as "the directive never appeared", which is byte-for-byte what a correctly
skipped event looks like. stderr is visible to hook debugging and absent from the
model's context.

### Configuration

Global defaults at `~/.claude/compaction-guard/config.json`, with per-repo
overrides keyed on the nearest enclosing git worktree. Modes: `default` (shipped
policy), `append` (policy plus yours), `replace` (yours only). Managed via
`/compaction-guard`.

## Verification

Self-reported "yes I can see it" is not evidence — a model asked whether text is
present is prone to agreeing. Both hooks were verified without relying on it.

### PostCompact — canary test

A hook script minted a random token **at fire time**, appended it to a log, and
printed it to stdout. A separate agent, instructed to use no tools, reported the
token from context alone. The verifier did not read the log until after the agent
answered.

```
log written at fire time:  PCK-1786235751-4d1db8ff
agent's context, no tools: PCK-1786235751-4d1db8ff
```

A value minted at fire time has no other path into the agent's context. The agent
also reported the position: after the compaction summary.

### SessionStart — structural transcript check

Verified by entry *type* in the session transcript, not by string presence:

```json
{"type": "attachment", "attachment": {"hookEvent": "SessionStart"}, ...}
```

Found at line 7 of a 16-line fresh session, hook exit code 0, with
`"A compaction just completed"` appearing **zero** times — confirming the two
hooks are correctly differentiated rather than emitting identical text.

### Methodology note: string presence is not evidence

A first pass grepped transcripts for the directive text, found matches in three
sessions, and concluded the hook had fired in each. **That was wrong.** The
string was present because it had been authored and printed *inside* those
conversations. Checking the entry type showed all six matches were user/assistant
message bodies; the genuine hook entries in those same files did not contain the
directive at all.

Had that stood, a broken plugin would have shipped as verified. **Check the entry
type, not the string.**

## Operational note: the cache keys on version

The plugin cache stores payloads under `<plugin>/<version>/`. Refreshing a
marketplace updates the *listing*, but an unchanged version number leaves the
already-cached payload in place — and `/reload-plugins` then faithfully reloads
the old code.

A behaviour fix pushed without a version bump reached the remote and never
reached a running session. The symptom was indistinguishable from the hook not
working, and cost a full debugging cycle. **Move the version with any behaviour
change**, in both `plugin.json` and `marketplace.json`.

## Status

Verified working:

- `SessionStart` injection (startup and `clear`), structurally confirmed
- `PostCompact` injection, canary-confirmed
- 7/7 unit tests, including one pinning the plain-stdout requirement

Not yet verified end-to-end: `PostCompact` injection of *this plugin's* directive
in a live session. The mechanism is proven and the script's output is tested; what
remains is confirming the wiring under a real compaction.

Out of scope, and the remaining gap: preserving **dynamic** in-flight task state.
A hook cannot know it. That needs a `## Compact Instructions` section in CLAUDE.md
to steer the summarizer, which is a separate and weaker mechanism — it depends on
the summarizer cooperating, where this plugin does not.
