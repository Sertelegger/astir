# The capture hooks

`hooks.json` is read by Claude Code against a schema that rejects unknown keys,
so this prose lives here rather than in a `_comment` field. It sits beside the
file it explains for the same reason it was in the file: a rationale a directory
away from its subject is one nobody reads at the moment they need it.

## `type: "http"`, not `command`

There is no process to spawn, so no Node startup cost per tool call.

**`async` is deliberately absent, and cannot be present** — it is a
command-hook-only field. An http hook is synchronous, which is safe here because
the receiver is a local in-memory server: an absent daemon refuses the
connection immediately, and a hung one is bounded by the explicit timeout in the
file. The platform default is 600s, which is not a budget.

## The token

It comes from `$ASTIR_TOKEN`. If that variable is unset the header interpolates
to an **empty string** rather than failing, so every event is rejected while
everything still appears wired. The daemon therefore counts unauthorized ingest
separately from silence — `unauthorizedIngest` climbing and `ingested: 0` are
different diagnoses. `astir install` writes the variable; `astir doctor` names
the case directly.

## Why `SessionStart` starts the daemon

It also runs `ensure-daemon.sh`, which launches the daemon if nothing is
listening. **This is the answer to hook noise.** An http hook cannot fail
quietly — there is no field for it, and `async` is command-hook-only — so a
daemon that is down turns every tool call into two visible errors in whatever
session you are working in. The only way to be quiet is to be running.

Starting it here costs one process per *session* rather than per tool call, and
that hook is a command hook with `async: true`, so it never delays a session
coming up. `ASTIR_NO_AUTOSTART=1` disables it.
