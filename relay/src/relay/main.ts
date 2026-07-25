import { join } from "node:path";
import { homedir } from "node:os";
import { rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { systemClock } from "../model/clock.js";
import { SessionState } from "../model/session-state.js";
import { Counters } from "../log/logger.js";
import { RelayServer } from "./server.js";
import { Lifecycle } from "./lifecycle.js";
import { generateToken } from "../security/token.js";
import { writeDiscovery } from "../security/discovery.js";
import type { Provider } from "../contract/types.js";
import { makeSummarizer } from "./model-providers.js";
import { DEFAULT_SPEC_GLOBS } from "./spec-watch.js";
import { launchViewer } from "./spec-viewer.js";

async function run(): Promise<void> {
  const sessionId = process.env.CLIDE_SESSION_ID ?? "local";
  const provider = (process.env.CLIDE_PROVIDER as Provider) ?? "claude";
  const cwd = process.env.CLIDE_CWD ?? process.cwd();
  const sessionPid = Number(process.env.CLIDE_SESSION_PID ?? process.ppid);
  const token = generateToken();

  /* c8 ignore start — entry-point glue; verified manually */
  const summarizer = makeSummarizer({ mode: (process.env.CLIDE_SUMMARIZER as "auto" | "off") ?? "auto", provider, transport: (process.env.CLIDE_SUMMARIZER_TRANSPORT as "cli" | "api") ?? "cli" });
  let serverRef: RelayServer;
  let lifecycleRef: Lifecycle; // late-bound: Lifecycle is built after the state it observes (same pattern as serverRef)
  const state = new SessionState({
    sessionId, provider, cwd, clock: systemClock, summarizer, onNowUpdate: () => serverRef.poke(),
    specGlobs: process.env.CLIDE_SPEC_GLOBS?.split(",") ?? DEFAULT_SPEC_GLOBS,
    onSpec: (path, changeKind) => {
      serverRef.emitSpec(path, changeKind);
      if (changeKind === "created" && process.env.CLIDE_SPEC_VIEWER) launchViewer(process.env.CLIDE_SPEC_VIEWER, join(cwd, path));
    },
    // Feed the event stream into the Lifecycle: keeps the idle backstop meaningful and
    // arms the ENDED→grace→SHUTDOWN path (a /clear would otherwise leak this relay).
    onIngest: (kind) => {
      const now = Date.now();
      lifecycleRef.note(now);
      if (kind === "session_start") lifecycleRef.onSessionStart(now);
      else if (kind === "session_end") lifecycleRef.onSessionEnd(now);
    },
  });
  state.build();
  const counters = new Counters();
  // Serve the built web app so one URL (http://127.0.0.1:<port>/?token=…&session=…) is enough.
  // From relay/dist/relay/main.js (and relay/src/relay/main.ts under tsx) that is <repo>/web/dist.
  const webDir = process.env.CLIDE_WEB_DIR ?? fileURLToPath(new URL("../../../web/dist", import.meta.url));
  const server = new RelayServer({ state, token, counters, ...(existsSync(webDir) ? { staticDir: webDir } : {}) });
  serverRef = server;

  // Built before listen(): once the port is open an event can arrive, and onIngest needs lifecycleRef.
  const discoveryPath = join(homedir(), ".clide", "sessions", `${sessionId}.json`);
  const lifecycle = new Lifecycle({
    pidAlive: () => { try { process.kill(sessionPid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } },
    idleShutdownMs: 30 * 60_000,
    endGraceMs: 5 * 60_000,
    onShutdown: () => { try { rmSync(discoveryPath, { force: true }); } catch { /* */ } void server.close().then(() => process.exit(0)); },
  });
  lifecycleRef = lifecycle;
  lifecycle.note(Date.now()); // so lastEventMs is never 0 (the idle backstop would fire immediately)
  /* c8 ignore stop */
  const port = await server.listen();

  writeDiscovery(discoveryPath, { v: 1, provider, sessionId, pid: sessionPid, cwd, port, token, startedAt: Date.now() / 1000, state: "live" });

  /* c8 ignore start — entry-point glue; verified manually */
  setInterval(() => { state.tick(Date.now() / 1000); lifecycle.evaluate(Date.now()); }, 1000);
  /* c8 ignore stop */
}

void run();
