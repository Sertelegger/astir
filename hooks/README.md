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

## Claude events

Registered: `SessionStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`,
`PostToolUseFailure`, `Notification`, `SubagentStart`, `SubagentStop`,
`Stop`, `SessionEnd`, `FileChanged`.

### `PermissionRequest`: when a dialog was claimed, not proof that one opened

Measured on Claude Code 2.1.291 and 2.1.312, in default permission mode:
`PermissionRequest` fires ~0.4 s after `PreToolUse` and the dialog is on
screen ~0.4 s after that. The `Notification` with `notification_type:
permission_prompt` comes ~6 s later. astir used to block on the Notification
only, so with the 5 s dwell an alert landed ~11 s after the prompt appeared
([#86](https://github.com/Sertelegger/astir/issues/86)).

But `PermissionRequest` is not "the dialog opened". Claude also runs it for
an ask that can never show a dialog — a background agent's, a headless
session's — and then denies the ask itself (read from the 2.1.312 binary). So
it is mapped to `permission_request`, which blocks nothing by itself: it
records that the agent claimed a dialog. The agent is blocked once the dialog
has been **seen**, and the block is dated from the claim, so the dwell runs
from when the dialog was claimed:

- **by the session listing**: `claude agents --json`, polled every 5 s,
  reads `waiting` while a tool's dialog is on screen, from the first poll
  (measured). What it is waiting for is `waitingFor: "permission prompt"`
  (read from the binary; the field itself measured on 2.1.312, on other
  dialogs). So a Bash prompt alerts about 5 s after it appears: once the dwell
  has passed and a poll has seen it. If that value were ever different, every
  alert would fall back to the Notification below, ~6 s in, never to nothing.
- **or by the Notification**, which Claude sends only while the dialog is
  still up, once you have been idle at it for 6 s. `AskUserQuestion` alerts
  this way, ~6 s in: its dialog reads `"input needed"`, which the listing
  cannot tell from what is described below.

A claim lasts **10 seconds** (`CLAIM_WINDOW_MS`). A dialog that is on screen
is seen well inside that: the first poll begun after it is up starts within
~6 s even if the one before came too early, and the Notification comes
~6.2–6.6 s in. A claim nothing sees in that time is dropped, and never blocks:
a denied background ask, or a prompt you answered or dismissed before the
first poll saw it. It is also dropped by the agent's own progress (below), or
by a listing that finds the session idle. The one exception is a claim a
sighting **held** (below): its 10 seconds run from the last sighting that held
it, so it cannot lapse while the screen keeps showing a prompt that may be its
own.

**One dialog blocks one agent.** The listing says a dialog is on screen, not
whose; several agents can hold claims at once (parallel subagents, or a claim
that outlived a prompt you answered quickly). So a sighting blocks at most one
claim:

- **None, while a seen block stands.** If an agent is already blocked on a
  prompt, the sighting is that prompt again. A request made while it is up is
  queued behind it, or one Claude denied itself; blocking it would alert about
  a prompt nobody can see.
- **Otherwise the newest open claim**, dated from its claim. Newest, because a
  claim that outlived its dialog is older than the one on screen, and blocking
  it would alert about an agent running a tool you already approved.
- **Every other open claim is held.** It may be the prompt on screen after all:
  older than a claim Claude denied itself, or queued. It does not lapse while
  sightings continue, so once the block that took them ends, the next sighting
  is its. Late, never lost.

**The Notification names no agent.** Claude builds its Notification hook input
with no agent context, so it never carries `agent_id` and lands on the main
agent (read from the 2.1.312 binary: `PermissionRequest` gets the agent, the
Notification does not). But it does say how long its dialog has been up:
Claude sends it once you have been idle at the dialog for 6 s, checked every
6 s from when it opened. So a `permission_prompt` Notification goes to the
agent with the newest claim made at least **5 seconds** before it (over a
second under the gaps measured, 6.17 s and 6.37 s) — confirming a block a sighting already
made, or blocking an open or held claim from its date — and to the main agent
only when there is none, as before #86. A claim younger than that is some
other dialog, so a block a sighting gave it was the Notification's dialog
taken for another: it is taken back, as if it had never begun, and its claim
stays held. A subagent's prompt alerts once, for the subagent; its parent is
not blocked too, and the idle timer leaves the parent alone while anyone in
the session waits on you. The Notification is still the only signal for the
other kinds, such as `agent_needs_input`. A Notification that blocks nothing
(a mod's `plugin_notification`, an MCP server's `elicitation_complete`,
`idle_prompt`, `agent_completed`, …) changes nothing about a block: not its
reason, its date, or whether the listing can end it. Nor does an
`agent_needs_input` or `worker_permission_prompt` on an agent already blocked
on a permission prompt: it is about another agent, and the reason it would
leave behind is one the listing cannot end.

**The Notification names no agent.** Claude builds its Notification hook input
with no agent context, so it never carries `agent_id` and lands on the main
agent (read from the 2.1.312 binary: `PermissionRequest` gets the agent, the
Notification does not). A `permission_prompt` Notification therefore goes to
the agent with the newest claim — confirming a block a sighting already made,
or blocking an open claim from its date — and to the main agent only when no
agent holds a claim, as before #86. A subagent's prompt alerts once, for the
subagent; its parent is not blocked too. The Notification is still the only
signal for the other kinds, such as `agent_needs_input`. A Notification that
blocks nothing (a mod's `plugin_notification`, an MCP server's
`elicitation_complete`, `idle_prompt`, `agent_completed`, …) changes nothing
about a block: not its reason, its date, or whether the listing can end it.

**What ends a block.** Only the blocked agent's own progress: `PreToolUse`,
`PostToolUse`, `PostToolUseFailure`, `Stop`, `SubagentStop`, `SessionEnd`, or a
`SessionStart` (a resume, which no dialog survives) — or the listing, below.
Not `FileChanged`: it names no agent, so it lands on the main agent for any
write to a watched path — your editor's, another session's, a background
agent's — and a file changing is not an answer. Not `SubagentStart`, and not
a notification. The same events, and only those, end a claim. A test pins the
list against every event kind.

Also measured:

- **The auto-mode classifier.** When it approves without a dialog,
  `PermissionRequest` does not fire at all (PreToolUse, then PostToolUse). The
  dwell absorbs any automatic answer that comes after a block.
- **`AskUserQuestion`.** It fires `PermissionRequest` too (`tool_name:
  AskUserQuestion`), then the Notification. It is a question you have to
  answer, so it blocks like any other prompt.
- **Esc fires no hook at all.** There is no `PermissionDenied`, `Stop`,
  `StopFailure` or `PostToolUseFailure`. So a block has to be ended by
  something else: the same listing. `idle` (or `shell`, see below) ends the
  block and the agent is `waiting` on you. `busy` after a poll that saw a
  dialog during that agent's block means nothing is on screen any more: you
  approved and the tool is running. The sighting is each blocked agent's own:
  another agent's later claim does not erase it, since that agent's dialog
  would read `waiting` too. A `busy` with no such sighting before it proves
  nothing: for `AskUserQuestion` the listing read `busy` a second into the
  open dialog. This is the `listingClearsBlocks`
  capability (`src/contract/capabilities.ts`), and the registry applies it in
  `reconcile`. Only `permission_prompt` blocks are ended this way.

What the listing says is translated where it is read
(`src/discovery/sessions.ts`, `DiscoveredSession.screen`): a permission dialog,
some other dialog, at the prompt, or working. The registry reads only that,
never Claude's own words (CAP-02).

What the listing can and cannot say:

- **`waitingFor`.** `"permission prompt"` is the binary's DEFAULT: it is what
  every dialog reads that declares nothing else, which is a tool's permission
  dialog but also plan approval, entering plan mode, "a message from another
  session needs your approval", browser and Chrome setup, computer-use
  approval and auto-mode setup proposals. `"input needed"` is
  `AskUserQuestion`, an MCP elicitation, and an elicitation queued behind
  another dialog; `"dialog open"`, `"worker request"`, `"sandbox request"` and
  `"goal proposal"` are declared by their own dialogs (read from the binary,
  2.1.296–2.1.312; the field itself measured on 2.1.312). Only
  `"permission prompt"` is taken as a sighting, and since it is not only a
  tool's dialog, it blocks only a claim still inside its 10 seconds — never
  one older. `waiting` for anything else is no evidence either way.
- **A queued elicitation hides everything.** Claude checks it before anything
  else, so while one waits the session reads `waiting` / `"input needed"`
  whatever is on screen, even while working. Four of thirteen sessions read
  that on the machine this was measured on. In such a session the listing
  never says `idle` or `busy`, so a block seen by its Notification ends only
  on the agent's next event, as before #86.
- **`shell` arrives as `busy`.** Claude's own session file says `shell` for a
  session idle at its prompt with a background shell running, but
  `claude agents --json` reports every status except `idle` and `waiting` as
  `busy` (read from the binary, 2.1.296–2.1.312). So after Esc, a session
  with a background shell or agent running reads as an approved tool: the
  block ends and its alert is resolved, but the agent shows `tool-running`
  until its next event. astir reads `shell` as `idle` in case it ever comes
  through.

**The reply decides nothing.** Claude reads an http hook's JSON body as hook
output, and for `PermissionRequest` a `hookSpecificOutput.decision` would
allow or deny the tool for you. The daemon answers `{ok, applied}` and
nothing else. A test holds it to that.

The payloads are in `test/fixtures/claude/permission-request.json`, sanitised
from one real dialog.

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
to act on. The per-tool events skip the walk: they are the hot path. A
session that has not reported a pid yet is left alone rather than swept for
being quiet — discovery could never have seen it, and quiet is what a blocked
agent looks like.

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
events. Every registered event has been captured from a real session
(`test/fixtures/codex/capture.json`, codex-cli 0.154.0 and 0.165.0) except one
shape: a subagent's own tool call, which carries `agent_id`. The one captured
subagent ran no tool, so that payload is built from Codex's declared schema
(`test/fixtures/codex/declared.json` says so and cites the source).

`SessionEnd` and `Interrupt` have a 3-second timeout because Codex clamps them
to that and warns at every session start otherwise. On Windows, Codex runs
`commandWindows` instead, through PowerShell.
