# Roadmap

Astir is being rebuilt. An earlier version existed, was thoroughly unit-tested, and had never actually run — the hook entrypoint exported a `main()` that nothing called, so no event ever reached the daemon. That version's design also normalized heat colour against the current maximum, which is invariant under decay, so its map could never cool. Both defects were in the design, not just the code.

Those two failures are why this file is short. A roadmap that tracks work drifts from the work; this one records **direction and boundaries**, which nothing else holds.

## Where the work is

**Issues and milestones are the source of truth for what is in flight, what is next, and what is done.** This file does not list tasks and does not carry checkboxes — if you want status, the milestones have it and they cannot go stale.

| | |
|---|---|
| [M1 — daemon receives real events](https://github.com/Sertelegger/astir/milestone/1) | complete |
| [M2 — you find out without looking](https://github.com/Sertelegger/astir/milestone/2) | complete |
| [M3 — the view](https://github.com/Sertelegger/astir/milestone/3) | in progress |
| [M4 — depth](https://github.com/Sertelegger/astir/milestone/4) | next |

The arc is deliberate and the order is not arbitrary. **M1** made the daemon receive real events from a real session, because the previous version's fatal defect was that it never had. **M2** made astir reach you without being looked at — the push half of the product, and the half that justifies it existing. **M3** is the pull half: a view worth opening once you are interested. **M4** is depth over that view: time, and a second provider.

## Design constraints that outlive any milestone

These are enforced in code and asserted in tests, not maintained here. They are listed because knowing they are deliberate is what stops them being "simplified" away.

- **Heat decays against an absolute floor, never against the current maximum.** Uniform decay preserves every ratio, so a max-relative map can never cool. This is the v1 defect, and it is pinned at both the model (`src/model/map.ts`) and the client's deliberate duplicate (`src/status/frames.ts`).
- **Tile area is √total.** Linear area lets one heavily-edited file swallow the map.
- **Geometry never depends on heat or mode.** `layout()` sees paths and totals only, so a toggle — or a file cooling — cannot reflow the map.
- **Frames carry heat *and its age*, never heat-as-of-now**, so the browser reproduces the decay curve locally and animates at its own framerate rather than the network's.
- **Layout is data, not structure.** The map is an entry in a list; no code path asks whether a panel happens to be the map.
- **Astir never looks calmer than it is entitled to.** Sessions it cannot hear are listed and labelled, never filtered out.
- **Colour is checked, not chosen** — monotonic lightness and separation under simulated protanopia, deuteranopia and tritanopia, asserted in CI. Heat is *also* bar length, so never colour alone.

Where an invariant is held only by a comment rather than a test, it is tracked in [#26](https://github.com/Sertelegger/astir/issues/26).

## Known gaps

- **A daemon restart blinds astir to every running session** until it next acts ([#18](https://github.com/Sertelegger/astir/issues/18)). The menu bar reports this honestly — a session older than the daemon says so rather than claiming its hooks are unwired — but the web overview and `astir status` do not yet, and the hole itself is described rather than filled. `astir autostart`'s `KeepAlive` makes restarts more frequent. Fixing it means choosing between re-deriving state from provider transcripts and persisting it, and the latter is in tension with NG2.
- **A remote session's map cannot be seen locally** ([#19](https://github.com/Sertelegger/astir/issues/19)). A paired daemon pushes a roster over the tunnel but not frames, so you can see that a remote session exists without seeing where its work is happening.

## Later, deliberately deferred

- **A native macOS menu-bar app** to replace the SwiftBar plugin ([#17](https://github.com/Sertelegger/astir/issues/17)). The current surface works and is proven, but requires installing a third-party host app — and, more importantly, an unsigned Node process cannot own a macOS permission identity: TCC attributes one to the `node` binary, which is both too broad and unrecognisable in System Settings. A signed app is the only way to get a single grant named "astir". Switching is cheap because all formatting lives in `astir menubar` as a pure function, and window focus already runs in the daemon.
- **Native Windows support** — not rejected, just not first. No design decision may foreclose it.
- **A desktop overlay** — revisit once real use shows which visualization earns permanent screen space.

## Not planned

- Persistent history, replay, or a forensic timeline
- Steering the AI session in any way — no blocking, approving, or injecting context
- A hosted service
