#!/usr/bin/env node

/** The `clide` entrypoint. Kept thin: everything here is covered by an artifact test. */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, readOrCreateToken, tokenPath } from "../config/paths.js";
import { Daemon } from "../daemon/server.js";
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
      "  status                          print live sessions as JSON\n",
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

  const shutdown = (): void => {
    clearInterval(tick);
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

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "daemon":
      return runDaemon(flags);
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
