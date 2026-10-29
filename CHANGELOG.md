# Changelog

All notable changes to astir are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) with **one stated
addition**: a `Known limitations` section, for behaviour that is easy to mistake
for a bug.

Scope and design constraints live in [CONTRIBUTING.md](./CONTRIBUTING.md); what is being built
is in the [issues](https://github.com/Sertelegger/astir/issues) and [milestones](https://github.com/Sertelegger/astir/milestones). How a
release is cut, named and published is in
[CONTRIBUTING.md](./CONTRIBUTING.md#releases).

## [Unreleased]

### Added

- **astir in the terminal**
  ([#80](https://github.com/Sertelegger/astir/issues/80)).
  - `astir status --line` prints one line or nothing, for a tmux status bar
    on a machine with no menu bar. It shows what would keep you from being
    told (no daemon, another machine's daemon on the port, no notifier
    reachable), then how many announced blocks are waiting and for how long.
    It shows counts only, never session names.
  - `astir-tui` is a separate, opt-in plugin in the same marketplace. It is a
    Claude Code mod that draws that line under the prompt and an `astir <n>`
    label in the footer, and does nothing else.
- **`/astir`**, a pane in astir-tui
  ([#81](https://github.com/Sertelegger/astir/issues/81)).
  - It lists every session, blocked first, with how long each has waited.
  - `g` takes you to the session that has waited longest: it selects that
    session's tmux pane, which on Linux nothing else could do.
  - `d` dismisses it, on any machine.
  - Remote sessions get no Go, because there is nothing here to raise.
  - It opens mid-turn without interrupting it, and never shows rows from a
    reading astir could not vouch for.
- `astir` takes `--` to end its options, so an id passed after it is never read
  as a flag.
- `/state` 2.2: every agent carries `announcedAt`, the moment the notify loop
  decided to interrupt you about it. It is not persisted: a block restored
  after a restart proves itself again before it is announced.

- **Codex is a second provider**
  ([#24](https://github.com/Sertelegger/astir/issues/24)). A Codex session shows
  up beside your Claude Code ones: in the menu bar, in `astir status`, in the
  overview, and with an alert when it is waiting on a permission prompt. Files
  it changes with `apply_patch` light up on the map. `astir install` registers
  the plugin with Codex when `codex` is on your PATH; the next `codex` session
  asks you to trust its hooks. The adapter was written against payloads
  captured from codex-cli 0.154.0, and every assumption about how Codex runs a
  hook was checked against its source.

- `astir doctor` reports which plugin version is actually installed, per profile
  and per scope, and names any that is behind the running binary. The hooks run
  from a cached copy of the plugin and the binary runs from wherever it was
  built, so the two drift silently — and because one install key holds several
  scopes, updating one and believing it done is the common failure rather than
  the exotic one.

### Fixed

- **A Claude alert came about 6 seconds late**
  ([#86](https://github.com/Sertelegger/astir/issues/86)). astir waited for
  Claude's `permission_prompt` notification, which arrives about six seconds
  after the prompt appears, and then waited its own five seconds on top. It
  now dates the wait from `PermissionRequest`, which Claude sends just before
  the prompt, so the alert comes about five seconds after the prompt instead
  of about eleven. `PermissionRequest` alone does not block, because Claude
  also sends it for requests that never show a prompt (a background agent's,
  which Claude then denies itself). The agent counts as blocked once the
  prompt has been seen: Claude's session list (`claude agents --json`, which
  astir already polls every 5 seconds) reports a `permission prompt` on
  screen, or the notification arrives. When auto mode approves something
  without a prompt, Claude sends no `PermissionRequest`, so nothing changes
  there.
- **Pressing Esc at a Claude prompt left the agent blocked**
  ([#86](https://github.com/Sertelegger/astir/issues/86)). Claude sends nothing
  when you dismiss a prompt, so astir kept counting the agent as blocked, and
  kept reminding you, until the session did something else. astir now reads
  the status the same session list reports. When it says the session is
  `idle` (or `shell`, idle with a background shell running), the agent counts
  as waiting on you, and an alert already sent is followed by a `resolved`.
  When it says `busy` after it saw that agent's prompt, you approved it: a
  command that runs a long time counts as running, not as a prompt you have
  not answered, even if another agent asked for something since.
- **A subagent's Claude prompt was reported as its parent's**
  ([#86](https://github.com/Sertelegger/astir/issues/86)). Claude's
  `permission_prompt` notification never says which agent it is about, so
  astir put it on the main agent, which then stayed blocked, and reminding,
  until the subagent finished. astir now gives it to the agent that asked for
  the prompt and to the main agent only when no agent has asked. Claude sends
  the notification once the prompt has been up 6 seconds, so a request made
  less than 5 seconds before it is another prompt, and if several older ones
  are open it is the most recent. One prompt blocks one agent and raises one
  alert, and the subagent's parent shows as running it, not as blocked.
- **A file changing while a Claude prompt was open counted as an answer**
  ([#86](https://github.com/Sertelegger/astir/issues/86)). Claude reports a
  watched file changing without saying which agent it was, so any write (your
  editor's, another session's, a background agent's) ended the main agent's
  block, sent a `resolved` and stopped the reminders, with the prompt still on
  screen. Now only the blocked agent's own progress ends a block: it runs or
  finishes a tool, ends its turn, stops, or its session ends or restarts. Or
  Claude's session list shows the prompt has gone. A notification that blocks
  nothing (from a mod, an MCP server, or one saying an agent finished) no
  longer replaces the reason for a block either, which had kept Esc from
  ending it. Nor does one saying another agent needs your input, which arrived
  on the main agent and kept it blocked after Esc.
- **A machine that cannot show a notification no longer reports that it did**
  ([#78](https://github.com/Sertelegger/astir/issues/78)).
  - On a Linux box with no `notify-send` or no desktop session, the local
    path was listed as live and every block counted as delivered. On a
    container whose only real path is an `ssh -R` tunnel, that meant nobody
    was told whenever the tunnel dropped.
  - Each path now says whether it can deliver. `/healthz` lists the live
    ones, and the daemon's startup line, its tunnel-loss line and
    `astir doctor` name a dead one and why.
  - A notifier that cannot show a doorbell refuses it, and says so on its
    `/healthz`, so the sending daemon knows too. A local notifier that runs
    and fails (a headless box with a session bus but nothing to show on) is
    a failed delivery, not a delivered one.
- **A notifier astir cannot reach is no longer shown as "no remote agents"**
  ([#79](https://github.com/Sertelegger/astir/issues/79)). Where one is
  expected (the notifier service is installed, or `astir pair` set up a
  forward), the menu says it is unreachable. A machine that never paired
  anything stays calm.
- `hooks/hooks.json` no longer carries a `_comment` key, which Claude Code
  reported as an unknown key on every session start. JSON has no comments; the
  prose moved to `hooks/README.md`.

### Changed

- The release checklist now includes updating the installed plugin. Bumping
  `marketplace.json` lets an install see that a new version exists; it does not
  fetch it, and CONTRIBUTING previously implied otherwise.

### Known limitations

- **A Claude prompt you have answered or dismissed can still count as blocked
  for up to one poll of Claude's session list (5 seconds)**
  ([#86](https://github.com/Sertelegger/astir/issues/86)). That is how astir
  learns it is over. If the alert goes out in that window, a `resolved`
  follows.
- **An `AskUserQuestion` prompt alerts after about 6 seconds, not 5**
  ([#86](https://github.com/Sertelegger/astir/issues/86)). Claude's session
  list reports it as `input needed`, which it also reports for other things,
  so astir waits for Claude's own notification, which comes about 6 seconds
  in if you are not at the keyboard.
- **In a Claude session with an MCP request waiting in the background, Esc
  after the alert still leaves the agent blocked until it does something
  else** ([#86](https://github.com/Sertelegger/astir/issues/86)). While an MCP
  server's request is queued behind another prompt, Claude's session list
  reports the session as `waiting` for `input needed` the whole time, whatever
  happens. So it cannot say the prompt is gone. This is how every Claude
  prompt behaved before #86. A prompt dismissed there before its
  notification is never counted at all.
- **Esc at a Claude prompt while a background shell or agent is running
  shows the agent as running a tool**
  ([#86](https://github.com/Sertelegger/astir/issues/86)). Claude's session
  list reports such a session as `busy`, which is also what an approved
  command looks like. The block still ends and the alert is resolved. The
  agent shows `tool-running` until it next does something.
- **When agents in one Claude session ask for permission close together, an
  alert can name the wrong one, or come late**
  ([#86](https://github.com/Sertelegger/astir/issues/86)). Claude's session
  list says a prompt is on screen, not whose. Until one has been seen, astir
  takes a sighting to be the most recent request, because an older request may
  be one you already approved, and blocking that agent would alert you about a
  command already running. Once one has been seen, later sightings are taken
  to be that prompt, and a request made meanwhile waits: it is alerted when the
  first block ends, or by Claude's notification once its own prompt has been
  up 6 seconds. The agent whose prompt you answered first counts as blocked
  until the session list stops showing a prompt.
- **A request Claude refuses on its own can be taken for a real prompt**
  ([#86](https://github.com/Sertelegger/astir/issues/86)). In some contexts (a
  resumed or forked agent, for example) Claude turns a background agent's
  request down itself without showing a prompt. If that happens while another
  agent's prompt is open and not yet seen, astir can count the background agent
  as blocked. Claude's notification, sent 6 seconds into the real prompt if
  you have not touched the terminal, corrects that before the background
  agent's alert would go out, unless the two requests came within about a
  second and a half of each other. Otherwise the background agent counts as
  blocked until it next does something, and can be alerted. The real prompt is never dropped: astir keeps it while the session
  list keeps showing a prompt, and alerts it as soon as the background agent's
  block ends.
- **A request is only matched to a prompt for 10 seconds**
  ([#86](https://github.com/Sertelegger/astir/issues/86)). A prompt on screen
  is seen within about 6 seconds, by the session list or Claude's
  notification. After 10 seconds an unseen request is dropped, and a prompt
  first seen later counts from when it was seen. A request passed over for
  another while the session list showed a prompt is kept for 10 seconds after
  the last such sighting instead. Claude's session list also reports other
  dialogs as a `permission prompt`, including plan approval, approving a
  message from another session, and browser setup. One of these can be taken
  for a request made, or kept, in the 10 seconds before it. After that window
  it never is.
- **Only Claude's own permission prompts end when its session list goes
  idle.** A notification about another agent needing input
  (`agent_needs_input`) is not about this session's prompt, so it still ends
  only when the agent does something.
- **A Codex permission alert waits 30 seconds, not 5.** Codex's automatic
  reviewer answers many requests itself, and the one captured took ~12s; a
  shorter wait would alert you about decisions that were never yours. The
  menu-bar badge is not delayed.
- **An approved Codex command that runs long can still raise a false alert.**
  Codex says nothing between approving a request and the tool finishing, so a
  command its reviewer approved at ~12s that then runs for another 20s looks
  exactly like a request nobody has answered. The alert is followed by a
  `resolved` when it finishes.
- **A Codex session's map shows only what it wrote.** Codex reads files through
  its shell, which names no paths astir can trust, so reads and shell-driven
  writes leave no trace. Claude's map shows both.
- **A Codex subagent's own tool calls are mapped from Codex's declared schema,
  not a capture.** `Interrupt`, `SubagentStart` and `SubagentStop` have now been
  captured (codex-cli 0.165.0) and behave as mapped, but the one subagent
  captured ran no tool. The fixture says so, and that is the first thing to
  re-check when one does.
- **A Codex permission can stop counting as waiting on you before you answer
  it.** Codex runs tool calls in parallel, and astir does not track which call
  a permission is about — the request names none, and astir keeps no per-call
  state — so when another call in the same batch finishes first astir takes
  that as the answer. Within the 30-second wait that means no
  alert at all; after it, a `resolved` and no more reminders — while the prompt
  is still open in Codex.
- **A Codex session reports no busy/idle status of its own**, so between
  events astir waits up to 15 minutes before calling a silent one idle.
  Claude's discovery answers that within seconds.
- **Codex on Windows is untested.** The hooks carry a PowerShell command, but
  nothing has run it. Without `ps` the relay cannot name the Codex process, so
  a Codex session there that dies without `SessionEnd` is not cleaned up —
  the same is true anywhere for one that dies in its first turn, before any
  event that carries the pid.

## [0.2.0] — 2026-09-11 (Bagel)

The first release under the name **astir**. 0.1.0 shipped as `clide`, so
upgrading is not automatic — see below.

Milestone 3 is complete: `astir view` opens a live repo map, a cross-session
overview and panels you arrange. Agent state now survives a daemon restart.

### Upgrading from 0.1.0

0.1.0 installed itself as `clide`, and **nothing migrates it**. Astir does not
detect or remove the old install — it does not reach into another tool's
configuration, and it cannot safely guess at yours. Four things to do by hand,
in this order:

1. **Stop the old service first.** `com.clide.daemon` has `KeepAlive`, so it
   restarts itself and holds port 47000 — the new daemon then cannot bind, and
   nothing says why.
   ```bash
   launchctl bootout gui/$(id -u)/com.clide.daemon 2>/dev/null
   rm -f ~/Library/LaunchAgents/com.clide.daemon.plist
   ```
2. **Uninstall the old plugin**, or both hook sets POST to the same daemon:
   ```bash
   claude plugin uninstall clide@clide-marketplace
   ```
   Leaving it produces a **misleading diagnosis**, which is the reason this is
   step 2 and not a footnote. The old hooks send `$CLIDE_TOKEN`, which is no
   longer an allowed environment variable and interpolates to empty, so every
   one is rejected. `unauthorizedIngest` climbs and the daemon reports that your
   hooks are misconfigured — while the new hooks are working perfectly.
3. **Re-run `astir install`.** `~/.clide/token` is not read; a fresh token is
   written to `~/.astir/token`. Remove `CLIDE_TOKEN` from the `env` block of
   `~/.claude/settings.json` once the old plugin is gone.
4. **Re-add watched hosts.** `~/.clide/hosts` is not read, so every
   `clide watch <host>` is lost: `astir watch <host>` again.

Nothing under `~/.clide/` is deleted. Remove it once you are satisfied.

### Added

- **The web view** (`astir view`): a live repo map, a cross-session overview
  ordered worst-first, a session switcher that needs no reload, and panels you
  arrange and hide, persisted per project.
- **Agent state survives a daemon restart.** A bounded snapshot of agent state —
  not the map — is written to `~/.astir/state.json` and restored only when the
  provider confirms the same session id, pid and start time. `blocked` and its
  accounting come back rather than starting from nothing.
- **A silent session says what the provider says about it.** A session astir has
  heard nothing *from* is not one it knows nothing *about*; its state now
  reaches every surface, and a session that predates the daemon is no longer
  told to restart.
- `astir --version`, and a state badge on remote menu-bar rows.
- Sessions are discovered across **every Claude Code profile** on the machine,
  not only the one the daemon inherited.
- The daemon identifies itself (`role`, `host`) so a forwarded port cannot be
  mistaken for the local daemon — see `Known limitations`.

### Changed

- **Renamed from `clide` to `astir`** — the binary, `~/.astir/`, `ASTIR_TOKEN`,
  the LaunchAgent label, the plugin and marketplace ids, and the hook manifest.
  This is the breaking change; see *Upgrading* above.
- A provider is now a normalizer plus a route, so a second one is additive.
- `astir status` no longer prints "no live sessions" while sessions are running
  but unheard; `astir doctor` counts those too.

### Fixed

- A daemon read its own roster back through the tunnel and listed itself under
  "Other machines".
- One process appeared as two sessions when two profiles each knew it; where
  those two disagree, the busier view now wins.
- A half-open stream said "Live" forever — a suspended laptop or severed tunnel
  never closes the socket, so nothing errored.
- A stalled SSE client no longer grows the daemon's write buffer without bound,
  and the client re-syncs on a `seq` gap instead of merging onto a base that
  never saw the missing frame.
- Six issue references, and two tests that asserted invariants they could not
  actually catch.

### Known limitations

- **A daemon restart still loses the interval it was down for.** The snapshot
  restores state as of its last write; events that arrived while the daemon was
  gone are not recoverable. Provider transcripts record completed exchanges
  only, so nothing in flight is ever in them.
- **`astir autostart` is macOS only.** On Linux it refuses and says so.
- **A remote session's map cannot be seen locally**
  ([#19](https://github.com/Sertelegger/astir/issues/19)) — a paired daemon
  pushes a roster, not frames.
- **VS Code Remote-SSH auto-forwards astir's ports.** Your workstation's 47000
  can become the *remote* daemon, which shares the token pairing copied and so
  authenticates cleanly. `astir doctor` now names this; the README says how to
  exempt the ports.
- Codex is not a supported provider yet, despite appearing in the spec.

## [0.1.0] — 2026-08-17 (Amaretti)

Shipped as `clide`. The daemon, notifications with an insistent reminder
schedule, the macOS menu bar, cross-machine visibility, and deterministic
subagent parentage. The repo map did not exist yet.

[Unreleased]: https://github.com/Sertelegger/astir/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Sertelegger/astir/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Sertelegger/astir/releases/tag/v0.1.0
