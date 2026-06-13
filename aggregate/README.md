# clide-aggregate

Read-only multi-session view for clide. Scans all discovery files, subscribes to each live relay's SSE stream (using that relay's bearer token), and unions the sessions into a single terminal view. Tolerates sessions appearing/disappearing (churn). Verifies each stream's `sessionId` and marks a relay that connects but sends no snapshot within 5s as `unreachable`.

**Implements:** REQ-081 (read-only union, per-relay token), REQ-082 (churn tolerance, sessionId verify, snapshot-timeout → unreachable).

## Build

```sh
cd aggregate
npm install
npm run typecheck   # tsc --noEmit
```

## Run

```sh
node dist/main.js
# or, after build:
clide-aggregate
```

## Testing

The `Aggregator` core (per-session entry management, churn, sessionId verification, status transitions) is **fully unit-tested** with injected `scan` + `subscribe` deps:

```sh
npm test           # vitest run — all green
```

## HUMAN-BLOCKED: Live-attach verification

The real SSE subscriber and terminal rendering in `main.ts` are `/* c8 ignore */` glue — verified manually:

1. Start two or more clide sessions (one claude, one codex) so their discovery files appear under `~/.clide/sessions/`.
2. Run `clide-aggregate` (or `node dist/main.js`).
3. Confirm both sessions appear, each showing `live` status, agent count, and file count.
4. Stop one session — confirm it disappears from the view within ~2s (churn tolerance).
5. Disconnect a relay (kill it without ending the session) — confirm status changes to `unreachable` within ~5s (snapshot timeout).
6. Restart the relay — confirm it reappears as `live`.
