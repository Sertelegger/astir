#!/bin/sh
# Find `node`, then hand the payload to codex-relay.mjs.
#
# Codex may run from the desktop or an IDE, whose PATH has never heard of a
# version manager, and a hook whose command is not found fails on EVERY tool
# call. So search where node is usually installed, and when it is nowhere, do
# nothing: astir not seeing a session is better than every tool call in it
# raising an error.
#
# Run as `sh codex-relay.sh`, so it does not depend on the execute bit
# surviving a checkout.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.local/share/mise/shims:$HOME/.volta/bin:$HOME/.asdf/shims:$PATH"
  export PATH
fi
command -v node >/dev/null 2>&1 || exit 0

node "$ROOT/hooks/codex-relay.mjs"
exit 0
