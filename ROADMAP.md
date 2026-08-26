# Roadmap

Clide is being rebuilt. An earlier version existed, was thoroughly unit-tested, and had never actually run — the hook entrypoint exported a `main()` that nothing called, so no event ever reached the daemon. That version's design also normalized heat colour against the current maximum, which is invariant under decay, so its map could never cool. Both defects were in the design, not just the code.

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
- [x] `clide status --json`
- [x] Remove the retired v1 packages

## Milestone 2 — you find out without looking

- [x] macOS menu-bar item: working / thinking / **blocked** / idle, badged with the blocked count (via SwiftBar — see #21 for the native replacement)
- [x] Cross-boundary delivery — a session behind SSH, tmux, WSL or a container reaches the workstation
- [x] Per-state notification lifetimes (transient states decay; "needs input" persists)
- [x] Multi-session awareness: which session needs you, not just that one does
- [x] Sessions on machines you only SSH into — polled over your own ssh access
      (`clide watch`), or pushed by a daemon over there
- [x] Sessions nobody is sitting at (plugin- and script-launched) grouped away
      from your own, by controlling terminal
- [x] `clide install` installs the token; a sandboxed project is diagnosed and
      offered the exception rather than left silently unreachable
- [x] The daemon starts itself on `SessionStart`, and `clide autostart` keeps it
      running across reboots — an http hook cannot fail quietly, so a daemon
      that is down is an active nuisance

## Milestone 3 — the view

**Next.** The push half of the product is done and has been used in anger; the
pull half does not exist yet. Note that the map's *model* comes first: the
registry does not consume `event.paths` today, so nothing accumulates per-file
totals and `/state` exposes no file data. This is not a view over existing data.

- [ ] Per-file totals in the daemon (MOD-08), decaying against an **absolute**
      idle floor — the previous version normalised heat against the current
      maximum, which is invariant under decay, so its map could never cool
- [ ] Web view with user-arrangeable panels (agent rail, changed files, map)
- [ ] Map that grows from touched files rather than scanning the repo, with an absolute idle floor so it actually cools
- [ ] Labels, hover, legend, colour-vision-safe ramp — a map with no text is decoration
- [ ] Real delta frames that can express removal
- [ ] Session switcher and cross-session overview

## Milestone 4 — depth

- [ ] Cumulative session map, toggleable against the live map
- [ ] Session timelapse (bounded, downsampled — shape over time, not events over time)
- [ ] Codex as a second provider

## Known gaps

- A daemon restart blinds clide to every running session until it next acts
  ([#32](https://github.com/Sertelegger/clide/issues/32)). The *reporting* is
  honest — a session older than the daemon says so rather than claiming its
  hooks are unwired — but the hole is described, not filled, and `clide
  autostart`'s `KeepAlive` makes restarts more frequent. Fixing it means
  choosing between re-deriving state from provider transcripts and persisting
  it, and the latter is in tension with NG2.

## Later, deliberately deferred

- A native macOS menu-bar app to replace the SwiftBar plugin (#21). The current
  surface works and is proven, but requires installing a third-party host app —
  and, more importantly, an unsigned Node process cannot own a macOS permission
  identity: TCC attributes one to the `node` binary, which is both too broad and
  unrecognisable in System Settings. A signed app is the only way to get a single
  grant named "clide". Switching is cheap because all formatting lives in `clide
  menubar` as a pure function, and window focus already runs in the daemon.
- Native Windows support — not rejected, just not first. No design decision may foreclose it.
- A desktop overlay — revisit once real use shows which visualization earns permanent screen space.

## Not planned

- Persistent history, replay, or a forensic timeline
- Steering the AI session in any way — no blocking, approving, or injecting context
- A hosted service
