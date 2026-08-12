# claude-compaction-tools

Three Claude Code plugins for managing context compaction.

- **idle-compactor** — runs `/compact` automatically when a session goes idle,
  timed to land just before the Anthropic prompt cache expires, optionally with
  your own focus instructions attached. An opt-in **keepalive mode** pings the
  cache instead of compacting, for when you want to keep local context intact.
- **compaction-capture** — writes each compaction summary to a file after the
  fact, so the context a session dropped is still on disk.
- **compaction-guard** — re-states your standing directives after every
  compaction, so rules the summary dropped are back in context before the next
  turn.

Everything up to [compaction-capture](#compaction-capture) describes
`idle-compactor`.

## Why the timing matters

Anthropic's prompt cache has exactly two TTLs: **5 minutes** (the default
`cache_control: {"type": "ephemeral"}`) and **1 hour** (`"ttl": "1h"`). While a
session's cached prefix is alive, re-sending it costs about 0.1× base input.
Once it expires, the next turn pays a full cache write at 1.25× (5m) or 2× (1h).

So the useful moment to compact is a few minutes before the cache dies:

- Late enough that a user who comes straight back still lands on a warm cache.
- Early enough that the compaction request itself reads the warm prefix instead
  of paying to re-write the whole thing.

That is the default: **55 minutes** for the 1-hour TTL, **4 minutes** for the
5-minute TTL. You are asked which one you want the first time the plugin runs.

## How it works — and the honest caveat

Claude Code's hook system **cannot start a compaction**. There is no idle or
timer hook, no hook output field submits a turn or runs a slash command, and
`PreCompact` can only *block* a compaction that is already happening.

So this plugin does the only thing that actually works: it types `/compact` into
your terminal for you.

```
turn ends ──▶ Stop hook (arm.js)
                 ├─ context below the token floor?  →  do nothing
                 └─ spawn a detached timer process, recording an armId
you type  ──▶ UserPromptSubmit hook (disarm.js)  →  kill timer, delete state
idle      ──▶ timer.js wakes, re-verifies the armId and that the transcript
              has not been touched, then types "/compact" + Enter into the
              pane this session is running in
```

