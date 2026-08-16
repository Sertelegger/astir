#!/usr/bin/env node
/** The `clide` entrypoint. Kept thin: everything here is covered by an artifact test. */

import { randomBytes } from "node:crypto";
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
    "clide <command>\n" +
      "  daemon [--port N] [--token T]   run the activity daemon\n" +
      "  status                          print live sessions as JSON\n",
  );
}

async function runDaemon(flags: Args["flags"]): Promise<void> {
  const port = Number(flags.get("port") ?? process.env.CLIDE_PORT ?? 47000);
  const token = String(flags.get("token") ?? process.env.CLIDE_TOKEN ?? randomBytes(16).toString("hex"));

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
  if (!flags.has("token") && !process.env.CLIDE_TOKEN) {
    process.stdout.write(`token: ${token}\n`);
  }

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
    default:
      usage();
      return;
  }
}

void main().catch((err: unknown) => {
  process.stderr.write(`clide: failed to start: ${String(err)}\n`);
  process.exit(1);
});
