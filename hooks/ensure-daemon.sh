#!/bin/bash
# DMN-12 — start the daemon when a Claude Code session starts.
#
# The other hooks are `type: "http"` and an http hook cannot fail quietly: its
# schema has no field for ignoring a refused connection, and `async` — which
# does make a failure silent — exists only on command hooks. So every event
# fired while the daemon is down becomes a visible error in the session the user
# is working in, twice per tool call. The fix is to not be down.
#
# This runs on SessionStart only, so its cost is paid once per session rather
# than once per tool call, and it is registered `async` so it never delays a
# session coming up.
#
# It ALWAYS exits 0. A hook that reports a failure while trying to prevent hook
# noise would be self-defeating.
#
# Set CLIDE_NO_AUTOSTART=1 to turn it off and manage the daemon yourself.

set -u

[ "${CLIDE_NO_AUTOSTART:-0}" = "1" ] && exit 0

PORT="${CLIDE_PORT:-47000}"
ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENTRY="$ROOT/dist/cli/main.js"
LOG="$HOME/.clide/daemon.log"

# Already listening? Nothing to do. This is an optimisation, not the guard —
# two sessions starting at once would both pass it. The real guard is that a
# second daemon fails to bind the port and exits, which is why its output goes
# to the log rather than anywhere a user has to look at it.
if command -v curl >/dev/null 2>&1; then
  curl -s -m 1 -o /dev/null "http://127.0.0.1:${PORT}/healthz" && exit 0
fi

[ -f "$ENTRY" ] || exit 0

# Same problem the SwiftBar wrapper has: Claude Code may itself have been
# launched from the desktop or an IDE, whose PATH has never heard of a version
# manager, so `node` is not necessarily findable. Search where they install.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.local/share/mise/shims:$HOME/.volta/bin:$HOME/.asdf/shims:$PATH"
for candidate in \
  "$HOME/.local/share/mise/installs/node/lts/bin" \
  "$HOME/.nvm/current/bin" \
  "$HOME/.nvm/versions/node/"*/bin; do
  [ -d "$candidate" ] && PATH="$PATH:$candidate"
done

NODE="$(command -v node 2>/dev/null)"
[ -n "$NODE" ] || exit 0

mkdir -p "$HOME/.clide" 2>/dev/null || true

# Detached, so the daemon outlives both this hook and the session that started
# it — otherwise every session would kill the daemon on the way out and the next
# one would pay for it.
nohup "$NODE" "$ENTRY" daemon >>"$LOG" 2>&1 &
disown 2>/dev/null || true

exit 0
