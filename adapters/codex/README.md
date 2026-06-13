# clide-capture-codex

OpenAI Codex capture adapter for the Clide live activity heat-map (REQ-001/007).

## Install

```sh
clide install --provider codex
```

This writes a managed block to `~/.codex/config.toml` (sentinel-delimited, idempotent):

```toml
# >>> clide (managed — do not edit) >>>
[[hooks.SessionStart]]
type = "command"
command = "node /path/to/dist/hook-entry.js"

[[hooks.PreToolUse]]
type = "command"
command = "node /path/to/dist/hook-entry.js"

# ... (PostToolUse, SubagentStart, SubagentStop, Stop)
# <<< clide (managed) <<<
```

## Uninstall

```sh
clide uninstall --provider codex
```

Removes only the managed block; user keys are untouched.

## Human-blocked (manual verification required)

- **OV5:** Live `codex` session firing hooks → relay → web (hook availability version-dependent).
- **OV6:** Exact `apply_patch`/`file_change`/rollout item shapes — adapter uses documented fallbacks.
- **OV7:** `[agents]` subagent maturity — SubagentStart/Stop hooks version-dependent.
- **Real config.toml install** on a Codex machine.
- **Long-lived rollout tailer** (`runTailer`) — c8-ignored, wire up manually.

## Architecture

```
stdin (Codex hook JSON)
  └─ runHook → normalizeCodexHook → ClideEvent
                  └─ classifyCodexTool (apply_patch → edit; shell → other)
                  └─ postEvent → relay (bearer)

rollout JSONL
  └─ runTailer → tailStep → extractCodexReasoning → postReasoning → relay

~/.codex/config.toml
  └─ writeManagedBlock / removeManagedBlock (sentinel-delimited, static command)
```

**No `session_end`:** Codex turn-end is `Stop` (→ `stop` kind). Session end is inferred by relay reap.
