# clide-capture-claude

Claude Code adapter for the Clide live activity heat-map. Implements the REQ-007 `CaptureAdapter`/REQ-007a `Tailer` seam: normalizes Claude hook payloads into `ClideEvent` records, extracts reasoning from the Claude transcript, and POSTs events/reasoning to the relay (bearer-authed).

## Build

```sh
cd adapters/claude
npm install
npx tsc -p tsconfig.json   # emits to dist/
```

## Plugin layout

```
adapters/claude/
  hooks/hooks.json          # Claude Code plugin hook manifest (REQ-001)
  dist/hook-entry.js        # built CLI entry — invoked by Claude Code per hook event
  dist/tailer.js            # built tailer entry — long-lived, spawned on SessionStart
  src/                      # TypeScript sources
  test/                     # Vitest unit + integration tests
```

## How it works

1. Claude Code fires a hook event → executes `node dist/hook-entry.js` with JSON on stdin.
2. `hook-entry` reads stdin, normalizes the payload to a `ClideEvent`, resolves the relay discovery file (`~/.clide/sessions/<sessionId>.json`), and POSTs to `http://127.0.0.1:<port>/events` with bearer auth.
3. On `SessionStart`, `hook-entry` also spawns the relay and tailer (see `ensureRelay` stub in `src/hook-entry.ts`).
4. The tailer polls the Claude transcript file, extracts assistant reasoning via `tailStep`, and POSTs to `/reasoning`.
5. The hook entry always exits 0 within ≤300 ms and never blocks the session (REQ-004).

## HUMAN-BLOCKED: manual end-to-end verification

The following steps require a human to perform — they cannot be automated here because they require a live `claude` session with real hooks firing.

1. **Build:** `npx tsc -p tsconfig.json` in `adapters/claude/`.
2. **Install plugin:** Register this package as a Claude Code plugin so `hooks/hooks.json` is loaded. Place or symlink the plugin directory where Claude Code discovers plugins.
3. **Start relay:** Run the relay process (P1) with `CLIDE_SESSION_ID` set:
   ```sh
   node relay/dist/main.js --port 51000 --session <sessionId> --token <token>
   ```
   The relay writes `~/.clide/sessions/<sessionId>.json` with `{ v:1, sessionId, port, token, state:"live" }`.
4. **Run a real claude session:** Open a terminal and run `claude`. Perform some tool use (edits, reads, etc.).
5. **Confirm hooks fire:** Check relay logs — each tool use should produce a POST to `/events`.
6. **Open the web UI:** Start `clide-web` (P2) and navigate to `http://localhost:<webPort>/?port=51000&token=<token>&session=<sessionId>`. Confirm live heat-map events render.
7. **Tailer reasoning:** Confirm the tailer is polling the transcript and POSTing assistant reasoning to `/reasoning`, visible in the web UI.

The hook entry exits 0 within budget on every hook event and never blocks the session regardless of relay state (no relay running → events are silently dropped).
