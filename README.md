# claude-idle-compactor

Runs `/compact` automatically when a Claude Code session goes idle, timed to
land just before the Anthropic prompt cache expires.

## Why the timing matters

Anthropic's prompt cache has exactly two TTLs: **5 minutes** (the default
`cache_control: {"type": "ephemeral"}`) and **1 hour** (`"ttl": "1h"`). While a
session's cached prefix is alive, re-sending it costs about 0.1× base input.
Once it expires, the next turn pays a full cache write at 1.25× (5m) or 2× (1h).

So the useful moment to compact is *one minute before the cache dies*:

- Late enough that a user who comes straight back still lands on a warm cache.
- Early enough that the compaction request itself reads the warm prefix instead
  of paying to re-write the whole thing.

That is the default: **59 minutes** for the 1-hour TTL, **4 minutes** for the
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
/plugin marketplace add JimCline/claude-idle-compactor
/plugin install idle-compactor@jimcline-plugins
```

On the first session after installing, the plugin asks you two things: the idle
threshold, and the minimum context size worth compacting. Run `/idle-compact
setup` any time to change your mind.

## Usage

```
/idle-compact                 show current settings and armed timers
/idle-compact on              enable
/idle-compact off             disable and cancel every pending timer
/idle-compact 1h              use the 1-hour cache TTL  → 59 minutes
/idle-compact 5m              use the 5-minute cache TTL →  4 minutes
/idle-compact 25              use an explicit 25-minute threshold
/idle-compact min-tokens 40000   only compact above this context size
/idle-compact min-tokens 0       no floor; compact whenever idle
/idle-compact blind on|off    allow or block focus-based injection
/idle-compact test            show which injection method would be used
/idle-compact test send       actually type a harmless command, end to end
/idle-compact doctor          full diagnostics
/idle-compact paths           absolute node and plugin paths
/idle-compact reset           restore defaults
/idle-compact setup           re-run the first-run configuration
```

## Terminal support

| Terminal | Method | Targeted? | Notes |
|---|---|---|---|
| tmux | `send-keys -t $TMUX_PANE` | yes | |
| GNU screen | `-X stuff` | yes | |
| WezTerm | `wezterm cli send-text --pane-id` | yes | |
| kitty | `kitty @ send-text --match id:` | yes | needs `allow_remote_control yes` |
| iTerm2 | AppleScript, matched on `ITERM_SESSION_ID` | yes | |
| Apple Terminal | AppleScript, matched on the tab's tty | yes | |
| X11 | `xdotool --window $WINDOWID` | yes | only when `WINDOWID` is set |
| X11 | `xdotool` to the active window | **no** | opt-in |
| Wayland | `ydotool` | **no** | opt-in, needs `ydotoold` |
| Windows | PowerShell `AppActivate` + `SendKeys` | **no** | opt-in |

Providers are tried in that order and the first one that succeeds wins. If your
terminal is not listed and you are not in tmux, the plugin will detect nothing
and stay dormant — running Claude Code inside tmux is the most portable fix.

macOS will ask for Automation permission the first time the AppleScript
providers run.

### Blind injection

`xdotool` without `WINDOWID`, `ydotool`, and Windows `SendKeys` type into
whatever window has focus. If you have alt-tabbed away, `/compact` gets typed
into that other application instead. They are therefore **off by default**:

```
/idle-compact blind on
```

Only enable this if you understand that trade-off.

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

## Development

```
node test/run.js
```

The suite runs against a throwaway `HOME`, so it never touches your real
`~/.claude/idle-compactor`. It covers token accounting, threshold derivation,
the arm/disarm/re-arm lifecycle, every timer abort path, the CLI, and the
first-run notice.

Manifests can be checked with `claude plugin validate .claude-plugin/plugin.json`
and `claude plugin validate .claude-plugin/marketplace.json`.

## Uninstall

```
/plugin uninstall idle-compactor@jimcline-plugins
rm -rf ~/.claude/idle-compactor
```

## License

MIT
