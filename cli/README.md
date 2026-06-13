# clide CLI

The unified `clide` command-line entry point.

```
clide tui                         # live terminal view of the current session (→ clide-tui)
clide aggregate                   # read-only overview of all live sessions (→ clide-aggregate)
clide install --provider codex    # register capture hooks (Codex → ~/.codex/config.toml)
clide watch                       # no-hooks tailer/bootstrap (Codex fallback)
clide doctor --clean              # remove stale discovery files + logs (REQ-094)
```

Build: `tsc` → `dist/main.js` (the `clide` bin).

## What's tested vs. glue
- **Unit-tested:** argv parsing (`dispatch.ts`) and stale-discovery detection (`doctor.ts` `findStale`/`cleanStale`).
- **`c8`-ignored host glue (verified manually):** `main.ts` — subcommand routing (spawns the `clide-tui` / `clide-aggregate` bins), the live `/healthz` liveness probe used by `doctor --clean`, and log removal. These require live relays / installed subcommand bins to verify.

`doctor --clean` probes each `~/.clide/sessions/*.json` relay via `GET /healthz` (matching `sessionId`, per REQ-018); discovery files whose relay is not live, plus their `~/.clide/logs/<session>.log`, are removed.
