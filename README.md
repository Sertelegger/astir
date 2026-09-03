# ASTIR — Agent Sessions Tracked In Realtime

Know when an AI coding agent is blocked on you — and where in your repo it's working.

*astir* — awake, in motion, stirring. Which is the question: **is anything astir,
and does any of it need me?**

> **Status: early.** The daemon receives live events from real Claude Code sessions, raises notifications, and drives a macOS menu bar — including sessions on other machines. `astir view` opens the web view: a live repo map, a cross-session overview, and panels you arrange. See [ROADMAP.md](ROADMAP.md).
>
> An earlier version of this project existed and had never actually run — its hook entrypoint exported a `main()` that nothing called, so no event ever reached it, and 214 passing tests never noticed. That version's design also normalized heat colour against the *current maximum*, which is invariant under decay, so its map could never cool. Both defects were in the design, not just the code. This is the rebuild.

## Why

You run two or three sessions in parallel across different projects. One stops and waits for you to approve a command — and you don't notice, because you're on another desktop with the sound off. Twenty minutes later you check.

Astir's first job is to make that not happen. Everything else is secondary.

## What works today

- A single daemon on a fixed port, receiving hook events from live sessions
- Deterministic subagent parentage — no guessing (see below)
- Per-agent state including `blocked`, and time accounting that separates **working** from **waiting on a human**
- An OS notification when an agent becomes blocked, re-reminding every minute for
  ten minutes, then every two, then every five, then quarter-hourly — a missed
  alert is never lost, and `astir dismiss` is how you stop it
- A macOS menu-bar badge, including sessions on other machines
- `astir status` across all live sessions
- `astir view` — a live map of where a session is working, in a browser

## Install

Requires Node.js ≥ 20 and Claude Code.

```bash
npm install && npm run build
npm link                # puts `astir` on your PATH (until it's published to npm)
astir install           # registers the hooks, creates ~/.astir/token (0600)
```

`astir install` runs `claude plugin marketplace add` and `claude plugin install`
for you, so the hooks are registered without typing slash commands or editing
any config by hand. Pass `--no-plugin` to skip that and do it yourself.

It also installs the daemon token. The hooks are `type: "http"` — Claude Code
POSTs to the daemon from its own process, so nothing of astir's runs at hook time
to read `~/.astir/token`, and an http hook header can only be filled from an
environment variable. `astir install` writes `ASTIR_TOKEN` into the `env` block of
`~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`), merging into whatever is
already there and refusing to touch the file if it cannot parse it.

Your dotfiles are still not edited. A shell profile would have been the wrong
place anyway: it is only sourced by interactive shells, so Claude Code started
from the desktop app or an IDE extension would never have seen it.

Claude Code watches `settings.json`, so a session that is already running
generally picks the token up within a tool call or two — no restart needed. If
`unauthorizedIngest` keeps climbing (see below), restart it.

### Keeping it running

The daemon starts itself when a Claude Code session starts — a `SessionStart`
command hook checks the port and launches it if nothing is listening. It runs
`async`, so it never delays a session, and costs one process per *session*
rather than per tool call. `ASTIR_NO_AUTOSTART=1` turns it off.

That matters more than it sounds. The capture hooks are `type: "http"`, and an
http hook **cannot fail quietly** — its schema has no field for ignoring a
refused connection, and `async` exists only on command hooks. So a daemon that is
down turns every tool call into two visible hook errors in whatever session you
are working in. The only way to be quiet is to be running.

If you would rather have it up regardless of Claude Code — after a reboot, or for
remote sessions pushing rosters to your notifier:

```bash
astir autostart          # a LaunchAgent: starts at login, restarts on crash
astir autostart --remove
```

`astir doctor` reports which of these is in place.

**There is deliberately no npm `postinstall` that registers hooks.** Reaching
into another tool's configuration as a side effect of `npm install` would also
fire under `npm ci`, inside Docker builds, and for transitive installs where
nobody asked for it. Installing is an explicit command.

```bash
astir daemon        # one terminal
astir status        # another, while a session runs
```

```
$ astir status
d7a79b10  /Users/sascha/Projects/astir
    thinking     main               active 41s · blocked 12s

1 agent(s) waiting on you
```

**Hooks bind when a session starts.** A session that was already running when you
installed the plugin will never send anything — restart it. astir reports this
rather than showing an empty list: if the provider says sessions are running and
none of them have reached the daemon, the menu bar says so and names them.

If nothing arrives, `curl -s localhost:47000/healthz` tells you which failure it
is: `ingested` climbing means it works; `unauthorizedIngest` climbing means
`$ASTIR_TOKEN` isn't visible to Claude Code. `astir doctor` names that case
directly — it compares `settings.json` against the token file rather than
checking its own environment, which belongs to your terminal and not to the
Claude Code being diagnosed.

## Menu bar (macOS)

