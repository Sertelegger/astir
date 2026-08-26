#!/usr/bin/env node

/** The `astir` entrypoint. Kept thin: everything here is covered by an artifact test. */

import { execFileSync } from "node:child_process";
import { readFileSync, readSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addWatchedHost, hostsPath, readWatchedHosts, removeWatchedHost } from "../config/hosts.js";
import { astirDir, DEFAULT_PORT, readOrCreateToken, readTokenIfPresent, tokenPath } from "../config/paths.js";
import { allowLoopback, inspectSandbox, LOOPBACK } from "../config/sandbox.js";
import { installService, serviceInstalled, servicePath, uninstallService } from "../config/service.js";
import { Daemon } from "../daemon/server.js";
import { createSshLister, RemoteDiscovery } from "../discovery/remote.js";
import { createClaudeLister } from "../discovery/sessions.js";
import { Registry } from "../model/registry.js";
import { detectNotifier } from "../notify/detect.js";
import { Dispatcher, localTarget, remoteTarget } from "../notify/dispatch.js";
import { buildEnvelope } from "../notify/envelope.js";
import { NotifyLoop } from "../notify/loop.js";
import { backendFromNotifier, createNotifier, createNotifierBackend } from "../notify/notify.js";
import { NotifyPolicy } from "../notify/policy.js";
import { pushRoster, rosterUrlFrom } from "../notify/roster.js";
import { NotifierServer } from "../notify/server.js";
import { fetchRemote, fetchStatus } from "../status/fetch.js";
import { renderMenubar } from "../status/menubar.js";
import { defaultPairDeps, pair, pairedHosts, sshConfigPath } from "./pair.js";
import {
  claudeSettingsPath,
  defaultSettingsDeps,
  installToken,
  parseSettings,
  tokenIsFilteredOut,
  tokenState,
} from "./settings.js";

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
    "astir <command>\n\n" +
      "  daemon [--port N] [--token T]   run the activity daemon\n" +
      "  install [--no-plugin]           register the hooks, install the token, report the rest\n" +
      "  status [--json]                 show live sessions and who is waiting on you\n" +
      "  menubar                         SwiftBar/xbar plugin output\n" +
      "  notifier [--port N]             receive doorbells from another host and notify here\n" +
      "  doctor [--notify]               check the setup; --notify sends a test notification\n" +
      "  dismiss [sessionId]             stop reminders for what is waiting (all, or one session)\n" +
      "  forget <sessionId>              drop a session record entirely\n" +
      "  focus <sessionId>               raise the window/pane that session is running in\n" +
      "  pair <host> [--yes]             let a remote machine notify this one\n" +
      "  allow-sandbox <path>            let a sandboxed project reach the daemon\n" +
      "  watch <host> [--remove]         see sessions on a machine you ssh into\n" +
      "  autostart [--remove]            keep the daemon running across reboots\n" +
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
 * Deliberately invoked from an explicit `astir install`, never from an npm
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

  const install = run(["plugin", "install", "astir@astir-marketplace", "--yes"]);
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
    out("Registering the astir plugin with Claude Code…");
    if (registerPlugin(root, out)) {
      out("  hooks registered — restart Claude Code to pick them up");
    } else {
      out("  falling back to manual setup; see step 2 below");
    }
    out("");
  }

  // INS-04 — the token has to be in Claude Code's environment or every hook
  // 401s. Doing it here rather than printing a line is the whole point: the
  // printed version was skippable in silence, and did nothing at all for
  // Claude Code started from the desktop app or an IDE.
  out("Installing the daemon token where the hooks can read it…");
  const installed = installToken(token);
  out(`  ${installed.detail}`);
  out("");

  // DMN-08 — offer, never apply. A sandbox is a boundary someone chose, and
  // widening it as a side effect of installing a status tool is precisely what
  // SEC-02 forbids. So this states the situation and the one command that fixes
  // it, and leaves the decision where it belongs.
  const sandbox = inspectSandbox(process.cwd());
  if (sandbox.blocked) {
    out("This project is sandboxed, so its hooks cannot reach the daemon:");
    out("  the egress proxy refuses them before they arrive, which looks");
    out("  identical to no hooks at all. Allow it — only if you want to — with:");
    out("");
    out(`    astir allow-sandbox ${process.cwd()}`);
    out("");
  }

  process.stdout.write(
    [
      "astir setup",
      "",
      ...(installed.ok
        ? [
            "1. The daemon token is installed. Hooks read it via $ASTIR_TOKEN, which",
            `   Claude Code now sets from "env" in ${installed.path}.`,
            `   (source of truth is ${tokenPath()}, mode 0600)`,
            "",
            "   Claude Code watches that file, so a session already running usually starts",
            "   sending within a tool call or two. If `unauthorizedIngest` in",
            "   `curl -s localhost:47000/healthz` keeps climbing, restart it.",
          ]
        : [
            "1. Put the daemon token where Claude Code can see it — THIS IS NOT DONE YET.",
            "   Hooks read it via $ASTIR_TOKEN. Unset, the header interpolates to an empty",
            "   string and every event is rejected; the daemon counts those separately",
            "   rather than failing silently, but nothing will work until this is fixed.",
            "",
            `   Add to ${claudeSettingsPath()}:`,
            '     "env": {',
            `       "ASTIR_TOKEN": "${token}"`,
            "     }",
            "",
            "   A shell profile works too, but only for Claude Code started from a",
            "   terminal — the desktop app and IDE extensions never source one:",
            `     export ASTIR_TOKEN=${token}`,
          ]),
      "",
      "2. The plugin registers the hooks. `astir install` does this for you; if it",
      "   could not, or you passed --no-plugin, do it by hand in Claude Code:",
      `     /plugin marketplace add ${root}`,
      "     /plugin install astir@astir-marketplace",
      "",
      "3. Start the daemon, then restart Claude Code so it picks up the hooks.",
      "",
      "     astir daemon",
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
      "                         `astir dismiss` stops the reminders without pretending",
      "                         the agent is unblocked.",
      "",
      "  Menu bar (macOS)       optional, and the only always-visible surface.",
      "                         Requires SwiftBar:",
      "                           brew install --cask swiftbar",
      `                           ln -s ${join(root, "contrib/swiftbar/astir.3s.sh")} <plugin-folder>/`,
      "                         Without it you still get notifications — you just have",
      "                         to catch them when they fire.",
      "",
      "  Another machine        if the agent runs behind SSH, in WSL, or in a container,",
      "                         run `astir notifier` HERE, and on that machine start",
      "                         the daemon with --notify-url pointing back through an",
      "                         `ssh -R 47001:127.0.0.1:47001` tunnel. Remote sessions",
      '                         then appear in this menu bar under "Other machines",',
      "                         and clear themselves when answered.",
      "",
      "`astir doctor --notify` reports which of these are actually live and fires a",
      "test through them. It has to ask whether you saw it: the OS reports success",
      "even when it suppressed the notification.",
      "",
    ].join("\n"),
  );
}

