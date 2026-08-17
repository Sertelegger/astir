#!/usr/bin/env node

/** The `clide` entrypoint. Kept thin: everything here is covered by an artifact test. */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, readOrCreateToken, readTokenIfPresent, tokenPath } from "../config/paths.js";
import { Daemon } from "../daemon/server.js";
import { createClaudeLister } from "../discovery/sessions.js";
import { Registry } from "../model/registry.js";
import { Dispatcher, localTarget, remoteTarget } from "../notify/dispatch.js";
import { buildEnvelope } from "../notify/envelope.js";
import { NotifyLoop } from "../notify/loop.js";
import { backendFromNotifier, createNotifier, createNotifierBackend } from "../notify/notify.js";
import { NotifyPolicy } from "../notify/policy.js";
import { NotifierServer } from "../notify/server.js";
import { fetchRemote, fetchStatus } from "../status/fetch.js";
import { focusSession } from "../status/focus.js";
import { renderMenubar } from "../status/menubar.js";

interface Args {
  command: string;
  flags: Map<string, string | boolean>;
  /** Non-flag arguments, in order — e.g. the session id for `focus`/`dismiss`. */
  positional: string[];
}

export function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === undefined) continue;
    if (!tok.startsWith("--")) {
      positional.push(tok);
      continue;
    }
    const name = tok.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }
  return { command, flags, positional };
}

function usage(): void {
  process.stdout.write(
    "clide <command>\n\n" +
      "  daemon [--port N] [--token T]   run the activity daemon\n" +
      "  install [--no-plugin]           register the hooks and print what is left to do\n" +
      "  status [--json]                 show live sessions and who is waiting on you\n" +
      "  menubar                         SwiftBar/xbar plugin output\n" +
      "  notifier [--port N]             receive doorbells from another host and notify here\n" +
      "  doctor [--notify]               check the setup; --notify sends a test notification\n" +
      "  dismiss [sessionId]             stop reminders for what is waiting (all, or one session)\n" +
      "  forget <sessionId>              drop a session record entirely\n" +
      "  focus <sessionId>               raise the window/pane that session is running in\n" +
      "\n" +
      "  daemon also accepts --notify-url <url> --notify-token <t> to deliver to a\n" +
      "  remote notifier as well as locally (e.g. over `ssh -R`).\n",
  );
}

/** Repo root, from either dist/cli/main.js or src/cli/main.ts. */
function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Register the plugin — and therefore the hooks — without the user hand-editing
 * anything or typing slash commands.
 *
 * Deliberately invoked from an explicit `clide install`, never from an npm
 * `postinstall`. Reaching into another tool's configuration as a side effect of
 * `npm install` is the behaviour the ecosystem treats as hostile, and it would
 * fire under `npm ci` in CI, inside Docker builds, and for transitive installs
 * where nobody asked for any of this.
 */
