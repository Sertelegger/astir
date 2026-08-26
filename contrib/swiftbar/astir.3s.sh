#!/bin/bash
# <bitbar.title>Astir</bitbar.title>
# <bitbar.version>v0.1.0</bitbar.version>
# <bitbar.author>Sascha Sertel</bitbar.author>
# <bitbar.desc>Shows whether an AI coding agent is blocked waiting on you.</bitbar.desc>
# <bitbar.dependencies>node,astir</bitbar.dependencies>
# <bitbar.abouturl>https://github.com/Sertelegger/astir</bitbar.abouturl>
#
# Install: copy or symlink this into your SwiftBar (or xbar) plugin folder.
# The filename encodes the refresh interval — astir.3s.sh refreshes every 3s.
#
# All formatting lives in `astir menubar` rather than here, so it stays unit
# tested and works unchanged if SwiftBar is ever swapped for something else.
#
# Finding astir is the fiddly part, and getting it wrong is invisible: SwiftBar
# runs plugins from launchd, NOT from your shell, so it does not inherit the PATH
# you see in a terminal. A version manager (mise, nvm, volta, asdf) installs
# binaries somewhere that PATH never mentions, and the plugin just quietly reports
# that nothing is running. So: search the usual manager locations, and if the
# command still is not found, fall back to resolving the built entrypoint relative
# to this script — which works because this file is normally symlinked out of the
# repo that contains it.

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.local/share/mise/shims:$HOME/.volta/bin:$HOME/.asdf/shims:$PATH"

# nvm and mise keep their binaries under a versioned directory; add whatever is
# currently selected rather than guessing a version number.
for candidate in \
  "$HOME/.local/share/mise/installs/node/lts/bin" \
  "$HOME/.nvm/current/bin" \
  "$HOME/.nvm/versions/node/"*/bin; do
  [ -d "$candidate" ] && PATH="$PATH:$candidate"
done

ASTIR="$(command -v astir 2>/dev/null)"

if [ -z "$ASTIR" ]; then
  # Resolve this script's real location, following the symlink SwiftBar uses.
  self="${BASH_SOURCE[0]}"
  while [ -L "$self" ]; do
    link="$(readlink "$self")"
    case "$link" in
      /*) self="$link" ;;
      *) self="$(dirname "$self")/$link" ;;
    esac
  done
  repo="$(cd "$(dirname "$self")/../.." && pwd)"
  entry="$repo/dist/cli/main.js"
  if [ -f "$entry" ]; then
    # Run it through node explicitly. Exec'ing the file relies on its
    # `#!/usr/bin/env node` shebang, and node is exactly as likely as astir to be
    # somewhere launchd's PATH has never heard of.
    NODE="$(command -v node 2>/dev/null)"
    if [ -n "$NODE" ]; then
      exec "$NODE" "$entry" menubar
    fi
  fi
fi

if [ -z "$ASTIR" ]; then
  echo "astir ⚠ | sfimage=exclamationmark.triangle color=#888888"
  echo "---"
  echo "astir not found on PATH | color=#888888"
  echo "Run 'npm link' in the astir repo, or install it globally | color=#888888"
  echo "Refresh | refresh=true"
  exit 0
fi

exec "$ASTIR" menubar
