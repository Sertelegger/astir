/**
 * SC8 / §9 — "The built artifacts run."
 *
 * This is the test whose absence let the previous version ship a product that
 * could never work: `hook-entry.ts` exported a `main()` that nothing called,
 * and 214 unit tests passed anyway because every one of them exercised the
 * pure core with fake dependencies.
 *
 * Rules for this file:
 *   - It MUST spawn the real built output from `dist/`, never import from `src/`.
 *   - It MUST assert an externally observable effect, not an internal call.
 *   - A parse check (`node --check`) does not satisfy it.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(REPO, "dist", "cli", "main.js");
const TOKEN = "test-token-not-a-secret";

let proc: ChildProcess | undefined;
let base: string;

/** Poll until the daemon answers, so the test never races startup. */
async function waitForReady(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon never became ready: ${String(lastErr)}`);
}

beforeAll(async () => {
  // Build from source so this test can never pass against a stale dist.
  // On Windows the executable is `npm.cmd`; `execFileSync` does not consult
  // PATHEXT, so the bare name fails with ENOENT. Caught by the non-blocking
  // windows CI job on its first run.
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(npm, ["run", "build"], { cwd: REPO, stdio: "pipe" });

  proc = spawn(process.execPath, [ENTRY, "daemon", "--port", "0", "--token", TOKEN], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // The daemon prints its bound address on stdout as its first line.
  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`no port announced; stdout=${buf}`)), 15_000);
    proc?.stdout?.on("data", (c: Buffer) => {
      buf += c.toString();
      const m = /listening on 127\.0\.0\.1:(\d+)/.exec(buf);
      if (m?.[1]) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    proc?.on("exit", (code) => reject(new Error(`daemon exited early (code ${code}); stdout=${buf}`)));
  });

  base = `http://127.0.0.1:${port}`;
  await waitForReady(base);
});

afterAll(() => {
  proc?.kill("SIGTERM");
});

const auth = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

/** `Response.json()` is `unknown` under strict typings; narrow at the boundary. */
async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface StateAgent {
  id: string;
  agentType: string | null;
  parentSource: string | null;
  state: string;
}
interface StateSession {
  sessionId: string;
  agents: StateAgent[];
}
interface StateBody {
  blockedCount: number;
  sessions: StateSession[];
}

describe("built daemon artifact", () => {
  it("starts from dist/ and answers /healthz unauthenticated", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect((await json<{ ok: boolean }>(res)).ok).toBe(true);
  });

  it("requires a bearer token on data routes (DMN-01)", async () => {
    expect((await fetch(`${base}/state`)).status).toBe(401);
    expect((await fetch(`${base}/state`, { headers: auth })).status).toBe(200);
  });

  it("ingests a REAL captured hook payload and reflects it in /state", async () => {
    const fixture = JSON.parse(
      readFileSync(join(REPO, "test", "fixtures", "claude", "subagent-start.json"), "utf8"),
    );

    const post = await fetch(`${base}/hook/claude`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(fixture),
    });
    expect(post.status).toBe(200);

    const state = await json<StateBody>(await fetch(`${base}/state`, { headers: auth }));
    const session = state.sessions.find((s) => s.sessionId === fixture.session_id);
    expect(session, "session should exist after ingest").toBeTruthy();

    const agent = session?.agents.find((a) => a.id === fixture.agent_id);
    expect(agent, "subagent should be registered").toBeTruthy();
    expect(agent?.agentType).toBe("general-purpose");
  });

  it("rejects a malformed payload with non-2xx and stays alive (DMN-03/04)", async () => {
    const bad = await fetch(`${base}/hook/claude`, {
      method: "POST",
      headers: auth,
      body: "{ not json",
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);

    // The daemon must survive hostile input.
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});
