# The capture hooks

`hooks.json` is read by Claude Code against a schema that rejects unknown keys,
so this prose lives here rather than in a `_comment` field. It sits beside the
file it explains for the same reason it was in the file: a rationale a directory
away from its subject is one nobody reads at the moment they need it.

## `type: "http"`, not `command`

There is no process to spawn, so no Node startup cost per tool call.

**`async` is deliberately absent, and cannot be present** — it is a
command-hook-only field. An http hook is synchronous, which is safe here because
the receiver is a local in-memory server: an absent daemon refuses the
connection immediately, and a hung one is bounded by the explicit timeout in the
file. The platform default is 600s, which is not a budget.

## The token

It comes from `$ASTIR_TOKEN`. If that variable is unset the header interpolates
to an **empty string** rather than failing, so every event is rejected while
everything still appears wired. The daemon therefore counts unauthorized ingest
separately from silence — `unauthorizedIngest` climbing and `ingested: 0` are
different diagnoses. `astir install` writes the variable; `astir doctor` names
the case directly.

## Why `SessionStart` starts the daemon

It also runs `ensure-daemon.sh`, which launches the daemon if nothing is
listening. **This is the answer to hook noise.** An http hook cannot fail
quietly — there is no field for it, and `async` is command-hook-only — so a
daemon that is down turns every tool call into two visible errors in whatever
session you are working in. The only way to be quiet is to be running.

Starting it here costs one process per *session* rather than per tool call, and
that hook is a command hook with `async: true`, so it never delays a session
coming up. `ASTIR_NO_AUTOSTART=1` disables it.

## Codex: `codex-hooks.json`

Codex runs **command hooks only** — there is no `type: "http"` — so each of
its hooks runs `codex-relay.sh`, which finds `node` and hands the payload to
`codex-relay.mjs`, which POSTs it to `/hook/codex`. `.codex-plugin/plugin.json`
points Codex at `codex-hooks.json` explicitly; without that pointer Codex would
read `hooks.json`, whose `type: "http"` hooks fail to parse, so no astir hook
would run at all.

Every fact below was checked against Codex's source at `rust-v0.154.0`.

### The exit code is a decision

Codex reads exit 2 plus stderr as an answer: it **denies** a
`PermissionRequest`, **blocks** a `PreToolUse`, **replaces the tool's result**
in `PostToolUse`, and re-prompts the model from `Stop`. If the script were
missing — an upgrade deletes the old plugin folder while a turn is running —
`sh` would exit 2 with an error. So every command ends in
`2>/dev/null || true`, and the relay itself always exits 0 and prints nothing
(`SessionStart` stdout also becomes model context).

### Synchronous on purpose

Codex waits for a synchronous hook before going on, so `PreToolUse`'s POST
has landed before the `PermissionRequest` 60ms behind it starts. An `async`
relay would let the two race to the daemon, and a block applied before the
tool start that preceded it is a block lost. So the relay is synchronous and has a hard 2-second budget for
its whole process — not a socket timeout, which measures idle time and never
fires on a daemon trickling bytes. `ensure-daemon.sh` is `async`: nothing
depends on its order.

### What it sends: an allowlist

The ids, the event, the cwd, the tool's name, and from the tool's input only
the path arguments and an `apply_patch`'s directive lines. Command text, patch
bodies, tool output, the prompt and the model's reply never leave Codex
(SEC-01). It also keeps a large patch under the daemon's 1 MiB body limit,
which would otherwise lose the `PermissionRequest` riding with it. A test
asserts that the cut-down payload normalizes to exactly the same event as the
full one.

### Which process it is

Codex has no session listing, so the daemon cannot ask whether a Codex session
is still alive. On `SessionStart`, `PermissionRequest`, `Stop` and `Interrupt`
the relay walks up the process table to the native `codex` binary it runs
under and sends that pid in an `X-Astir-Agent-Pid` header. The daemon then
treats "that pid still belongs to a process with the same start time" as
discovery for Codex (`src/discovery/pids.ts`), so a session that dies without
`SessionEnd` is reaped, a block survives a daemon restart, and focus has a pid
to act on. The per-tool events skip the walk: they are the hot path.

### The token, and the proxy

No `ASTIR_TOKEN` plumbing: a command hook is astir's own code running, so the
relay reads `~/.astir/token` the way every other astir process does
(`$ASTIR_TOKEN` still wins when set). It never goes through an HTTP proxy —
Node honours `HTTP_PROXY` under `NODE_USE_ENV_PROXY`, and `NO_PROXY=localhost`
does not cover `127.0.0.1` — and the wrapper clears `NODE_OPTIONS` so a user's
Node flags cannot make it print.

### Events

Registered: `SessionStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`,
`Stop`, `Interrupt`, `SessionEnd`, `SubagentStart`, `SubagentStop`. Not
`UserPromptSubmit`, whose only content is the prompt, and not the compaction
events. `Interrupt` and the two subagent events are mapped from Codex's
declared schema; no captured session has produced one yet
(`test/fixtures/codex/declared.json` says so and cites the source).

`SessionEnd` and `Interrupt` have a 3-second timeout because Codex clamps them
to that and warns at every session start otherwise. On Windows, Codex runs
`commandWindows` instead, through PowerShell.
