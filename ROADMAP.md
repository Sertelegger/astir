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
- [ ] HTTP hook manifest (`type: "http"`, `async: true`) so real sessions feed the daemon
- [ ] Session discovery via `claude agents --json`
- [ ] `clide status --json`
- [ ] Remove the retired v1 packages

## Milestone 2 — you find out without looking

- [x] macOS menu-bar item: working / thinking / **blocked** / idle, badged with the blocked count (via SwiftBar — see #21 for the native replacement)
- [x] Cross-boundary delivery — a session behind SSH, tmux, WSL or a container reaches the workstation
- [x] Per-state notification lifetimes (transient states decay; "needs input" persists)
- [x] Multi-session awareness: which session needs you, not just that one does

## Milestone 3 — the view

- [ ] Web view with user-arrangeable panels (agent rail, changed files, map)
- [ ] Map that grows from touched files rather than scanning the repo, with an absolute idle floor so it actually cools
- [ ] Labels, hover, legend, colour-vision-safe ramp — a map with no text is decoration
- [ ] Real delta frames that can express removal
- [ ] Session switcher and cross-session overview

## Milestone 4 — depth

- [ ] Cumulative session map, toggleable against the live map
- [ ] Session timelapse (bounded, downsampled — shape over time, not events over time)
- [ ] Codex as a second provider

## Later, deliberately deferred

- A native macOS menu-bar app to replace the SwiftBar plugin (#21). The current
  surface works and is proven, but requires installing a third-party host app.
  Switching is cheap because all formatting lives in `clide menubar` as a pure
  function rather than in the plugin script.
- Native Windows support — not rejected, just not first. No design decision may foreclose it.
- A desktop overlay — revisit once real use shows which visualization earns permanent screen space.

## Not planned

- Persistent history, replay, or a forensic timeline
- Steering the AI session in any way — no blocking, approving, or injecting context
- A hosted service