An always-visible badge for the one thing that matters: is something waiting on you.

```bash
brew install --cask swiftbar          # if you don't have it
ln -s "$PWD/contrib/swiftbar/astir.3s.sh" ~/path/to/your/swiftbar/plugins/
```

The badge shows a count when agents are blocked, a quiet dot while work is happening, and a warning when the daemon isn't reachable — deliberately distinct from "idle", because rendering a dead daemon as calm would be a lie.

The dropdown names *which* session needs you, how long it has actually been
waiting, and gives you somewhere to go:

- **Click a session** to jump to it. `astir focus` finds the tmux pane it lives
  in and selects it, then raises the owning application — Terminal, iTerm2,
  Ghostty, WezTerm and VS Code all work, because in every case the terminal's
  process ancestry ends at the bundle that owns the window.
- **Dismiss** stops the reminders without pretending the agent is unblocked; it
  stays listed, greyed, marked `(dismissed)`. A *new* block alerts again.
- **Notifications are clickable** and take you to the session, provided
  `terminal-notifier` is installed (`brew install terminal-notifier`). Without it
  macOS attributes notifications to *Script Editor* — so clicking one opens
  Script Editor, and they can be neither replaced nor dismissed. astir says which
  backend it is using rather than leaving you to discover that by clicking.
- **Forget** drops a session record outright.

The session name comes from Claude Code's own session slug (`astir-ac`), which
reads like a branch name but isn't one; without it, the repo directory name is
used.

All formatting lives in `astir menubar`, not in the plugin script, so it stays unit-tested and works unchanged under xbar, Hammerspoon, or a plain shell prompt if SwiftBar ever stops being the right host.

## Sessions on another machine

A session opened over SSH — VS Code Remote-SSH, or a terminal on another box —
runs its process *there*, so `claude agents --json` here cannot see it at all.
Two routes make those sessions visible, and they compose.

**Watch a host** when astir is not installed on it. Nothing is needed over there
beyond the SSH access you already have:

```bash
astir watch megabrain-dev
```

The daemon asks it `claude agents --json` every 30s through a *login* shell —
`ssh host cmd` sources no profile, so a version-managed `claude` would not be on
PATH — and the menu bar reads a cache, so no render ever waits on a round trip. A
host that stops answering is shown as unreachable rather than quietly dropped.
Remove one with `astir watch <host> --remove`, or edit `~/.astir/hosts`. Hosts
are opted in explicitly; iterating `~/.ssh/config` would connect to production
boxes and jump hosts on a timer.

**Pair a host** when astir *is* running on it. You get everything above plus live
status, because that daemon pushes its own roster down the same tunnel it uses
for doorbells — and it can reach you when an agent blocks. Where both routes know
a session it is listed once, from the push, which comes from the daemon actually
watching it.

Pair the machine once:

```bash
astir pair devbox
```

That copies the shared token over your existing SSH access and offers to add a
`RemoteForward` to `~/.ssh/config`, so the tunnel comes up automatically every
time you connect. It asks before touching your ssh config, refuses to pair a
machine that has no astir installed, and changes nothing at all if the host is
unreachable. `--dry-run` prints what it would do instead.

Afterwards:

```bash
astir notifier          # here, where you are
ssh devbox              # as you normally would — the tunnel comes with it
astir daemon            # over there. No flags: it finds this machine itself.
```

The remote daemon probes the forwarded port and attaches when it sees a notifier,
re-checking on a timer — a tunnel comes and goes with the connection, so a
one-shot probe at startup would be wrong for most of the daemon's life.

Remote sessions then appear **in your menu bar** under "Other machines", counted
in the same badge — because an agent you can't see is exactly the one that sits
blocked unnoticed. They clear themselves when answered: the sending daemon emits
an explicit `resolved` doorbell, without which a receiver only ever learns that
an agent *became* blocked and its list could never shrink. Entries also expire if
the tunnel dies, since a menu bar confidently reporting a host it can no longer
hear from is worse than one that admits it doesn't know.

No broker, no third-party service. A local desktop notification is always the floor — a dead tunnel never suppresses it.

The message that crosses the boundary is a **doorbell, not a payload**: which host, which repo, which session, why.

```
devbox · payments-api · permission_prompt
```

Never file contents, paths, tool arguments, or reasoning — note that's the repo
*name*, not its path. Detail stays on the machine where it already lives. The
hostname is shortened to its first label, so an internal domain never travels
with the doorbell, and it's omitted entirely when the alert is from the machine
you're already sitting at.

`astir doctor --notify` reports which delivery paths are live and fires a test through them. It has to ask whether you saw it: the OS reports success even when it suppressed the notification.

## Background sessions

Plugins and scripts launch Claude Code too — claude-mem runs observer sessions,
CI runs headless ones. They're real, but nothing in them will ever wait on you,
so they're grouped at the bottom rather than competing with the repos you're
actually working in:

