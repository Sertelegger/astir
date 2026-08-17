# Clide

Know when an AI coding agent is blocked on you — and where in your repo it's working.

> **Status: early.** The daemon receives live events from real Claude Code sessions, raises notifications, and drives a macOS menu bar — including sessions on other machines. The repo *map* and web view aren't built yet. See [ROADMAP.md](ROADMAP.md).
>
> An earlier version of this project existed and had never actually run — its hook entrypoint exported a `main()` that nothing called, so no event ever reached it, and 214 passing tests never noticed. That version's design also normalized heat colour against the *current maximum*, which is invariant under decay, so its map could never cool. Both defects were in the design, not just the code. This is the rebuild.

## Why

You run two or three sessions in parallel across different projects. One stops and waits for you to approve a command — and you don't notice, because you're on another desktop with the sound off. Twenty minutes later you check.

Clide's first job is to make that not happen. Everything else is secondary.

## What works today

- A single daemon on a fixed port, receiving hook events from live sessions
- Deterministic subagent parentage — no guessing (see below)
- Per-agent state including `blocked`, and time accounting that separates **working** from **waiting on a human**
- An OS notification when an agent becomes blocked, re-reminding every minute for
  ten minutes, then every two, then every five, then quarter-hourly — a missed
  alert is never lost, and `clide dismiss` is how you stop it
- A macOS menu-bar badge, including sessions on other machines
- `clide status` across all live sessions

## Install

Requires Node.js ≥ 20 and Claude Code.

```bash
npm install && npm run build
npm link                # puts `clide` on your PATH (until it's published to npm)
clide install           # registers the hooks, creates ~/.clide/token (0600)
```

`clide install` runs `claude plugin marketplace add` and `claude plugin install`
for you, so the hooks are registered without typing slash commands or editing
any config by hand. Pass `--no-plugin` to skip that and do it yourself.

One step is left to you on purpose: exporting `CLIDE_TOKEN` in your shell
profile. Hooks read it via `$CLIDE_TOKEN`, and clide does not edit your dotfiles.
`clide install` prints the exact line.

**There is deliberately no npm `postinstall` that registers hooks.** Reaching
into another tool's configuration as a side effect of `npm install` would also
fire under `npm ci`, inside Docker builds, and for transitive installs where
nobody asked for it. Installing is an explicit command.

```bash
clide daemon        # one terminal
clide status        # another, while a session runs
```

```
$ clide status
d7a79b10  /Users/sascha/Projects/clide
    thinking     main               active 41s · blocked 12s

1 agent(s) waiting on you
```

If nothing arrives, `curl -s localhost:47000/healthz` tells you which failure it is: `ingested` climbing means it works; `unauthorizedIngest` climbing means `$CLIDE_TOKEN` isn't visible to Claude Code.

## Menu bar (macOS)

An always-visible badge for the one thing that matters: is something waiting on you.

```bash
brew install --cask swiftbar          # if you don't have it
ln -s "$PWD/contrib/swiftbar/clide.3s.sh" ~/path/to/your/swiftbar/plugins/
```

The badge shows a count when agents are blocked, a quiet dot while work is happening, and a warning when the daemon isn't reachable — deliberately distinct from "idle", because rendering a dead daemon as calm would be a lie.

The dropdown names *which* session needs you, how long it has actually been
waiting, and gives you somewhere to go:

- **Click a session** to jump to it. `clide focus` finds the tmux pane it lives
  in and selects it, then raises the owning application — Terminal, iTerm2,
  Ghostty, WezTerm and VS Code all work, because in every case the terminal's
  process ancestry ends at the bundle that owns the window.
- **Dismiss** stops the reminders without pretending the agent is unblocked; it
  stays listed, greyed, marked `(dismissed)`. A *new* block alerts again.
- **Forget** drops a session record outright.

The session name comes from Claude Code's own session slug (`clide-ac`), which
reads like a branch name but isn't one; without it, the repo directory name is
used.

All formatting lives in `clide menubar`, not in the plugin script, so it stays unit-tested and works unchanged under xbar, Hammerspoon, or a plain shell prompt if SwiftBar ever stops being the right host.

## Sessions on another machine

A session running behind SSH, inside WSL, or in a container can still reach you. Run the notifier where *you* are, and point the remote daemon at it:

```bash
# on your workstation
clide notifier                       # listens on 127.0.0.1:47001

# forward the port to the box running the agent
ssh -R 47001:127.0.0.1:47001 devbox

# on that box
clide daemon --notify-url http://127.0.0.1:47001/notify --notify-token <shared>
```

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

`clide doctor --notify` reports which delivery paths are live and fires a test through them. It has to ask whether you saw it: the OS reports success even when it suppressed the notification.

## How it works

```
Claude Code ──http hooks──▶  clide daemon  ──▶  notification
                             (one, fixed port)  ──▶  clide status
                                    ▲
                     claude agents --json (session discovery)
```

Hooks are `type: "http"`, posting the payload straight to the daemon — no process spawned per tool call. Provider-specific code lives only in `src/adapters/`; everything downstream branches on declared *capabilities*, never on provider name.

**Subagent parentage is exact, not inferred.** Claude Code writes an `agent-<id>.meta.json` sidecar beside each subagent transcript carrying the spawning `toolUseId`, plus `parentAgentId`/`spawnDepth` on recent versions. An absent `parentAgentId` isn't missing data — it means the parent is the main session. Other tools in this space either guess from event ordering or hardcode every agent under one root; this reads the sidecar.

## Development

```bash
npm run verify     # typecheck + lint + build + test
```

One rule matters more than the rest, and it's in [CONTRIBUTING.md](CONTRIBUTING.md): **a passing test suite is not evidence that something works.** Entrypoints get tests that execute the built artifact. Provider fixtures are captured from real sessions, never hand-written.

The design spec is kept locally and isn't published here. Requirement ids in code comments (`CAP-05`, `MOD-01`, `PSH-06`) refer to it.

## Licence

MIT — see [LICENSE](LICENSE).
