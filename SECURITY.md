# Security Policy

## Supported versions

Only the latest release receives security fixes.

| Version | Supported |
| ------- | --------- |
| latest 0.x / 2.x-alpha | ✅ |
| older | ❌ |

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, use GitHub's private vulnerability reporting: go to the [Security tab](https://github.com/Sertelegger/astir/security) → **Report a vulnerability**.

This is a personal open-source project, so response times are best-effort — expect an acknowledgment within a week.

## Scope

Astir observes an AI coding session and reports on it. That means it ingests input it does not control, holds a credential, and can send a message off the machine. Reports are especially welcome in these areas:

- **Hook payload ingest** (`src/daemon/server.ts`, `src/adapters/*`) — hook bodies are untrusted input. Filenames and paths in them can be influenced by anything that lands in the repository (a dependency, a pull request, a cloned tree). Anything that turns a crafted payload into code execution, unbounded memory growth, or daemon death is a security bug.
- **Path handling** (`src/adapters/*/normalize.ts`) — repo-relative paths are resolved through `realpath` and must never escape the session's working directory. A path that escapes, or that is silently accepted when it should be rejected, is in scope.
- **Daemon authentication** (`src/daemon/server.ts`) — every data route requires a bearer token; `/healthz` is deliberately open and must never expose session content. The daemon binds loopback and validates the `Host` header specifically to blunt DNS-rebinding reads from a browser. Bypasses of any of these are in scope.
- **Notification payloads** — a notification may cross a machine boundary (SSH, WSL, a container, a push service). It is deliberately a *doorbell*: which session, which host, why. Anything that leaks file contents, file paths, tool arguments, or model reasoning into a notification is a security bug, not a feature request.
- **Cross-host delivery** — the notifier is network-addressable. Unauthenticated delivery, replayable messages, or a path that lets an unrelated local process inject notifications are in scope.
- **Provider security controls** — Astir must never disable or auto-approve a provider's own safety gate in order to install itself. In particular it must not silently write Codex's hook-trust hash. A change that does so is a security bug.

## Out of scope

- The AI provider's own behaviour (what Claude Code or Codex chooses to run). Astir observes; it never approves, blocks, or steers.
- Content already written by the provider outside Astir's control, such as transcript files on disk.
