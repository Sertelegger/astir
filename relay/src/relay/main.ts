import { join } from "node:path";
import { homedir } from "node:os";
import { rmSync } from "node:fs";
import { systemClock } from "../model/clock.js";
import { SessionState } from "../model/session-state.js";
import { Counters } from "../log/logger.js";
import { RelayServer } from "./server.js";
import { Lifecycle } from "./lifecycle.js";
import { generateToken } from "../security/token.js";
import { writeDiscovery } from "../security/discovery.js";
import type { Provider } from "../contract/types.js";
import { makeSummarizer } from "./model-providers.js";

async function run(): Promise<void> {
  const sessionId = process.env.CLIDE_SESSION_ID ?? "local";
  const provider = (process.env.CLIDE_PROVIDER as Provider) ?? "claude";
  const cwd = process.env.CLIDE_CWD ?? process.cwd();
  const sessionPid = Number(process.env.CLIDE_SESSION_PID ?? process.ppid);
  const token = generateToken();

  /* c8 ignore start — entry-point glue; verified manually */
  const summarizer = makeSummarizer({ mode: (process.env.CLIDE_SUMMARIZER as "auto" | "off") ?? "auto", provider });
  let serverRef: RelayServer;
  const state = new SessionState({ sessionId, provider, cwd, clock: systemClock, summarizer, onNowUpdate: () => serverRef.poke() });
  /* c8 ignore stop */
  state.build();
  const counters = new Counters();
  const server = new RelayServer({ state, token, counters });
  serverRef = server;
  const port = await server.listen();

  const discoveryPath = join(homedir(), ".clide", "sessions", `${sessionId}.json`);
  writeDiscovery(discoveryPath, { v: 1, provider, sessionId, pid: sessionPid, cwd, port, token, startedAt: Date.now() / 1000, state: "live" });

  const lifecycle = new Lifecycle({
    pidAlive: () => { try { process.kill(sessionPid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } },
    idleShutdownMs: 30 * 60_000,
    endGraceMs: 5 * 60_000,
    onShutdown: () => { try { rmSync(discoveryPath, { force: true }); } catch { /* */ } void server.close().then(() => process.exit(0)); },
  });
  setInterval(() => { state.tick(Date.now() / 1000); lifecycle.evaluate(Date.now()); }, 1000);
}

void run();
