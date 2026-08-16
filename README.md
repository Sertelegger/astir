# Clide — live activity heat-map for Claude Code & Codex

Clide shows, in real time, **where** an AI coding session is working in your repo and **what** its agents are doing right now: a spatial repo **heat-map** (sunburst overview ⇄ treemap detail, with zoom + a `T` shape toggle), an **agent rail** with subagent relationships and an intelligently-summarized **"Now"** line per agent, and **auto-surfaced** spec/plan Markdown files. It works for **Claude Code** and **OpenAI Codex CLI**, and renders in a **browser**, a **VSCode webview**, or the **terminal**. It is *live-only* — no history, no database.

> **Status:** all components are implemented and unit-tested (8 packages, ~180 tests, strict TypeScript). Live end-to-end activation (a real `claude`/`codex` session, the VSCode extension inside VSCode) is the manual verification step described below.

---

## How it works

```
Claude Code ─hooks─▶ clide-capture-claude ┐
Codex CLI   ─hooks─▶ clide-capture-codex  ├─POST + token──▶ clide-relay ─SSE─▶ renderers
 (+ subagents)        (normalize → §11 contract,│            (per session;        ├─ web  (browser / VSCode webview)
        │              tag provider)            │            in-memory heat/      ├─ vscode-ext (hosts web)
        └─writes─▶ transcript ◀── tail ── capture adapter    agent/reasoning;     ├─ tui  (terminal)
                   (reasoning only)                          token-auth HTTP+SSE) └─ aggregate (all sessions)
```

A per-provider **capture adapter** normalizes the agent's hooks + transcript into one shared event contract (`§11` in the spec). A per-session **relay** holds the live state in memory and streams it over token-authenticated SSE. Renderers are provider-agnostic — the relay and renderers contain **no** provider-specific code.

## Packages

| Path | What |
|---|---|
| `relay/` | The per-session relay: event/SSE contract, heat/agent/reasoning models, token-auth HTTP+SSE, lifecycle, summarizer |
| `web/` | Browser renderer: sunburst⇄treemap heat-map + agent rail (used standalone and by the VSCode webview) |
| `adapters/claude/` | Claude Code capture adapter (hooks + transcript reasoning) |
| `adapters/codex/` | OpenAI Codex capture adapter (hooks + rollout reasoning + `~/.codex/config.toml` install) |
| `vscode-ext/` | VSCode extension that hosts the web renderer in a panel |
| `tui/` | Zero-dependency terminal renderer |
| `aggregate/` | `clide aggregate` — read-only overview of all live sessions |
| `cli/` | The unified `clide` CLI (`tui`/`aggregate`/`install`/`watch`/`doctor`) |

---

## Prerequisites

- **Node.js ≥ 20**
- **Claude Code** and/or **OpenAI Codex CLI** installed and logged in (a Claude.ai / ChatGPT subscription login is fine — see *Summaries* below; no API key required)

## Build

Each package builds to its own `dist/` (the plugin ships prebuilt artifacts — Claude Code does not build on install).

```bash
# from the repo root — installs deps per package the first time, then builds all
for p in relay web adapters/claude adapters/codex vscode-ext tui aggregate cli; do (cd "$p" && npm install); done
npm run build            # root script: builds every package (tsc → dist/, vite for web)
```

Run the test suites any time:

```bash
for p in relay web adapters/claude adapters/codex vscode-ext tui aggregate cli; do (cd "$p" && npm test); done
```

---

## Install as a Claude Code plugin

Clide is a Claude Code plugin (manifest at `.claude-plugin/plugin.json`, hooks at `hooks/hooks.json`). After building:

```text
# in Claude Code:
/plugin marketplace add /Users/sascha/Projects/clide      # this repo is its own marketplace
/plugin install clide@clide-marketplace
```

On `SessionStart`, Clide's hook starts the relay + reasoning tailer for that session (detached); every tool/subagent/stop event is normalized and POSTed to the relay. Hooks exit in <300 ms and never block your session. Run `/reload-plugins` after rebuilding.

> Because Claude Code installs plugins as-is (no build step), the `dist/` artifacts must exist. For a **local** install (the marketplace `source` is `"./"`), just run `npm run build` first. For **git** distribution, either commit the `dist/` directories or add a CI step that builds and commits them.

## Install for Codex

Codex registers hooks via a managed block in `~/.codex/config.toml` (it preserves your existing config; the hook command is static):

```bash
node adapters/codex/dist/install-main.js              # add Clide's Codex hooks
node adapters/codex/dist/install-main.js --uninstall  # remove them
```

