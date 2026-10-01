# astir menu-bar app (macOS)

A native status item for astir, replacing the SwiftBar plugin (#64). It draws
from `astir menubar --json` — a structured model, not SwiftBar's text — so it
never parses anything back out of a string.

**The bar is the product.** It answers "does anything need me" without being
opened: a count when an agent is blocked, a dot while work is happening, a
warning when astir is unreachable. The dropdown says *which* session.

## Requirements

- macOS 13 or later, and the Xcode command-line tools (`xcode-select --install`).
  Full Xcode is not needed.
- `astir` on your PATH via `npm link`, at a version that knows `menubar --json`.

## Build and run

```bash
cd macos
swift build -c release
.build/release/AstirBar &
```

It appears in the menu bar with no Dock icon. **Quit** is at the bottom of its
menu.

## Alongside SwiftBar

Both will show a badge until you disable one. Once this works, remove the
SwiftBar plugin symlink (or uncheck it in SwiftBar's plugin list). Nothing else
changes — the app and the plugin read the same daemon.

## Not yet

- **Launch at login.** That needs an app bundle (`SMAppService`); this is a bare
  executable for now. Until then, add it to System Settings → General → Login
  Items, or start it from a shell profile.
- **Bundling astir.** It uses the `astir` you already have. Shipping a Node
  runtime inside the app is a separate decision: it would make "one app" true,
  at the cost of the size that made Electron unattractive.

## If the bar shows a warning triangle

Open it — the first row says why. The usual causes:

| it says | it means |
|---|---|
| astir is not on PATH | `npm link` in your astir checkout |
| could not read astir's menu | astir predates `--json`: `git pull && npm run build` |
| astir speaks menu vN | the app and the CLI disagree on a major version — update one |