```
2 background sessions
-- Launched by a plugin or script — nothing here waits on you
-- observer-sessions
-- observer-sessions  ·  megabrain-dev
```

The signal is the **controlling terminal** — a session you can type at has one, a
program-launched session doesn't. Not the cwd (that hardcodes one plugin's
layout), and not the provider's `kind` field, which reports `interactive` for
claude-mem's observers too. A terminal is a property of the process, so this
keeps working for other providers.

Anything astir can't classify counts as yours: `ps` doesn't exist on Windows and
a process can exit mid-poll, and hiding a session you're working in is far worse
than listing a chore. That also means a session found by SSH polling is never
classified — a terminal is a local fact — so remote background sessions are only
recognised when astir is running over there and pushing its roster.

## The overview

`astir view` opens on a list of every session astir knows about — local, silent,
and on other machines — with whatever is **waiting on you** first,
unconditionally. Each session shows its agents, what each one was sent to do,
what it is doing right now, and how long it has been doing it. Click any session
to open its map; the same page, the same token, no reload.

Sessions astir cannot hear are listed and labelled rather than filtered out. A
surface that shows only what it can hear looks calmest exactly when it is least
entitled to.

## The map

```bash
astir view              # opens the busiest session's map
astir view <sessionId>  # a particular one
astir view --print      # just print the URL
```

A treemap of the files this session has touched, grouped by directory. Two modes
over the **same geometry**:

- **Live** — decaying heat. Where work is happening *now*.
- **Session** — cumulative touches. Where work has happened *at all*.

They look alike and mean opposite things, which is why the active one is spelled
out rather than merely highlighted. A file edited heavily an hour ago and left
alone reads stone cold in live mode and hottest in session mode; both are true,
and the geometry does not move between them — `layout()` is not given heat as an
argument, so it cannot vary with the mode.

Tile *area* is √(touches), not touches: linear area would let one heavily-edited
file swallow the map and turn everything else into unclickable slivers. The
ranked list beside the map carries the real numbers.

Colour is checked rather than chosen. The ramp's lightness is strictly monotonic
and its steps stay apart under simulated protanopia, deuteranopia and
tritanopia — both asserted in CI. Heat is *also* drawn as a bar length inside
each tile, so it never depends on colour alone, and the ranked list is the
keyboard- and screen-reader-reachable equivalent of the map.

The daemon serves the page and streams frames to it over SSE: one snapshot, then
only what changed. Frames carry each file's heat *and how long ago it was
touched*, never heat-as-of-now — so the browser reproduces the decay curve
locally and the map cools smoothly between messages instead of stepping once a
second.

### About that token in the URL

`astir view` opens `http://127.0.0.1:47000/view#<token>`. The page itself is not
token-gated, because a browser cannot attach an `Authorization` header to a
top-level navigation — a gated page could never be opened by typing its address.
What it serves is an empty shell containing no session data; every route that
carries data stays gated.

The token rides in the URL **fragment**, which browsers never transmit to the
server: it appears in no request line, access log or proxy trace. The page moves
it into `sessionStorage` and clears the address bar, so a reload still works and
a screenshot does not leak it.

## How it works

```
Claude Code ──http hooks──▶  astir daemon  ──▶  notification
                             (one, fixed port)  ──▶  astir status
                                    ▲
                     claude agents --json (session discovery)
```

Hooks are `type: "http"`, posting the payload straight to the daemon — no process spawned per tool call. Provider-specific code lives only in `src/adapters/`; everything downstream branches on declared *capabilities*, never on provider name.

**Subagent parentage is exact, not inferred.** Claude Code writes an `agent-<id>.meta.json` sidecar beside each subagent transcript carrying the spawning `toolUseId`, plus `parentAgentId`/`spawnDepth` on recent versions. An absent `parentAgentId` isn't missing data — it means the parent is the main session. Other tools in this space either guess from event ordering or hardcode every agent under one root; this reads the sidecar.

## Development

```bash
npm run verify     # typecheck + lint + build + test
npm run dev:view   # the view with hot reload, against a running daemon
```

The view imports the daemon's own pure modules (`frames`, `layout`, `ramp`,
`connection`) rather than keeping a browser copy. A snapshot-plus-delta scheme
fails when the two ends disagree about what a frame means, and that disagreement
is invisible until something is quietly missing on screen — so `applyDelta` is
tested against the same fixtures as the producer that emits it.

One rule matters more than the rest, and it's in [CONTRIBUTING.md](CONTRIBUTING.md): **a passing test suite is not evidence that something works.** Entrypoints get tests that execute the built artifact. Provider fixtures are captured from real sessions, never hand-written.

The design spec is kept locally and isn't published here. Requirement ids in code comments (`CAP-05`, `MOD-01`, `PSH-06`) refer to it.

## Licence

MIT — see [LICENSE](LICENSE).