async function runDaemon(flags: Args["flags"]): Promise<void> {
  const port = Number(flags.get("port") ?? process.env.ASTIR_PORT ?? DEFAULT_PORT);
  const explicit = flags.get("token") ?? process.env.ASTIR_TOKEN;
  // A stable on-disk token means a hook configuration written once keeps working
  // across daemon restarts.
  const token = explicit !== undefined ? String(explicit) : readOrCreateToken();

  const registry = new Registry({ nowMs: () => Date.now() });

  // PSH-06 — delivery paths. Local is the floor; a remote notifier is added when
  // configured, so a session behind SSH or in a container can reach the human.
  const backend = createNotifierBackend();
  // The absolute path is what a notification click will invoke; a bare `astir`
  // would not resolve in the environment the notification daemon runs in.
  // The interpreter AND the script: a notification click runs under `/bin/sh`
  // with a minimal PATH, where the shebang alone cannot find node.
  const invocation = [process.execPath, process.argv[1] ?? ""];
  const targets = [localTarget(backend, invocation)];
  if (!backend.capabilities.click) {
    process.stdout.write(
      `notifications via ${backend.name}: not clickable, and cannot be replaced or dismissed.\n` +
        "  install terminal-notifier for click-to-focus and self-clearing alerts:\n" +
        "    brew install terminal-notifier\n",
    );
  }
  const notifyPort = Number(flags.get("notify-port") ?? process.env.ASTIR_NOTIFY_PORT ?? port + 1);
  const remoteToken = String(flags.get("notify-token") ?? process.env.ASTIR_NOTIFY_TOKEN ?? token);
  const notifyUrl = flags.get("notify-url");
  // Whichever notifier we currently believe in — set explicitly or found by the
  // probe below, and cleared when the tunnel drops. The roster follows it.
  let notifierUrl: string | null = typeof notifyUrl === "string" ? notifyUrl : null;
  const rosterTarget = (): string | null => (notifierUrl === null ? null : rosterUrlFrom(notifierUrl));
  if (typeof notifyUrl === "string") {
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
  // DMN-09 — sessions on paired hosts. The getter hands over whatever the last
  // poll produced, so /state never waits on a network round trip.
  const remoteDiscovery = new RemoteDiscovery({
    hosts: () => {
      // Pairing is a stronger opt-in and implies watching; the hosts file
      // covers the machines where astir is not installed at all.
      let paired: string[] = [];
      try {
        paired = pairedHosts(readFileSync(sshConfigPath(), "utf8"), notifyPort);
      } catch {
        // No ssh config is the normal single-machine case, not an error.
      }
      const watched = readWatchedHosts();
      return [...new Set([...watched, ...paired])];
    },
    list: createSshLister(),
  });

  const daemon = new Daemon({
    token,
    registry,
    remoteSessions: () => remoteDiscovery.list(),
  });

  const bound = await daemon.listen(port);
  // The artifact test parses this line; keep the format stable.
  process.stdout.write(`astir daemon listening on 127.0.0.1:${bound}\n`);
  process.stdout.write(`delivery paths: ${dispatcher.names().join(", ")}\n`);

  const tick = setInterval(() => {
    registry.tick();
    void loop.pulse();
  }, 1000);
  tick.unref();

  // PSH-14 — find the notifier rather than being told where it is. Re-checked on
  // a slow timer because an `ssh -R` tunnel comes and goes with the connection,
  // so a one-shot probe at startup would be wrong for most of the daemon's life.
  if (typeof notifyUrl !== "string") {
    let attached = false;
    const probe = async (): Promise<void> => {
      const found = await detectNotifier(notifyPort);
      if (found.found && !attached) {
        attached = true;
        notifierUrl = found.url;
        dispatcher.add(remoteTarget(found.url, remoteToken));
        process.stdout.write(`notifier detected on 127.0.0.1:${notifyPort} — delivering there too\n`);
      } else if (!found.found && attached) {
        attached = false;
        notifierUrl = null;
        dispatcher.remove(`remote(${found.url})`);
        process.stdout.write(`notifier on 127.0.0.1:${notifyPort} went away (${found.reason ?? "gone"})\n`);
      }
    };
    void probe();
    const probeTimer = setInterval(() => void probe(), 15_000);
    probeTimer.unref();
  }

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

  // DMN-09 — slower than local discovery on purpose: each tick is an SSH round
  // trip per paired host, and a machine's session list does not change fast
  // enough to justify paying that every five seconds.
  const pollRemote = (): void => void remoteDiscovery.poll().catch(() => undefined);
  pollRemote();
  const remoteTick = setInterval(pollRemote, 30_000);
  remoteTick.unref();

  // DMN-10 — announce what THIS machine is running to whichever notifier we can
  // reach, so the far end sees ordinary sessions and not only doorbells.
  const rosterTick = setInterval(() => {
    const url = rosterTarget();
    if (url === null) return;
    const sessions = [
      ...registry.list().map((r) => ({
        sessionId: r.sessionId,
        cwd: r.cwd,
        name: r.name,
        status: r.status,
        ...(r.attended === undefined ? {} : { attended: r.attended }),
      })),
      // Sessions we cannot hear are still running here, and the far end has no
      // other way to learn they exist.
      ...registry.silent().map((d) => ({
        sessionId: d.sessionId,
        cwd: d.cwd,
        name: d.name,
        status: d.status,
        ...(d.attended === undefined ? {} : { attended: d.attended }),
      })),
    ];
    void pushRoster(url, remoteToken, { host: hostname(), sessions });
  }, 10_000);
  rosterTick.unref();

  // MOD-08 — seal a progression interval periodically. Slower than the state
  // tick on purpose: this is the shape of a session over hours, and sampling it
  // every second would spend the ring's whole budget on the first minute.
  const progressionTick = setInterval(() => {
    for (const s of registry.list()) s.map.sample();
  }, 30_000);
  progressionTick.unref();

  const shutdown = (): void => {
    clearInterval(tick);
    clearInterval(discoveryTick);
    clearInterval(progressionTick);
    clearInterval(remoteTick);
    clearInterval(rosterTick);
    void daemon.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // DMN-04 — nothing inbound may kill the process.
  process.on("unhandledRejection", (err) => {
    process.stderr.write(`astir: unhandled rejection: ${String(err)}\n`);
  });
  process.on("uncaughtException", (err) => {
    process.stderr.write(`astir: uncaught exception: ${String(err)}\n`);
  });
}

/**
 * #5 — a machine-readable view, and the data source the menu-bar item consumes.
 * Kept as a plain command deliberately: if the tray approach changes, the same
 * output still feeds a shell prompt, a statusline, or a different implementation.
 */
async function runStatus(flags: Args["flags"]): Promise<void> {
  const port = Number(flags.get("port") ?? process.env.ASTIR_PORT ?? DEFAULT_PORT);
  const result = await fetchStatus(port);

  if (!result.ok) {
    process.stderr.write(`astir: ${result.reason}\n`);
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

    // VIEW-07 — the map's accessibility fallback, and the only view of it that
    // exists until the web view does. A ranked list says "where is work
    // happening" without needing colour, or a browser.
    const files = s.files;
    if (files !== undefined && files.hottest.length > 0) {
      const live = files.hottest.filter((f) => !f.idle).slice(0, 5);
      const shown = live.length > 0 ? live : files.hottest.slice(0, 3);
      const heading = live.length > 0 ? "hottest" : "recent (all cold)";
      // Say how many are NOT shown rather than trimming in silence (VIEW-06).
      const rest = files.touched - shown.length;
      const more = rest > 0 ? `  (+${rest} more of ${files.touched} touched)` : "";
      process.stdout.write(`    ${heading}:${more}\n`);
      for (const f of shown) {
        const bar = "█".repeat(Math.max(1, Math.round(f.intensity * 10))).padEnd(10, "░");
        process.stdout.write(`      ${bar} ${f.path}  ×${f.total}\n`);
      }
    }
  }
  if (body.blockedCount > 0) {
    process.stdout.write(`\n${body.blockedCount} agent(s) waiting on you\n`);
  }
}

/** PSH-03 — SwiftBar/xbar plugin output. Formatting lives in the pure renderer. */
async function runMenubar(flags: Args["flags"]): Promise<void> {
  const port = Number(flags.get("port") ?? process.env.ASTIR_PORT ?? DEFAULT_PORT);
  // The interpreter AND the script. SwiftBar's `bash=` runs from launchd with a
  // minimal PATH, so handing it main.js alone leaves the click depending on
  // `#!/usr/bin/env node` finding node there — which it does not when node came
  // from a version manager. The exec fails 127 and the menu item looks inert.
  const invocation = [process.execPath, process.argv[1] ?? ""];
  // PSH-12 — one surface for every machine. Fetched together so a slow notifier
  // cannot delay the local view.
  const [status, remote] = await Promise.all([
    fetchStatus(port),
    fetchRemote(Number(flags.get("notify-port") ?? process.env.ASTIR_NOTIFY_PORT ?? port + 1)),
  ]);
  // DMN-08 — the daemon cannot detect this: the whole symptom is that nothing
  // arrives from these sessions. Their own project settings can, so the surface
  // that has the cwd does the reading.
  if (status.ok && status.body.silent !== undefined) {
    for (const s of status.body.silent) {
      s.sandboxBlocked = inspectSandbox(s.cwd).blocked;
    }
  }
  process.stdout.write(renderMenubar(status, { invocation, remote }));
}

/**
 * PSH-06 — run where the human is. A daemon on another host POSTs doorbells
 * here. Binds loopback, so `ssh -R 47001:127.0.0.1:47001 devbox` is enough to
 * reach it with no broker and no third-party service.
 */
async function runNotifier(flags: Args["flags"]): Promise<void> {
  const port = Number(flags.get("port") ?? process.env.ASTIR_NOTIFY_PORT ?? DEFAULT_PORT + 1);
  const token = String(flags.get("token") ?? process.env.ASTIR_NOTIFY_TOKEN ?? readOrCreateToken());

  const server = new NotifierServer({
    token,
    notify: createNotifier(),
    onEvent: (line) => process.stdout.write(`delivered: ${line}\n`),
  });

  const bound = await server.listen(port);
  process.stdout.write(`astir notifier listening on 127.0.0.1:${bound}\n`);
  process.stdout.write("on the remote host, run the daemon with:\n");
  process.stdout.write(
    `  astir daemon --notify-url http://127.0.0.1:${bound}/notify --notify-token <token>\n`,
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
  const port = Number(flags.get("port") ?? process.env.ASTIR_PORT ?? DEFAULT_PORT);
  const out = (l: string): void => {
    process.stdout.write(`${l}\n`);
  };

  out("astir doctor");
  out("");

  const fileToken = readTokenIfPresent();
  out(`  token file      ${fileToken === null ? "MISSING — run `astir install`" : `ok (${tokenPath()})`}`);

  // INS-04 — where the hooks actually read the token from. Doctor's own
  // environment is not the signal: it runs in a terminal that may well export
  // ASTIR_TOKEN while the Claude Code being diagnosed was launched from the
  // desktop app and never saw it. settings.json is what both of them share.
  const settings = defaultSettingsDeps();
  const settingsPath = settings.path();
  const parsed = parseSettings(settings.read(settingsPath));
  if (!parsed.ok) {
    out(`  settings.json   UNREADABLE — ${parsed.reason}`);
  } else if (fileToken === null) {
    out("  settings.json   skipped — no token file to compare against");
  } else {
    const state = tokenState(parsed.settings, fileToken);
    const described =
      state.kind === "current"
        ? `ASTIR_TOKEN set (${settingsPath})`
        : state.kind === "stale"
          ? "ASTIR_TOKEN is STALE — does not match the token file; run `astir install`"
          : "ASTIR_TOKEN NOT SET — hooks will be rejected; run `astir install`";
    out(`  settings.json   ${described}`);
    if (tokenIsFilteredOut(parsed.settings)) {
      out('  ⚠ httpHookAllowedEnvVars is set and omits "ASTIR_TOKEN" — the header will');
      out("    be filtered to empty no matter how the variable is installed.");
    }
  }

  // DMN-12 — whether it will still be here after a reboot. A daemon that must be
  // started by hand is one hook-error storm away from being uninstalled.
  out(
    `  autostart       ${
      serviceInstalled()
        ? `on (${servicePath()})`
        : "off — hooks error while the daemon is down; `astir autostart` fixes that"
    }`,
  );

  const status = await fetchStatus(port);
  if (status.ok) {
    const agents = status.body.sessions.reduce((n, s) => n + s.agents.length, 0);
    out(`  daemon          ok — ${status.body.sessions.length} session(s), ${agents} agent(s)`);
    out(`  blocked now     ${status.body.blockedCount}`);

    // DMN-08 — name the silent sessions astir can actually explain.
    const blocked = (status.body.silent ?? []).filter((s) => inspectSandbox(s.cwd).blocked);
    for (const s of blocked) {
      out(`  ⚠ sandboxed     ${s.cwd}`);
      out(`                  its hooks are refused before they reach the daemon; allow with`);
      out(`                  astir allow-sandbox ${s.cwd}`);
    }
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
  const port = Number(args.flags.get("port") ?? process.env.ASTIR_PORT ?? DEFAULT_PORT);
  const notifyPort = Number(args.flags.get("notify-port") ?? process.env.ASTIR_NOTIFY_PORT ?? port + 1);
  const sessionId = args.positional[0];

  // Dismiss on both surfaces: a session may be local, or reported by the
  // notifier from another machine, and the human clicking "dismiss" does not
  // know or care which.
  const [local, remote] = await Promise.all([
    control(port, "/dismiss", sessionId),
    control(notifyPort, "/dismiss", sessionId),
  ]);

  if (local === null && remote === null) {
    process.stderr.write(`astir: could not reach a daemon on 127.0.0.1:${port}\n`);
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
  const port = Number(args.flags.get("port") ?? process.env.ASTIR_PORT ?? DEFAULT_PORT);
  const sessionId = args.positional[0];
  if (sessionId === undefined) {
    process.stderr.write("astir forget <sessionId>\n");
    process.exitCode = 1;
    return;
  }
  const result = await control(port, "/forget", sessionId);
  if (result === null) {
    process.stderr.write(`astir: no such session, or the daemon is not running\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`forgot ${sessionId}\n`);
}

/** PSH-11 — raise the window the session is running in. */
/**
 * DMN-08 — let a sandboxed project reach the daemon.
 *
 * Separate, explicit, and never run by `install`: a sandbox is a security
 * boundary someone chose, and widening it as a side effect of setting up a
 * status tool would be exactly the behaviour SEC-02 forbids. Reached either by
 * typing this or by clicking the menu item that says what it will do.
 */
function runAllowSandbox(args: Args): void {
  // `parseArgs` gives a flag the next non-flag token as its value, so
  // `--dry-run <path>` puts the path on the flag and leaves no positional.
  // Accepting it from either place beats making the argument order load-bearing.
  const flagged = args.flags.get("dry-run");
  const target = args.positional[0] ?? (typeof flagged === "string" ? flagged : undefined);
  const dryRun = flagged !== undefined;
  if (target === undefined) {
    process.stderr.write("astir allow-sandbox <path-to-project>\n");
    process.exitCode = 1;
    return;
  }

  const state = inspectSandbox(target);
  if (!state.enabled) {
    process.stdout.write(
      `${target} is not sandboxed — nothing to allow.\n` +
        "If its sessions are still silent, they were probably started before the\n" +
        "astir plugin; hooks bind at session start, so restart them.\n",
    );
    return;
  }

  if (dryRun) {
    process.stdout.write(`Would add ${LOOPBACK} to sandbox.network.allowedDomains in\n  ${state.path}\n`);
    return;
  }

  const result = allowLoopback(target);
  process.stdout.write(`${result.detail}\n`);
  if (!result.ok) {
    process.exitCode = 1;
    return;
  }
  if (result.changed) {
    process.stdout.write(
      "Restart that session for it to take effect.\n" +
        `Undo by removing ${LOOPBACK} from sandbox.network.allowedDomains in that file.\n`,
    );
  }
}

/**
 * DMN-09 — watch a machine you only ever ssh into.
 *
 * Deliberately lighter than `astir pair`: that copies a token and edits
 * ~/.ssh/config so a remote daemon can call back, and refuses if astir is not
 * installed over there. Watching needs none of it — astir asks the far side
 * `claude agents --json` over the ssh access you already have.
 */
function runWatch(args: Args): void {
  const host = args.positional[0];
  if (host === undefined) {
    process.stderr.write("astir watch <host> [--remove]\n");
    process.exitCode = 1;
    return;
  }

  if (args.flags.get("remove") === true) {
    const r = removeWatchedHost(host);
    process.stdout.write(`no longer watching ${host} (${r.path})\n`);
    return;
  }

  const r = addWatchedHost(host);
  process.stdout.write(r.added ? `watching ${host} (${r.path})\n` : `already watching ${host} (${r.path})\n`);
  const watched = readWatchedHosts();
  process.stdout.write(`  ${watched.length} host(s): ${watched.join(", ")}\n`);
  process.stdout.write(
    "  astir asks each one `claude agents --json` over ssh every 30s.\n" +
      `  Remove with \`astir watch ${host} --remove\`, or edit ${hostsPath()}.\n`,
  );
}

/**
 * DMN-12 — keep the daemon running.
 *
 * Not a convenience. An http hook cannot fail quietly — its schema has no field
 * for it, and `async` is command-hook-only — so every event fired while the
 * daemon is down surfaces as an error in whatever session the user is working
 * in, twice per tool call. The only way to be quiet is to be running.
 */
function runAutostart(args: Args): void {
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  if (args.flags.get("remove") === true) {
    const removed = uninstallService();
    out(removed.detail);
    if (!removed.ok) process.exitCode = 1;
    return;
  }

  const result = installService({
    node: process.execPath,
    script: process.argv[1] ?? "",
    logPath: join(astirDir(), "daemon.log"),
  });
  out(result.detail);
  if (!result.ok) {
    process.exitCode = 1;
    return;
  }
  out("");
  out("The daemon now starts at login and restarts if it dies.");
  out(`  logs:    ${join(astirDir(), "daemon.log")}`);
  out(`  remove:  astir autostart --remove`);
}

async function runFocus(args: Args): Promise<void> {
  const port = Number(args.flags.get("port") ?? process.env.ASTIR_PORT ?? DEFAULT_PORT);
  const sessionId = args.positional[0];
  if (sessionId === undefined) {
    process.stderr.write("astir focus <sessionId>\n");
    process.exitCode = 1;
    return;
  }

  // Delegated to the daemon rather than done here on purpose — see the /focus
  // route. Doing it in this process would charge the macOS permission to
  // whichever app happened to invoke the CLI.
  const result = await control(port, "/focus", sessionId);
  if (result === null) {
    process.stderr.write(
      `astir: could not reach a daemon on 127.0.0.1:${port}\n` +
        "focus is performed by the daemon so that only one application needs\n" +
        "macOS permission to raise windows; start it with `astir daemon`.\n",
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`${String(result.detail ?? "done")}\n`);
  if (result.ok !== true) process.exitCode = 1;
}

/** PSH-15 — one command to make a remote machine able to reach this one. */
function runPair(args: Args): void {
  const host = args.positional[0];
  if (host === undefined) {
    process.stderr.write("astir pair <host>   (an ssh host, as you would type it)\n");
    process.exitCode = 1;
    return;
  }
  const port = Number(args.flags.get("port") ?? process.env.ASTIR_PORT ?? DEFAULT_PORT);
  const notifyPort = Number(args.flags.get("notify-port") ?? process.env.ASTIR_NOTIFY_PORT ?? port + 1);

  const deps = defaultPairDeps();
  const result = pair(
    {
      host,
      notifyPort,
      token: readOrCreateToken(),
      dryRun: args.flags.get("dry-run") === true,
    },
    {
      ...deps,
      // Editing ~/.ssh/config governs how the user reaches every machine they
      // own, so it is opt-in. --yes exists for scripted setup.
      confirm: (question) => {
        if (args.flags.get("yes") === true) return true;
        process.stdout.write(`\n  ${question} [y/N] `);
        const answer = readLineSync();
        return /^y(es)?$/i.test(answer.trim());
      },
    },
  );
  if (!result.ok) process.exitCode = 1;
}

/** Read one line from stdin without pulling in a prompt library. */
function readLineSync(): string {
  const buf = Buffer.alloc(64);
  try {
    const n = readSync(0, buf, 0, buf.length, null);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  }
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
    case "pair":
      runPair(args);
      return;
    case "allow-sandbox":
      runAllowSandbox(args);
      return;
    case "watch":
      runWatch(args);
      return;
    case "autostart":
      runAutostart(args);
      return;
    default:
      usage();
      return;
  }
}

void main().catch((err: unknown) => {
  process.stderr.write(`astir: failed to start: ${String(err)}\n`);
  process.exit(1);
});
