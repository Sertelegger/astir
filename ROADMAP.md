# Roadmap

Astir is being rebuilt. An earlier version existed, was thoroughly unit-tested, and had never actually run — the hook entrypoint exported a `main()` that nothing called, so no event ever reached the daemon. That version's design also normalized heat colour against the current maximum, which is invariant under decay, so its map could never cool. Both defects were in the design, not just the code.

The rebuild is driven by a rewritten spec (kept locally) and this order:

## Milestone 1 — the daemon receives real events

- [x] Single package, one daemon on a fixed port
- [x] Execute-the-artifact test written before the implementation
- [x] Event contract with real validation; hostile input cannot kill the daemon
- [x] Claude normalization: tool→op table, realpath-resolved paths, deterministic subagent parentage
- [x] Agent state machine with a `blocked` state and active-vs-blocked time accounting
- [x] OS notification on an agent becoming blocked
- [x] HTTP hook manifest (`type: "http"`) so real sessions feed the daemon
- [x] Session discovery via `claude agents --json`
- [x] `astir status --json`
- [x] Remove the retired v1 packages

## Milestone 2 — you find out without looking

- [x] macOS menu-bar item: working / thinking / **blocked** / idle, badged with the blocked count (via SwiftBar — see #21 for the native replacement)
- [x] Cross-boundary delivery — a session behind SSH, tmux, WSL or a container reaches the workstation
- [x] Per-state notification lifetimes (transient states decay; "needs input" persists)
- [x] Multi-session awareness: which session needs you, not just that one does
- [x] Sessions on machines you only SSH into — polled over your own ssh access
      (`astir watch`), or pushed by a daemon over there
- [x] Sessions nobody is sitting at (plugin- and script-launched) grouped away
      from your own, by controlling terminal
- [x] `astir install` installs the token; a sandboxed project is diagnosed and
      offered the exception rather than left silently unreachable
- [x] The daemon starts itself on `SessionStart`, and `astir autostart` keeps it
      running across reboots — an http hook cannot fail quietly, so a daemon
      that is down is an active nuisance

## Milestone 3 — the view

**In progress.** The push half of the product is done and has been used in
anger. The model landed first — the registry consumes `event.paths` and keeps
per-file heat and totals — and the first view now ships: `astir view` opens a
live repo map served by the daemon itself.

- [x] Per-file heat and totals in the daemon (MOD-01/MOD-08), decaying against
      an **absolute** idle floor — the previous version normalised heat against
      the current maximum, which is invariant under decay, so its map could
      never cool. `astir status` shows the hottest files today.
- [x] MOD-08's bounded progression ring — periodic downsampled samples of
      per-file totals, for the timelapse. Merges older intervals rather than
      dropping them, so a long session coarsens but never truncates.
- [x] Real delta frames that can express removal — a snapshot then deltas, over
      SSE. Frames carry each file's heat *and its age* rather than heat now, so
      the client reproduces the decay curve locally: the map animates at the
      browser's framerate rather than the network's, and files only enter a
      delta when actually touched.
- [x] Map that grows from touched files rather than scanning the repo, with an
      absolute idle floor so it actually cools. Squarified treemap, area is
      √totals so one hot file cannot swallow the map.
- [x] Labels, hover, legend, colour-vision-safe ramp — a map with no text is
      decoration. The ramp's monotonic lightness and its separation under
      simulated protanopia, deuteranopia and tritanopia are asserted in CI, not
      assumed; heat is also encoded as a bar length, so never by colour alone.
- [x] Live ⇄ session toggle over identical geometry (VIEW-10/SC11) — `layout()`
      does not take heat as an argument, so the geometry *cannot* vary with the
      mode.
- [ ] User-arrangeable, hideable panels with the arrangement persisted (VIEW-01)
- [ ] Session switcher (VIEW-08) — today's picker lists sessions but does not
      preserve per-session panel arrangement
- [ ] Cross-session overview, blocked agents first (VIEW-09)
- [ ] Click-to-open a file in the host editor (VIEW-05)

## Milestone 4 — depth

- [x] Cumulative session map, toggleable against the live map
- [ ] Session timelapse (bounded, downsampled — shape over time, not events over time)
- [ ] Codex as a second provider

## Known gaps

- A daemon restart blinds astir to every running session until it next acts
  ([#32](https://github.com/Sertelegger/astir/issues/32)). The *reporting* is
  honest — a session older than the daemon says so rather than claiming its
  hooks are unwired — but the hole is described, not filled, and `astir
  autostart`'s `KeepAlive` makes restarts more frequent. Fixing it means
  choosing between re-deriving state from provider transcripts and persisting
  it, and the latter is in tension with NG2.

## Later, deliberately deferred

- A native macOS menu-bar app to replace the SwiftBar plugin (#21). The current
  surface works and is proven, but requires installing a third-party host app —
  and, more importantly, an unsigned Node process cannot own a macOS permission
  identity: TCC attributes one to the `node` binary, which is both too broad and
  unrecognisable in System Settings. A signed app is the only way to get a single
  grant named "astir". Switching is cheap because all formatting lives in `astir
  menubar` as a pure function, and window focus already runs in the daemon.
- Native Windows support — not rejected, just not first. No design decision may foreclose it.
- A desktop overlay — revisit once real use shows which visualization earns permanent screen space.

## Not planned

- Persistent history, replay, or a forensic timeline
- Steering the AI session in any way — no blocking, approving, or injecting context
- A hosted service