---

## See the activity

Each session writes a discovery file at `~/.clide/sessions/<session_id>.json` containing the relay `port` and `token`.

- **Terminal (simplest):**
  ```bash
  CLIDE_SESSION_ID=<session_id> node tui/dist/main.js
  ```
- **All sessions at once:**
  ```bash
  node aggregate/dist/main.js
  ```
- **VSCode:** build/package `vscode-ext/` (e.g. `npx vsce package`), install the VSIX, open your project, and run **“Clide: Open Activity Panel.”** Over Remote-SSH, VSCode auto-forwards the relay port.
- **Browser — one URL, no static server needed.** The relay serves the built `web/dist` itself. Take `port` and `token` from the session's discovery file and open:
  ```
  http://127.0.0.1:<relay-port>/?token=<relay-token>&session=<session_id>
  ```
  The page is served from the relay, so the port is implicit — you only pass the token and session. (The token can't travel in a page-load header, so the app files are served unauthenticated; they contain no session data. Every **data** endpoint — `/events`, `/reasoning`, `/state`, `/stream` — still requires the bearer token, which the app reads from the URL. That's also why it streams via `fetch` rather than `EventSource`, which can't set headers.)

### Try it without a real session

You can run the relay directly and drive it with the synthetic event driver used in the tests:

```bash
npm run build
CLIDE_SESSION_ID=demo CLIDE_PROVIDER=claude CLIDE_CWD="$PWD" node relay/dist/relay/main.js &
# then read the port + token and open the heat-map straight from the relay:
cat ~/.clide/sessions/demo.json
# → http://127.0.0.1:<port>/?token=<token>&session=demo
```

---

## Summaries — uses your existing subscription login (no API key)

The per-agent **“Now”** line is, by default, condensed from the model's own reasoning (offline, zero cost). When that isn't expressive enough, Clide can ask a fast model to phrase it — and it does so by shelling out to the **already-installed, already-logged-in CLI**, so it reuses your **Claude.ai / ChatGPT subscription** with **no separate API key**:

- Claude: `claude -p "…" --model haiku --bare --output-format text`
- Codex: `codex exec --sandbox read-only --ask-for-approval never …`

Only the minimal metadata (event kind, tool name, op, file *basenames*) is ever sent — never file contents or reasoning text. It's debounced per agent with a circuit breaker.

| Env var | Default | Meaning |
|---|---|---|
| `CLIDE_SUMMARIZER` | `auto` | `auto` enables the model upgrade; `off` = reasoning/template only, zero egress |
| `CLIDE_SUMMARIZER_TRANSPORT` | `cli` | `cli` reuses the subscription login; `api` uses an API key (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`) |
| `CLIDE_SESSION_ID`, `CLIDE_PROVIDER`, `CLIDE_CWD` | — | set by the capture hook when launching the relay |
| `CLIDE_RELAY_ENTRY` | — | override the path to the built relay entry (advanced) |

> Note: from 2026-06-15, subscription `claude -p` usage draws from a separate monthly “Agent SDK” credit; Codex `exec` draws from your ChatGPT plan quota.

## Maintenance

```bash
clide doctor --clean      # remove stale discovery files + logs for relays that are no longer live
```

---

## Design docs & development

- Frozen spec: `docs/superpowers/specs/2026-08-16-clide-agent-activity-design.md`
- Per-phase implementation plans: `docs/superpowers/plans/`
- Each package: `npm test` (vitest) and `npm run build`. Strict TypeScript throughout.

### Continuous integration

`.github/workflows/build-dist.yml` runs every package's tests + typecheck on push to `main`, builds all packages, verifies each entrypoint exists and parses, then commits the refreshed `dist/` artifacts back. That keeps a git-based `/plugin install` working, since Claude Code never builds on install.

### Known limitations / manual-verification items
- **Live end-to-end** (real `claude`/`codex` session → relay → renderer), the **VSCode extension** running inside VSCode, and **Remote-SSH** forwarding are verified manually — the spawn/tailer/extension glue is integration code with unit-tested cores.
- **Codex specifics (verify on your version):** hook availability, the exact `apply_patch`/rollout item shapes, and `[agents]` subagent maturity vary by Codex build; the adapter uses documented fallbacks.
- Spec **delete** detection needs Claude Code's `FileChanged` hook (created/updated are live today).
- Several **plan documents** contain reference code that the review process later corrected — **the committed package code is the source of truth**, not the plan docs.
