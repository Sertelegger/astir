#!/usr/bin/env node

/** The `clide` entrypoint. Kept thin: everything here is covered by an artifact test. */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, readOrCreateToken, readTokenIfPresent, tokenPath } from "../config/paths.js";
import { Daemon } from "../daemon/server.js";
import { createClaudeLister } from "../discovery/sessions.js";
import { Registry } from "../model/registry.js";
import { createNotifier } from "../notify/notify.js";

interface Args {
  command: string;
  flags: Map<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === undefined || !tok.startsWith("--")) continue;
    const name = tok.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }
  return { command, flags };
}

function usage(): void {
  process.stdout.write(
    "clide <command>\n\n" +
      "  daemon [--port N] [--token T]   run the activity daemon\n" +
      "  install                         print setup instructions and ensure the token exists\n" +
      "  status [--json]                 show live sessions and who is waiting on you\n",
  );
}

/** Repo root, from either dist/cli/main.js or src/cli/main.ts. */
function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function runInstall(): void {
  const token = readOrCreateToken();
  const root = repoRoot();

  process.stdout.write(
    [
      "clide setup",
      "",
      "1. Export the daemon token where Claude Code can see it.",
      "   Hooks read it via $CLIDE_TOKEN. If it is unset the header interpolates to an",
      "   empty string and every event is rejected — the daemon will say so rather than",
      "   failing silently, but it is easier to just set it.",
      "",
      `   Add to your shell profile:   export CLIDE_TOKEN=${token}`,
      `   (stored at ${tokenPath()}, mode 0600)`,
      "",
      "2. Install the plugin so the hooks are registered.",
      "",
      "   In Claude Code:",
      `     /plugin marketplace add ${root}`,
      "     /plugin install clide@clide-marketplace",
      "",
      "3. Start the daemon, then restart Claude Code so it picks up the hooks.",
      "",
      "     clide daemon",
      "",
      "Verify with `curl -s localhost:47000/healthz` — once a session is running,",
      "`ingested` should climb. If `unauthorizedIngest` climbs instead, step 1 is missing.",
      "",
    ].join("\n"),
  );
}

async function runDaemon(flags: Args["flags"]): Promise<void> {
  const port = Number(flags.get("port") ?? process.env.CLIDE_PORT ?? DEFAULT_PORT);
  const explicit = flags.get("token") ?? process.env.CLIDE_TOKEN;
  // A stable on-disk token means a hook configuration written once keeps working
  // across daemon restarts.
  const token = explicit !== undefined ? String(explicit) : readOrCreateToken();

  const registry = new Registry({ nowMs: () => Date.now() });
  const notify = createNotifier();

  const daemon = new Daemon({
    token,
    registry,
    onBlocked: ({ sessionId, kind }) => {
      // PSH-09: routing and identity only — never code, paths, or reasoning.
      notify({
        title: "clide — needs your input",
        body: `session ${sessionId.slice(0, 8)} · ${kind}`,
      });
    },
  });

  const bound = await daemon.listen(port);
  // The artifact test parses this line; keep the format stable.
  process.stdout.write(`clide daemon listening on 127.0.0.1:${bound}\n`);

  const tick = setInterval(() => registry.tick(), 1000);
  tick.unref();

  // DMN-05 — fold provider discovery in periodically. Enrichment and pruning only;
  // never a gate on ingest.
  const lister = createClaudeLister();
  const reconcile = (): void => {
    void lister()
      .then((list) => registry.reconcile(list))
      .catch(() => undefined);
  };
  reconcile();
  const discoveryTick = setInterval(reconcile, 5_000);
  discoveryTick.unref();

  const shutdown = (): void => {
    clearInterval(tick);
    clearInterval(discoveryTick);
    void daemon.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // DMN-04 — nothing inbound may kill the process.
  process.on("unhandledRejection", (err) => {
    process.stderr.write(`clide: unhandled rejection: ${String(err)}\n`);
  });
  process.on("uncaughtException", (err) => {
    process.stderr.write(`clide: uncaught exception: ${String(err)}\n`);
  });
}

interface StatusAgent {
  id: string;
  state: string;
  agentType: string | null;
  activeMs: number;
  blockedMs: number;
}
interface StatusSession {
  sessionId: string;
  cwd: string;
  name: string | null;
  status: string | null;
  agents: StatusAgent[];
}
interface StatusBody {
  blockedCount: number;
  sessions: StatusSession[];
}

/**
 * #5 — a machine-readable view, and the data source the menu-bar item consumes.
 * Kept as a plain command deliberately: if the tray approach changes, the same
 * output still feeds a shell prompt, a statusline, or a different implementation.
 */
async function runStatus(flags: Args["flags"]): Promise<void> {
  const port = Number(flags.get("port") ?? process.env.CLIDE_PORT ?? DEFAULT_PORT);
  const token = process.env.CLIDE_TOKEN ?? readTokenIfPresent();
  if (token === null) {
    process.stderr.write("clide: no token found — run `clide install` first.\n");
    process.exitCode = 1;
    return;
  }

  let body: StatusBody;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/state`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      process.stderr.write(`clide: daemon returned ${res.status} — is the token current?\n`);
      process.exitCode = 1;
      return;
    }
    body = (await res.json()) as StatusBody;
  } catch {
    process.stderr.write(`clide: no daemon on 127.0.0.1:${port} — start it with \`clide daemon\`.\n`);
    process.exitCode = 1;
    return;
  }

  if (flags.get("json") === true) {
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return;
  }

  if (body.sessions.length === 0) {
    process.stdout.write("no live sessions\n");
    return;
  }
  const secs = (ms: number): string => `${Math.round(ms / 1000)}s`;
  for (const s of body.sessions) {
    const label = s.name ?? s.sessionId.slice(0, 8);
    process.stdout.write(`${label}  ${s.cwd}${s.status ? `  [${s.status}]` : ""}\n`);
    for (const a of s.agents) {
      const who = a.agentType ?? "main";
      process.stdout.write(
        `    ${a.state.padEnd(12)} ${who.padEnd(18)} active ${secs(a.activeMs)} · blocked ${secs(a.blockedMs)}\n`,
      );
    }
  }
  if (body.blockedCount > 0) {
    process.stdout.write(`\n${body.blockedCount} agent(s) waiting on you\n`);
  }
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "daemon":
      return runDaemon(flags);
    case "status":
      return runStatus(flags);
    case "install":
      runInstall();
      return;
    default:
      usage();
      return;
  }
}

void main().catch((err: unknown) => {
  process.stderr.write(`clide: failed to start: ${String(err)}\n`);
  process.exit(1);
});