function registerPlugin(root: string, out: (line: string) => void): boolean {
  const run = (args: string[]): { ok: boolean; detail: string } => {
    try {
      const stdout = execFileSync("claude", args, {
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, detail: stdout.trim() };
    } catch (err) {
      const e = err as { stderr?: Buffer | string; message?: string };
      const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString();
      return { ok: false, detail: (stderr || e.message || "failed").trim() };
    }
  };

  const market = run(["plugin", "marketplace", "add", root]);
  // Adding a marketplace that is already known is a success for our purposes.
  if (!market.ok && !/already/i.test(market.detail)) {
    out(`  could not add the marketplace: ${market.detail}`);
    return false;
  }

  const install = run(["plugin", "install", "clide@clide-marketplace", "--yes"]);
  if (!install.ok && !/already/i.test(install.detail)) {
    out(`  could not install the plugin: ${install.detail}`);
    return false;
  }
  return true;
}

function runInstall(flags: Args["flags"]): void {
  const token = readOrCreateToken();
  const root = repoRoot();
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  if (flags.get("no-plugin") !== true) {
    out("Registering the clide plugin with Claude Code…");
    if (registerPlugin(root, out)) {
      out("  hooks registered — restart Claude Code to pick them up");
    } else {
      out("  falling back to manual setup; see step 2 below");
    }
    out("");
  }

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
      "2. The plugin registers the hooks. `clide install` does this for you; if it",
      "   could not, or you passed --no-plugin, do it by hand in Claude Code:",
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
      "How you will be told an agent is waiting:",
      "",
      "  Desktop notification   always on. This is the floor and needs no setup.",
      "                         A blocked agent is re-reminded every minute for ten",
      "                         minutes, then every two, then every five, then",
      "                         quarter-hourly — so a missed alert is never lost.",
      "                         `clide dismiss` stops the reminders without pretending",
      "                         the agent is unblocked.",
      "",
      "  Menu bar (macOS)       optional, and the only always-visible surface.",
      "                         Requires SwiftBar:",
      "                           brew install --cask swiftbar",
      `                           ln -s ${join(root, "contrib/swiftbar/clide.3s.sh")} <plugin-folder>/`,
      "                         Without it you still get notifications — you just have",
      "                         to catch them when they fire.",
      "",
      "  Another machine        if the agent runs behind SSH, in WSL, or in a container,",
      "                         run `clide notifier` HERE, and on that machine start",
      "                         the daemon with --notify-url pointing back through an",
      "                         `ssh -R 47001:127.0.0.1:47001` tunnel. Remote sessions",
      '                         then appear in this menu bar under "Other machines",',
      "                         and clear themselves when answered.",
      "",
      "`clide doctor --notify` reports which of these are actually live and fires a",
      "test through them. It has to ask whether you saw it: the OS reports success",
      "even when it suppressed the notification.",
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

  // PSH-06 — delivery paths. Local is the floor; a remote notifier is added when
  // configured, so a session behind SSH or in a container can reach the human.
  const backend = createNotifierBackend();
  // The absolute path is what a notification click will invoke; a bare `clide`
  // would not resolve in the environment the notification daemon runs in.
  const targets = [localTarget(backend, process.argv[1])];
  if (!backend.capabilities.click) {
    process.stdout.write(
      `notifications via ${backend.name}: not clickable, and cannot be replaced or dismissed.\n` +
        "  install terminal-notifier for click-to-focus and self-clearing alerts:\n" +
        "    brew install terminal-notifier\n",
    );
  }
  const notifyUrl = flags.get("notify-url");
  if (typeof notifyUrl === "string") {
    const remoteToken = String(flags.get("notify-token") ?? process.env.CLIDE_NOTIFY_TOKEN ?? token);
    targets.push(remoteTarget(notifyUrl, remoteToken));
  }
  const dispatcher = new Dispatcher(targets);
  const policy = new NotifyPolicy();
  const loop = new NotifyLoop({
    registry,
    policy,
    dispatcher,
    onDelivered: (line) => process.stdout.write(`notify: ${line}\n`),
  });

  // Notification decisions live entirely in the loop rather than being split
  // between here and an ingest callback: one decision point means a reminder and
  // an initial alert cannot disagree, or fire twice for the same moment.
  const daemon = new Daemon({ token, registry });

  const bound = await daemon.listen(port);
  // The artifact test parses this line; keep the format stable.
  process.stdout.write(`clide daemon listening on 127.0.0.1:${bound}\n`);
  process.stdout.write(`delivery paths: ${dispatcher.names().join(", ")}\n`);

  const tick = setInterval(() => {
    registry.tick();
    void loop.pulse();
  }, 1000);
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

/**
 * #5 — a machine-readable view, and the data source the menu-bar item consumes.
 * Kept as a plain command deliberately: if the tray approach changes, the same
 * output still feeds a shell prompt, a statusline, or a different implementation.
 */
async function runStatus(flags: Args["flags"]): Promise<void> {
  const port = Number(flags.get("port") ?? process.env.CLIDE_PORT ?? DEFAULT_PORT);
  const result = await fetchStatus(port);

  if (!result.ok) {
    process.stderr.write(`clide: ${result.reason}\n`);
    process.exitCode = 1;
    return;
  }
  const body = result.body;

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

/** PSH-03 — SwiftBar/xbar plugin output. Formatting lives in the pure renderer. */
async function runMenubar(flags: Args["flags"]): Promise<void> {
  const port = Number(flags.get("port") ?? process.env.CLIDE_PORT ?? DEFAULT_PORT);
  // SwiftBar's `bash=` runs with a minimal PATH, so menu actions must invoke an
  // absolute path or clicking them would silently do nothing.
  const exe = process.argv[1] ?? "clide";
  // PSH-12 — one surface for every machine. Fetched together so a slow notifier
  // cannot delay the local view.
  const [status, remote] = await Promise.all([
    fetchStatus(port),
    fetchRemote(Number(flags.get("notify-port") ?? process.env.CLIDE_NOTIFY_PORT ?? port + 1)),
  ]);
  process.stdout.write(renderMenubar(status, { exe, remote }));
}

/**
 * PSH-06 — run where the human is. A daemon on another host POSTs doorbells
 * here. Binds loopback, so `ssh -R 47001:127.0.0.1:47001 devbox` is enough to
 * reach it with no broker and no third-party service.
 */
async function runNotifier(flags: Args["flags"]): Promise<void> {
  const port = Number(flags.get("port") ?? process.env.CLIDE_NOTIFY_PORT ?? DEFAULT_PORT + 1);
  const token = String(flags.get("token") ?? process.env.CLIDE_NOTIFY_TOKEN ?? readOrCreateToken());

  const server = new NotifierServer({
    token,
    notify: createNotifier(),
    onEvent: (line) => process.stdout.write(`delivered: ${line}\n`),
  });

  const bound = await server.listen(port);
  process.stdout.write(`clide notifier listening on 127.0.0.1:${bound}\n`);
  process.stdout.write("on the remote host, run the daemon with:\n");
  process.stdout.write(
    `  clide daemon --notify-url http://127.0.0.1:${bound}/notify --notify-token <token>\n`,
  );
  process.stdout.write(`forward it with:  ssh -R ${bound}:127.0.0.1:${bound} <host>\n`);

  const shutdown = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

/**
 * PSH-05/PSH-07 — say which delivery path is actually live.
 *
 * The platform reports success even when a notification is suppressed, so the
 * only honest test is to fire one and ask whether it was seen.
 */
async function runDoctor(flags: Args["flags"]): Promise<void> {
  const port = Number(flags.get("port") ?? process.env.CLIDE_PORT ?? DEFAULT_PORT);
  const out = (l: string): void => {
    process.stdout.write(`${l}\n`);
  };

  out("clide doctor");
  out("");

  const token = process.env.CLIDE_TOKEN ?? readTokenIfPresent();
  out(`  token file      ${token === null ? "MISSING — run `clide install`" : `ok (${tokenPath()})`}`);
  out(
    `  $CLIDE_TOKEN    ${process.env.CLIDE_TOKEN ? "set" : "not set — hooks will be rejected; see `clide install`"}`,
  );

  const status = await fetchStatus(port);
  if (status.ok) {
    const agents = status.body.sessions.reduce((n, s) => n + s.agents.length, 0);
    out(`  daemon          ok — ${status.body.sessions.length} session(s), ${agents} agent(s)`);
    out(`  blocked now     ${status.body.blockedCount}`);
  } else {
    out(`  daemon          ${status.reason}`);
  }

  if (flags.get("notify") === true) {
    out("");
    out("  sending a test notification...");
    const dispatcher = new Dispatcher([localTarget(backendFromNotifier(createNotifier()))]);
    const envelope = buildEnvelope({
      kind: "blocked",
      reason: "doctor_test",
      sessionId: "doctor-test",
      agentId: "doctor-test",
      cwd: process.cwd(),
    });
    for (const o of await dispatcher.send(envelope)) {
      out(`    ${o.target.padEnd(10)} ${o.ok ? "sent" : `FAILED — ${o.reason ?? "unknown"}`}`);
    }
    out("");
    // A7: `osascript` exits 0 whether or not the notification was displayed, so
    // the exit code proves nothing. Only a human can close this loop.
    out("  Did you see it? If not, the OS suppressed it — check notification");
    out("  permissions and Focus/Do-Not-Disturb. The send reports success either way.");
  } else {
    out("");
    out("  run with --notify to send a test notification");
  }
}

/** POST to a daemon control route, returning the parsed body or null. */
async function control(
  port: number,
  path: string,
  sessionId?: string,
): Promise<Record<string, unknown> | null> {
  const token = readTokenIfPresent();
  if (token === null) return null;
  const query = sessionId === undefined ? "" : `?session=${encodeURIComponent(sessionId)}`;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}${query}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * PSH-10 — acknowledge what is waiting. The agent stays blocked; the badge and
 * the reminders stop. Without this the only way to silence a notification is to
 * deal with it, which is wrong for the case where you have seen it and are
 * deliberately deferring.
 */
async function runDismiss(args: Args): Promise<void> {
  const port = Number(args.flags.get("port") ?? process.env.CLIDE_PORT ?? DEFAULT_PORT);
  const notifyPort = Number(args.flags.get("notify-port") ?? process.env.CLIDE_NOTIFY_PORT ?? port + 1);
  const sessionId = args.positional[0];

  // Dismiss on both surfaces: a session may be local, or reported by the
  // notifier from another machine, and the human clicking "dismiss" does not
  // know or care which.
  const [local, remote] = await Promise.all([
    control(port, "/dismiss", sessionId),
    control(notifyPort, "/dismiss", sessionId),
  ]);

  if (local === null && remote === null) {
    process.stderr.write(`clide: could not reach a daemon on 127.0.0.1:${port}\n`);
    process.exitCode = 1;
    return;
  }
  const n = Number(local?.acknowledged ?? 0) + Number(remote?.acknowledged ?? 0);
  process.stdout.write(
    n === 0 ? "nothing was waiting\n" : `dismissed ${n} waiting agent${n === 1 ? "" : "s"}\n`,
  );
}

/** Drop a session record outright — the escape hatch for one that should not exist. */
async function runForget(args: Args): Promise<void> {
  const port = Number(args.flags.get("port") ?? process.env.CLIDE_PORT ?? DEFAULT_PORT);
  const sessionId = args.positional[0];
  if (sessionId === undefined) {
    process.stderr.write("clide forget <sessionId>\n");
    process.exitCode = 1;
    return;
  }
  const result = await control(port, "/forget", sessionId);
  if (result === null) {
    process.stderr.write(`clide: no such session, or the daemon is not running\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`forgot ${sessionId}\n`);
}

/** PSH-11 — raise the window the session is running in. */
async function runFocus(args: Args): Promise<void> {
  const port = Number(args.flags.get("port") ?? process.env.CLIDE_PORT ?? DEFAULT_PORT);
  const sessionId = args.positional[0];
  if (sessionId === undefined) {
    process.stderr.write("clide focus <sessionId>\n");
    process.exitCode = 1;
    return;
  }

  const status = await fetchStatus(port);
  if (!status.ok) {
    process.stderr.write(`clide: ${status.reason}\n`);
    process.exitCode = 1;
    return;
  }
  const session = status.body.sessions.find((s) => s.sessionId === sessionId);
  if (session === undefined) {
    process.stderr.write(`clide: no live session ${sessionId}\n`);
    process.exitCode = 1;
    return;
  }

  const result = focusSession(session);
  process.stdout.write(`${result.detail}\n`);
  if (!result.ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { command, flags } = args;
  switch (command) {
    case "daemon":
      return runDaemon(flags);
    case "status":
      return runStatus(flags);
    case "menubar":
      return runMenubar(flags);
    case "notifier":
      return runNotifier(flags);
    case "doctor":
      return runDoctor(flags);
    case "install":
      runInstall(flags);
      return;
    case "dismiss":
      return runDismiss(args);
    case "forget":
      return runForget(args);
    case "focus":
      return runFocus(args);
    default:
      usage();
      return;
  }
}

void main().catch((err: unknown) => {
  process.stderr.write(`clide: failed to start: ${String(err)}\n`);
  process.exit(1);
});
