# Clide

Know when an AI coding agent is blocked on you — and where in your repo it's working.

> **Status: early rebuild.** The daemon receives live events from real Claude Code sessions and raises a notification when an agent needs your input. The visual surfaces (menu bar, map, web view) are not built yet. See [ROADMAP.md](ROADMAP.md).
>
> An earlier version of this project existed and had never actually run — its hook entrypoint exported a `main()` that nothing called, so no event ever reached it, and 214 passing tests never noticed. That version's design also normalized heat colour against the *current maximum*, which is invariant under decay, so its map could never cool. Both defects were in the design, not just the code. This is the rebuild.

## Why

You run two or three sessions in parallel across different projects. One stops and waits for you to approve a command — and you don't notice, because you're on another desktop with the sound off. Twenty minutes later you check.

Clide's first job is to make that not happen. Everything else is secondary.

## What works today

- A single daemon on a fixed port, receiving hook events from live sessions
- Deterministic subagent parentage — no guessing (see below)
- Per-agent state including `blocked`, and time accounting that separates **working** from **waiting on a human**
- An OS notification when an agent becomes blocked
- `clide status` across all live sessions

## Try it

Requires Node.js ≥ 20 and Claude Code.

```bash
npm install
npm run build
node dist/cli/main.js install     # prints setup; creates ~/.clide/token (0600)
```

Follow the printed steps — export `CLIDE_TOKEN`, install the plugin — then:

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

The badge shows a count when agents are blocked, a quiet dot while work is happening, and a warning when the daemon isn't reachable — deliberately distinct from "idle", because rendering a dead daemon as calm would be a lie. The dropdown names *which* session needs you.

All formatting lives in `clide menubar`, not in the plugin script, so it stays unit-tested and works unchanged under xbar, Hammerspoon, or a plain shell prompt if SwiftBar ever stops being the right host.

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