The consequence you should be aware of: **the plugin needs a way to send
keystrokes to your terminal.** It only ever uses methods that can positively
identify your specific pane or tab. Methods that type into whatever window
currently has focus are disabled by default — see [Blind
injection](#blind-injection).

## Requirements

- **Node.js 18 or newer on `PATH`.** Claude Code's npm install brings its own
  Node, but the native installer does not, so this is a real prerequisite. If
  `node` is missing the hooks fail harmlessly and the plugin simply never fires;
  `/idle-compact doctor` will tell you.
- A supported terminal (below).

## Install

```
/plugin marketplace add JimCline/claude-compaction-tools
/plugin install idle-compactor@jcline-claude-compaction-tools
/plugin install compaction-capture@jcline-claude-compaction-tools
/plugin install compaction-guard@jcline-claude-compaction-tools
```

The three are independent — install any one on its own.

On the first session after installing, the plugin asks you two things: the idle
threshold, and the minimum context size worth compacting. Run `/idle-compact
setup` any time to change your mind.

## Usage

```
/idle-compact                 show current settings and armed timers
/idle-compact on              enable
/idle-compact off             disable and cancel every pending timer
/idle-compact 1h              use the 1-hour cache TTL  → 55 minutes
/idle-compact 5m              use the 5-minute cache TTL →  4 minutes
/idle-compact 25              use an explicit 25-minute threshold
/idle-compact min-tokens 40000   only compact above this context size
/idle-compact min-tokens 0       no floor; compact whenever idle
/idle-compact keepalive       ping the cache instead of compacting (see below)
/idle-compact compact         switch back to the default /compact mode
/idle-compact max-pings 12    stop keepalive after this many pings (default 12)
/idle-compact blind on|off    allow or block focus-based injection
/idle-compact prompt          set the focus instructions sent with /compact
/idle-compact prompt show     what would be sent, and from which file
/idle-compact prompt clear    stop sending one
/idle-compact test            show which injection method would be used
/idle-compact test send       actually type a harmless command, end to end
/idle-compact stats           how many times it has autocompacted, per session and total
/idle-compact stats sessions  live view: every session's idle state and time to compact
/idle-compact stats reset     clear the fire history
/idle-compact doctor          full diagnostics
/idle-compact paths           absolute node and plugin paths
/idle-compact reset           restore defaults
/idle-compact setup           re-run the first-run configuration
```

## Terminal support

| Terminal | Method | Targeted? | Notes |
|---|---|---|---|
| herdr | `herdr pane run $HERDR_PANE_ID` | yes | |
| tmux | `send-keys -t $TMUX_PANE` | yes | |
| GNU screen | `-X stuff` | yes | |
| WezTerm | `wezterm cli send-text --pane-id` | yes | |
| kitty | `kitty @ send-text --match id:` | yes | needs `allow_remote_control yes` |
| iTerm2 | AppleScript, matched on `ITERM_SESSION_ID` | yes | |
| Apple Terminal | AppleScript, matched on the tab's tty | yes | |
| X11 | `xdotool --window $WINDOWID` | yes | only when `WINDOWID` is set |
| X11 | `xdotool` to the active window | **no** | opt-in |
| Wayland | `ydotool` | **no** | opt-in, needs `ydotoold` |
| Windows | `WriteConsoleInput` on the session's own console | yes | Windows Terminal, conhost, VS Code |
| Windows | PowerShell `AppActivate` + `SendKeys` | **no** | opt-in, fallback |

Providers are tried in that order and the first one that succeeds wins. If your
terminal is not listed and you are not in tmux, the plugin will detect nothing
and stay dormant — running Claude Code inside tmux is the most portable fix.

macOS will ask for Automation permission the first time the AppleScript
providers run.

On Windows the first provider attaches to the console that Claude Code itself
is running on and writes the keystrokes into that console's input buffer. It
therefore does not care which window has focus, and it targets the right tab
even when Windows Terminal has a dozen of them. `SendKeys` remains behind it as
an opt-in fallback for hosts where attaching fails.

### Blind injection

`xdotool` without `WINDOWID`, `ydotool`, and Windows `SendKeys` type into
whatever window has focus. If you have alt-tabbed away, `/compact` gets typed
into that other application instead. They are therefore **off by default**:

```
/idle-compact blind on
```

Only enable this if you understand that trade-off. Windows normally never gets
that far, because console injection is tried first and does not depend on focus.

## Compaction prompt

`/compact` accepts optional focus instructions, and the plugin can attach yours
to every idle compaction so it types `/compact <your text>` instead of a bare
`/compact`.

```
/idle-compact prompt        walk through writing one and choosing where it lives
/idle-compact prompt show   what would be sent, and from which file
/idle-compact prompt clear  stop sending one
```

The wizard writes your text to a file and records the path — either
`.claude/compaction-prompt.md` in the repo (so it can be committed and shared),
`~/.claude/compaction-prompt.md` at the user level (the fallback for every repo
without its own), or any path you name. A repo-scoped prompt wins over the
user-level one.

Two things worth knowing:

- **It applies only to compactions this plugin fires.** A `/compact` you type
  yourself is not intercepted.
- **Newlines are flattened to spaces.** The text is typed as a single terminal
  line, so an embedded newline would submit the command early and leave the
  remainder as a stray prompt. Anything past 800 characters is dropped, and
  `prompt show` tells you when that happens.

## Keepalive mode

`/compact` is the default, but sometimes you want the opposite: keep your
**local** conversation exactly as it is, but stop the **server-side** prompt
cache from going cold while you're away. `/idle-compact keepalive` switches to
that mode.

Instead of typing `/compact`, the plugin pings the idle session with a short,
do-nothing message on the same idle cadence, so Claude's reply refreshes the
cache without summarizing anything away. It only makes economic sense on the
1-hour cache TTL — pinging a 5-minute cache costs more than it saves within
the hour — so `keepalive` refuses to enable itself under `ttl 5m`.

```
/idle-compact keepalive         switch to keepalive mode
/idle-compact compact           switch back to the default /compact mode
/idle-compact max-pings 12      stop after this many pings (default 12, ~11h)
```

Each ping is classified as a cache **hit** or **miss** from the usage block of
Claude's reply to it, and the running hit rate shows up in `/idle-compact
doctor`. If a ping's injection fails outright — no terminal provider
available, or the provider errored — the loop simply stops rather than
retrying blind: nothing was typed, so nothing was spent, and it will not try
again until you return and a new turn re-arms it.

## Safety gates

Compaction only fires when all of these hold:

1. The plugin is enabled.
2. The context is at least `min-tokens` — measured from the last `usage` block
   in the transcript as
   `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
   The default is 20,000, because compacting a small context throws away a
   cheap warm cache to reclaim almost nothing. Set it to `0` to remove the
   floor entirely; you are asked for this value during first-run setup.
3. The `armId` recorded when the timer was spawned still matches the state file,
   so a timer superseded by a newer turn cannot fire, and a recycled PID cannot
   be mistaken for a live timer.
4. The transcript has not been written to more than 60 seconds after arming.
5. The Claude Code process that armed the timer is still alive.

The timer polls every 15 seconds rather than sleeping once, so suspending the
machine does not silently swallow the deadline.

## Configuration

Settings live in `~/.claude/idle-compactor/config.json`; per-session timer state
lives in `~/.claude/idle-compactor/sessions/`.

Environment variables override the file for a single session:

| Variable | Effect |
|---|---|
| `CLAUDE_IDLE_COMPACT_DISABLE` | `1` to disable, `0` to force enable |
| `CLAUDE_IDLE_COMPACT_TTL` | `1h` or `5m` |
| `CLAUDE_IDLE_COMPACT_MINUTES` | explicit threshold in minutes |
| `CLAUDE_IDLE_COMPACT_MIN_TOKENS` | minimum context size |
| `CLAUDE_IDLE_COMPACT_ALLOW_BLIND` | `1` to permit blind injection |

# compaction-capture

A compaction discards context from the model's window, but the transcript on
disk is append-only — the summary it produced stays in the `.jsonl` forever.
This plugin copies that summary out to a file you can actually find.

```
/compaction-capture on       pick a folder and start capturing, for this repo
/compaction-capture off      stop capturing
/compaction-capture status   where captures go, how many exist, whether the hook ran
/compaction-capture where    show the preset folders for this repo
/compaction-capture now      capture immediately, without waiting for a compaction
```

It runs on the `PostCompact` hook, which fires after a compaction completes for
both manual and automatic triggers, and writes one markdown file per
compaction.

The hook is handed the summary in its payload, and the transcript holds a
matching entry. Both are used, because they are not the same text: the payload
copy keeps the model's `<analysis>` reasoning, which the entry drops, while the
entry carries the provenance — branch, Claude Code version, token counts — that
the payload has no field for. The `source:` line in the front matter says which
copy the body came from. Either alone is enough to write a capture.

## Where captures go

`on` offers two presets plus anything you name:

| Preset | Path |
|---|---|
| Inside this repo | `<repo>/.claude/compaction-captures/` |
| Shared folder | `~/.claude/compaction-captures/<repo-name>/` |

A repo-local folder needs no per-repo subdirectory — the repo is already the
scope. The shared folder files by repo name so projects do not pile up
together. If you pick a folder inside your repo, consider gitignoring it;
captures are conversation summaries and run to tens of kilobytes.

Either way **the choice itself is stored at the user level**, in
`~/.claude/compaction-capture/config.json`, keyed by repo path — so nothing is
added to a working tree just to record a preference, and captures stay off by
default in every repo you have not turned on.

## What a capture looks like

One file per compaction, named for when the compaction happened and what
triggered it — `2026-08-05-223612-manual.md` — with YAML front matter over the
verbatim summary text:

```yaml
---
captured_at: 2026-08-05T22:36:14.108Z
compacted_at: 2026-08-05T22:36:12.994Z
session: 08f958cb-bf78-45da-8c82-0992671a7dec
repo: claude-compaction-tools
branch: main
trigger: manual
pre_tokens: 242889
post_tokens: 21842
claude_code_version: 2.1.217
source: payload
chars: 19292
---
```

Fields Claude Code did not supply are left out rather than written empty — the
token counts come from a `compactMetadata` block that not every version emits.

The summary body is left exactly as Claude Code wrote it — no reformatting, no
section parsing — so a later pass can make of it whatever it likes.

Re-firing the hook on a compaction already captured writes nothing: each
session records the summary `uuid` it last wrote.

# compaction-guard

compaction-capture saves the summary. This plugin addresses the other half: what
the summary *left out*.

The damaging case is not losing information in general — it is losing a rule.
A dropped constraint is indistinguishable from a constraint that never existed;
there is no gap in the context where it used to be, so the next turn proceeds
confidently past it. Negative constraints are the worst of these, because their
absence silently re-enables the exact path they forbade.

```
/compaction-guard            whether the guard is on here, and in which mode
/compaction-guard show       the directive exactly as it would be injected
/compaction-guard on|off     enable or disable for this repo
/compaction-guard mode default|append|replace
/compaction-guard set <file> use a file's contents as the directive
/compaction-guard reset      drop this repo's overrides
```

The directive is stated on `SessionStart` and re-stated on `PostCompact`. Both
events take context as **plain stdout** — the structured `hookSpecificOutput`
envelope is not read on either, and writing JSON there injects nothing.

## What it can and cannot protect

- **Standing directives** — rules, constraints, instructions. The hook knows
  this text, so it restates it verbatim after every compaction. This does not
  depend on the summarizer cooperating at all.
- **In-flight task state** — which task is underway, what was just decided. A
  hook cannot know this, so it cannot restate it. Steering that needs a
  `## Compact Instructions` section in your CLAUDE.md, which is a separate and
  weaker mechanism.

## Why re-stating still helps after the fact

The `PostCompact` text lands *after* the summary, so it cannot steer the
compaction that just ran. It has two other jobs. It survives into the next one —
it cannot be compacted away by the compaction that triggered it. And it asks
whether the directives governing the current work can still be stated, turning a
loss that already happened into something sayable rather than silent.

`SessionStart` skips `resume` (the restored transcript already carries the
directive) but not `clear` — an emptied context is exactly when a standing policy
has to be present.

## Configuration

Settings live in `~/.claude/compaction-guard/config.json`, with per-repo
overrides keyed on the enclosing git worktree, so nothing is written into a
working tree to record a preference.

The shipped directive names itself as operator-configured policy. That is
deliberate: a model reads hook stdout as untrusted third-party content and will
discount an anonymous block that issues orders.

See [docs/compaction-guard-design.md](docs/compaction-guard-design.md) for the
measurements behind all of this, and the approaches that were rejected.

# Development

```
node test/run.js                      # idle-compactor
node compaction-capture/test/run.js   # compaction-capture
node compaction-guard/test/run.js     # compaction-guard
```

The suites run against a throwaway `HOME`, so they never touch your real
`~/.claude`. The first covers token accounting, threshold derivation, the
arm/disarm/re-arm lifecycle, every timer abort path, keepalive's ping/confirm/
cap loop and its own-ping-vs-real-activity disarm guard, the compaction
prompt, the CLI, and the first-run notice. The second covers summary
extraction, the
per-repo location store, the front matter, duplicate suppression, and the
malformed-input paths. The third covers which events inject and which are
skipped, the `PostCompact`-only recovery paragraph, malformed payloads — and
pins the requirement that output is plain text rather than a JSON envelope,
since that mistake fails silently.

Manifests can be checked with `claude plugin validate .claude-plugin/plugin.json`
and `claude plugin validate .claude-plugin/marketplace.json`.

## Uninstall

```
/plugin uninstall idle-compactor@jcline-claude-compaction-tools
/plugin uninstall compaction-capture@jcline-claude-compaction-tools
/plugin uninstall compaction-guard@jcline-claude-compaction-tools
rm -rf ~/.claude/idle-compactor ~/.claude/compaction-capture ~/.claude/compaction-guard
```

Captures already written are left alone — delete
`~/.claude/compaction-captures` too if you want them gone.

## License

MIT
