# clide-tui

Terminal renderer for the clide relay SSE stream. Prints a simplified live view: an indented file tree with heat bars + directory roll-up, plus a nested agent rail with "Now" lines.

**Pure-string renderer — zero runtime dependencies. No Ink/React/JSX.**

## Build

```
npm install
npx tsc -p tsconfig.json --outDir dist
```

## Run

```
CLIDE_SESSION_ID=<session-id> node dist/main.js
# or
node dist/main.js <session-id>
```

Reads relay port + token from `~/.clide/sessions/<session-id>.json`.

## Color fallback (REQ-062)

| `COLORTERM=truecolor` | 24-bit RGB heat gradient |
|---|---|
| `TERM=xterm-256color` (default) | 256-color ANSI |
| `NO_COLOR=1` or `TERM=dumb` | Mono plain-glyph (`#` / `·`) |

## HUMAN-BLOCKED: live-attach verification

`runTui()` and `SseReader` are `c8 ignore` glue — verified manually:

1. Start the relay and an active coding session.
2. Note the session ID printed by the relay (or check `~/.clide/sessions/`).
3. Run `CLIDE_SESSION_ID=<id> node dist/main.js`.
4. Confirm the file tree and agent rail update in < 1 second as the session progresses.
5. Confirm color fallback by running with `NO_COLOR=1 node dist/main.js <id>`.

## Tests

```
npx vitest run
```

All units are pure functions — `color.ts`, `sse.ts` (`parseSseChunk`), `store.ts` (`reduce`), `render.ts` (`renderTree`, `renderRail`) — with full TDD coverage.
