# clide-vscode

VSCode extension that renders the Clide activity heat-map in a side panel.

## Build

Compile TypeScript (type-check only, no emit):

```sh
npx tsc -p tsconfig.json --noEmit
```

To emit JavaScript for packaging, use esbuild or set `"noEmit": false` in tsconfig:

```sh
npx esbuild src/extension.ts --bundle --outfile=dist/extension.js \
  --external:vscode --platform=node --format=esm
```

## Bundle P2 clide-web

Copy the `clide-web` (P2) build output into the `media/` directory so the iframe can serve it:

```sh
cp -r ../clide-web/dist/* media/
```

The extension loads `media/index.html` as an iframe inside the webview panel.

## Package

Use `vsce` to produce a `.vsix` file. Requires a `publisher` field in `package.json`:

```sh
npm install -g @vscode/vsce
vsce package
# produces clide-vscode-0.1.0.vsix
```

## Install

```sh
code --install-extension clide-vscode-0.1.0.vsix
```

## HUMAN-BLOCKED Manual Verification

The following steps must be verified by a human in a live VSCode session:

1. Open a workspace folder that has an active Clide relay running (started via Claude Code or Codex).
2. Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run **"Clide: Open Activity Panel"**.
3. Confirm the heat-map panel renders in the sidebar/beside column.
4. Click a file in the heat-map; confirm it opens in the editor.
5. Over Remote-SSH: confirm VSCode auto-forwards the relay port so the iframe can reach it.

If no relay is found for the workspace, the panel shows an empty-state message prompting you to start a session.

## Architecture

| File | Description | Tested by |
|---|---|---|
| `src/resolve.ts` | Finds the most-recent live relay for a workspace folder | vitest |
| `src/webview.ts` | Builds the `?port&token&session` query string for the iframe URL | vitest |
| `src/messages.ts` | Routes `open-file` messages from the webview to the host | vitest |
| `src/extension.ts` | VSCode host glue — registers `clide.openActivityPanel` command | Manual (human) |

`extension.ts` is the **only** file that imports `vscode`. All business logic lives in the other modules, which are unit-tested without a VSCode dependency.
