#!/bin/bash
# <bitbar.title>Clide</bitbar.title>
# <bitbar.version>v2.0</bitbar.version>
# <bitbar.author>Sascha Sertel</bitbar.author>
# <bitbar.desc>Shows whether an AI coding agent is blocked waiting on you.</bitbar.desc>
# <bitbar.dependencies>node,clide</bitbar.dependencies>
# <bitbar.abouturl>https://github.com/Sertelegger/clide</bitbar.abouturl>
#
# Install: copy or symlink this into your SwiftBar (or xbar) plugin folder.
# The filename encodes the refresh interval — clide.3s.sh refreshes every 3s.
#
# All formatting lives in `clide menubar` rather than here, so it stays unit
# tested and works unchanged if SwiftBar is ever swapped for something else.

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

if ! command -v clide >/dev/null 2>&1; then
  echo "clide ⚠ | sfimage=exclamationmark.triangle color=#888888"
  echo "---"
  echo "clide not found on PATH | color=#888888"
  echo "Refresh | refresh=true"
  exit 0
fi

exec clide menubar
