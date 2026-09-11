# Changelog

All notable changes to astir are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) with **one stated
addition**: a `Known limitations` section, for behaviour that is easy to mistake
for a bug.

Direction and boundaries live in [ROADMAP.md](./ROADMAP.md); what is being built
is in the [milestones](https://github.com/Sertelegger/astir/milestones). How a
release is cut, named and published is in
[CONTRIBUTING.md](./CONTRIBUTING.md#releases).

## [Unreleased]

## [0.2.0] — 2026-09-11 (Amaretti)

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

## [0.1.0] — 2026-08-17

Shipped as `clide`. The daemon, notifications with an insistent reminder
schedule, the macOS menu bar, cross-machine visibility, and deterministic
subagent parentage. The repo map did not exist yet.

[Unreleased]: https://github.com/Sertelegger/astir/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Sertelegger/astir/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Sertelegger/astir/releases/tag/v0.1.0
