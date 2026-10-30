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

import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adjacentTo, type Far, httpOn, silentOn } from "./fixtures/sockets.js";

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
  //
  // Invoke tsc through node directly rather than via `npm run build`: on Windows
  // the npm shim is `npm.cmd`, which `execFileSync` cannot resolve by bare name
  // (ENOENT) and, once named explicitly, Node refuses to spawn without
  // `shell: true` (EINVAL, from the CVE-2024-27980 hardening). Going straight to
  // the compiler sidesteps both and is one process fewer. Both failures were
  // surfaced by the non-blocking windows CI job.
  const tsc = join(REPO, "node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
    cwd: REPO,
    stdio: "pipe",
  });
  // The same postbuild step `npm run build` runs. Invoked explicitly because
  // this test deliberately bypasses npm, and skipping it would leave the entry
  // non-executable — which is itself one of the things asserted below.
  execFileSync(process.execPath, [join(REPO, "scripts", "postbuild.mjs")], {
    cwd: REPO,
    stdio: "pipe",
  });

  proc = spawn(process.execPath, [ENTRY, "daemon", "--port", "0", "--token", TOKEN], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
    // `ASTIR_NO_PERSIST` was added to two spawns below and missed on THIS one,
    // which is the only one that persists anything. Without it the test daemon
    // loads the developer's real `~/.astir/state.json` — inheriting whatever
    // the real daemon was doing, so one genuinely blocked agent makes `dismiss`
    // look broken — and overwrites that file on shutdown, which is the exact
    // loss the flag exists to prevent.
    //
    // It passes in CI either way, because CI has no snapshot. A suite that is
    // green on a clean machine and red on a working one is worse than no suite:
    // the failure reads as a bug in the code rather than in the harness.
    env: { ...process.env, ASTIR_NO_PERSIST: "1" },
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
  inStateMs: number;
}
interface StateSession {
  sessionId: string;
  agents: StateAgent[];
}
interface StateBody {
  blockedCount: number;
  sessions: StateSession[];
}

describe("the SessionStart daemon starter (DMN-12)", () => {
  const script = join(REPO, "hooks", "ensure-daemon.sh");

  it("is registered on SessionStart as an async command hook", () => {
    // async so it never delays a session coming up, and SessionStart so its cost
    // is one process per session rather than one per tool call.
    const cfg = JSON.parse(readFileSync(join(REPO, "hooks", "hooks.json"), "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    };
    const starter = cfg.hooks.SessionStart?.[0]?.hooks.find((h) => h.type === "command");
    expect(starter, "SessionStart must carry a command hook to start the daemon").toBeDefined();
    expect(starter?.async, "it must not block session startup").toBe(true);
    expect(String(starter?.command)).toContain("ensure-daemon.sh");

    // Claude Code validates this file against a schema and warns on every
    // session start for anything it does not recognise. A `_comment` key lived
    // here for months doing exactly that: harmless, ignored, and printed to the
    // user forever. JSON has no comments — the prose is in `hooks/README.md`.
    const allowed = new Set(["hooks"]);
    const unknown = Object.keys(cfg).filter((k) => !allowed.has(k));
    expect(unknown, `hooks.json carries keys the plugin schema will reject: ${unknown}`).toEqual([]);
    // ${CLAUDE_PLUGIN_ROOT} — the plugin is installed to a cache directory whose
    // path nobody can hardcode.
    expect(String(starter?.command)).toContain("CLAUDE_PLUGIN_ROOT");
  });

  it.skipIf(process.platform === "win32")("is executable, or the hook silently does nothing", () => {
    expect(statSync(script).mode & 0o111, "hooks/ensure-daemon.sh must be executable").toBeGreaterThan(0);
  });

  it.skipIf(process.platform === "win32")("exits 0 even when it can do nothing at all", () => {
    // A hook that reported a failure while trying to prevent hook noise would be
    // self-defeating. Pointed at a root with no build, with the environment
    // scrubbed, it must still succeed silently.
    const out = execFileSync("/bin/bash", [script], {
      encoding: "utf8",
      env: {
        HOME: homedir(),
        // This daemon runs against the REAL home for its token; it must not
        // also overwrite the real crash-recovery snapshot.
        ASTIR_NO_PERSIST: "1",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        CLAUDE_PLUGIN_ROOT: "/nonexistent/astir",
        // Do not start a daemon from the test run.
        ASTIR_NO_AUTOSTART: "1",
      },
      timeout: 15_000,
    });
    expect(out).toBe("");
  });
});

describe("built daemon artifact", () => {
  // Windows has no POSIX permission bits — `statSync().mode` reports none and
  // execution is decided by file extension and PATHEXT instead. The property is
  // genuinely absent there rather than failing, so assert it only where it means
  // something.
  it.skipIf(process.platform === "win32")("is executable, so `bin` and menu-bar clicks both work", () => {
    // `tsc` emits 0644. npm chmods bin links on install, so this is invisible
    // until someone runs a checkout in place and every SwiftBar menu action
    // silently does nothing.
    const mode = statSync(join(REPO, "dist", "cli", "main.js")).mode;
    expect(mode & 0o111, "dist/cli/main.js must carry the execute bit").toBeGreaterThan(0);
  });

  // SwiftBar runs plugins from launchd, not from a shell, so the wrapper cannot
  // rely on the PATH a terminal shows. Scrubbing the environment here is the
  // whole point: with an inherited PATH this passes even when it is broken for
  // every real user, which is the class of untested-process-boundary bug that
  // made the previous version of this project ship something that never ran.
  it.skipIf(process.platform === "win32")("the SwiftBar wrapper finds astir with no shell PATH", () => {
    const wrapper = join(REPO, "contrib", "swiftbar", "astir.3s.sh");
    const out = execFileSync("/bin/bash", [wrapper], {
      encoding: "utf8",
      // node itself is a genuine dependency and lives wherever the platform put
      // it (a CI tool cache, a version manager). Everything the *shell* would
      // add — version-manager shims, the npm global bin — is scrubbed, which is
      // what the wrapper has to survive.
      env: {
        HOME: homedir(),
        ASTIR_NO_PERSIST: "1",
        PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${dirname(process.execPath)}`,
      },
      timeout: 30_000,
    });
    expect(out, "the wrapper must locate astir without help from the shell").not.toContain(
      "astir not found on PATH",
    );
    // Whatever the daemon's state, a well-formed plugin always offers a refresh.
    expect(out).toContain("refresh=true");
  });

  it("dismiss and forget are reachable on the built artifact (PSH-10)", async () => {
    const sessionId = "artifact-dismiss-check";
    await fetch(`${base}/hook/claude`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        hook_event_name: "Notification",
        session_id: sessionId,
        cwd: REPO,
        notification_type: "permission_prompt",
      }),
    });

    const blockedNow = async (): Promise<number> =>
      (await json<StateBody>(await fetch(`${base}/state`, { headers: auth }))).blockedCount;
    expect(await blockedNow(), "the injected agent should be counted").toBeGreaterThan(0);

    const dismissed = await fetch(`${base}/dismiss?session=${sessionId}`, {
      method: "POST",
      headers: auth,
    });
    expect(dismissed.status).toBe(200);
    expect(await blockedNow(), "dismissing clears the badge").toBe(0);

    const forgotten = await fetch(`${base}/forget?session=${sessionId}`, {
      method: "POST",
      headers: auth,
    });
    expect(forgotten.status).toBe(200);
    const after = await json<StateBody>(await fetch(`${base}/state`, { headers: auth }));
    expect(after.sessions.find((s) => s.sessionId === sessionId)).toBeUndefined();
  });

  it("reports a live wait duration that actually advances", async () => {
    // The defect this guards: `blockedMs` only accrues on leaving the state, so
    // a still-blocked agent rendered "waiting 0s" forever.
    const sessionId = "artifact-duration-check";
    await fetch(`${base}/hook/claude`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        hook_event_name: "Notification",
        session_id: sessionId,
        cwd: REPO,
        notification_type: "permission_prompt",
      }),
    });

    const inState = async (): Promise<number> => {
      const state = await json<StateBody>(await fetch(`${base}/state`, { headers: auth }));
      return state.sessions.find((s) => s.sessionId === sessionId)?.agents[0]?.inStateMs ?? -1;
    };

    const first = await inState();
    await new Promise((r) => setTimeout(r, 1_100));
    const second = await inState();

    expect(first).toBeGreaterThanOrEqual(0);
    expect(second, "the wait must grow while the agent is still waiting").toBeGreaterThan(first);
  });

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

  it.skipIf(process.platform === "win32")(
    "reaps a Codex session once the process its relay named is gone",
    async () => {
      // The wiring, not the logic: pids.test.ts proves the lister, and only
      // the built daemon proves anything runs it. A child that lives until we
      // kill it stands in for the Codex process.
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
      const sessionId = "codex-liveness-artifact";
      const sent = await fetch(`${base}/hook/codex`, {
        method: "POST",
        headers: { ...auth, "x-astir-agent-pid": String(child.pid) },
        body: JSON.stringify({ session_id: sessionId, hook_event_name: "SessionStart", cwd: REPO }),
      });
      expect(sent.status).toBe(200);

      const present = async () =>
        (await json<StateBody>(await fetch(`${base}/state`, { headers: auth }))).sessions.some(
          (s) => s.sessionId === sessionId,
        );
      // Survives a discovery tick while its process lives...
      await new Promise((r) => setTimeout(r, 6_000));
      expect(await present()).toBe(true);

      // ...and is gone within one after it dies, with no SessionEnd.
      child.kill("SIGKILL");
      const deadline = Date.now() + 12_000;
      while ((await present()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
      expect(await present()).toBe(false);
    },
    30_000,
  );

  it("counts state reads, so a watching surface is observable (OBS-01)", async () => {
    const before = (await json<{ counters: { statePolls: number } }>(await fetch(`${base}/healthz`))).counters
      .statePolls;
    await fetch(`${base}/state`, { headers: auth });
    const after = (await json<{ counters: { statePolls: number } }>(await fetch(`${base}/healthz`))).counters
      .statePolls;
    // OBS-01: a counter that cannot move must not exist. This one is how you
    // tell "the menu bar is polling" from "the menu bar is not running".
    expect(after).toBe(before + 1);
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

/**
 * #82 — what the built CLI runs with below: nothing from the developer's
 * machine. No `~/.astir`, no `~/.ssh/config`, no token or port in the
 * environment, and no `claude` on PATH for a daemon to poll.
 */
function cleanEnv(home: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, HOME: home, ASTIR_NO_PERSIST: "1" };
  for (const key of [
    "ASTIR_PORT",
    "ASTIR_NOTIFY_PORT",
    "ASTIR_TOKEN",
    "ASTIR_NOTIFY_TOKEN",
    "ASTIR_NOTIFY_URL",
    "CLAUDE_CONFIG_DIR",
  ]) {
    delete e[key];
  }
  // `node` is spawned by its own path; `ps` and the rest are in these.
  if (process.platform !== "win32") e.PATH = "/usr/bin:/bin";
  return e;
}

const NOTIFY_TOKEN = "notify-token-not-a-secret";

/** `astir daemon` from the build, on a port of its own choosing; resolves once it answers. */
async function startDaemon(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ proc: ChildProcess; port: number }> {
  const child = spawn(
    process.execPath,
    [ENTRY, "daemon", "--port", "0", "--token", TOKEN, "--notify-token", NOTIFY_TOKEN, ...args],
    { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], env },
  );
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error(`no port announced; stdout=${buf}`)), 15_000);
      child.stdout?.on("data", (c: Buffer) => {
        buf += c.toString();
        const m = /listening on 127\.0\.0\.1:(\d+)/.exec(buf);
        if (m?.[1]) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
      child.on("exit", (code) => reject(new Error(`daemon exited early (code ${code}); stdout=${buf}`)));
    });
    await waitForReady(`http://127.0.0.1:${port}`);
    return { proc: child, port };
  } catch (err) {
    child.kill("SIGTERM");
    throw err;
  }
}

interface Delivery {
  live?: string[];
  attached?: string[];
}

/** Polls the daemon's `/healthz` until its `delivery` is what `want` says, or the deadline; returns the last. */
async function deliveryUntil(
  port: number,
  want: (d: Delivery | undefined) => boolean,
  ms: number,
): Promise<Delivery | undefined> {
  const read = async () =>
    (await json<{ delivery?: Delivery }>(await fetch(`http://127.0.0.1:${port}/healthz`))).delivery;
  const deadline = Date.now() + ms;
  let last = await read();
  while (!want(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    last = await read();
  }
  return last;
}

/**
 * A notifier stand-in: says it is one (and whether it can show), answers
 * `/state` after `stateMs` — one doorbell from another machine, or
 * `stateStatus` when that is set — and takes any doorbell or roster push.
 */
function notifierStandIn(
  opts: { stateMs?: number; stateStatus?: number; canShow?: boolean } = {},
): Promise<Far> {
  return httpOn((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/state") {
      if (opts.stateStatus !== undefined) {
        res.statusCode = opts.stateStatus;
        res.end("{}");
        return;
      }
      const agent = {
        host: "laptop",
        repo: "web",
        sessionId: "r1",
        agentId: "main",
        reason: "permission_prompt",
        since: Date.now() - 60_000,
        lastSeen: Date.now(),
        acknowledged: false,
      };
      setTimeout(() => res.end(JSON.stringify({ agents: [agent], sessions: [] })), opts.stateMs ?? 0);
    } else if (req.url === "/healthz") {
      res.end(JSON.stringify({ ok: true, role: "notifier", canShow: opts.canShow ?? true }));
    } else {
      req.resume();
      res.end("{}");
    }
  });
}

const run = promisify(execFile);

interface LineDoc {
  warnings: Array<{ kind: string; text: string }>;
  announced: number;
}

/** `astir status --line --json`, the built CLI, as astir-tui runs it. Async: the notifier lives in this process. */
async function lineJson(daemonPort: number, notifyPort: number, env: NodeJS.ProcessEnv): Promise<LineDoc> {
  const { stdout } = await run(
    process.execPath,
    [ENTRY, "status", "--line", "--json", "--port", String(daemonPort), "--notify-port", String(notifyPort)],
    { env: { ...env, ASTIR_TOKEN: TOKEN, ASTIR_NOTIFY_TOKEN: NOTIFY_TOKEN }, timeout: 15_000 },
  );
  return JSON.parse(stdout) as LineDoc;
}

const NOT_ANSWERING = { kind: "unreachable", text: "astir: notifier not answering" };

/**
 * #82 — a daemon started with `--notify-url`, as `astir --help` and the
 * install text tell another machine to start it, against a notifier that is
 * healthy and slow: `/state` in 700 ms, past the line's half second for a
 * notifier the daemon does not vouch for, inside its whole budget.
 *
 * Nothing probes that notifier, but the daemon reads its `/state` every 5 s.
 * The first fix reported `delivery.attached: []` for it regardless, so every
 * `status --line` (and astir-tui, which reads the same `--json`) capped it at
 * 500 ms and called it "notifier not answering" while the daemon listed it
 * live — and left its doorbells out of the count. The real CLI on both ends,
 * as the verifier reproduced it; only the notifier is a stand-in.
 *
 * Twice: as 127.0.0.1, and as `localhost` (review:82 F1). The daemon names
 * the target as it was typed, and the line, which asks 127.0.0.1, matched
 * that name by spelling — so `localhost` lost the vouch, and the line called
 * the same healthy notifier hung on every run.
 */
describe.each(["127.0.0.1", "localhost"])(
  "built daemon with --notify-url http://%s:<port>/notify vouches for the notifier it reads",
  (host) => {
    let home: string;
    let far: Far;
    let daemon: { proc: ChildProcess; port: number } | undefined;
    const name = () => `remote(http://${host}:${far.port}/notify)`;

    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), "astir-notify-url-"));
      far = await notifierStandIn({ stateMs: 700 });
      daemon = await startDaemon(["--notify-url", `http://${host}:${far.port}/notify`], cleanEnv(home));
    });

    afterAll(async () => {
      daemon?.proc.kill("SIGTERM");
      await far?.close();
      rmSync(home, { recursive: true, force: true });
    });

    it("lists the notifier as attached once it has read its /state", async () => {
      const d = await deliveryUntil(daemon?.port ?? 0, (d) => (d?.attached ?? []).length > 0, 5_000);
      expect(d?.attached).toEqual([name()]);
    }, 15_000);

    it("so `status --line` waits for it and counts its doorbell, rather than calling it not answering", async () => {
      const doc = await lineJson(daemon?.port ?? 0, far.port, cleanEnv(home));
      expect(doc.warnings).toEqual([]);
      expect(doc.announced).toBe(1);
    }, 20_000);

    it("stops vouching once the forward goes stale: the cap is back within a poll or two", async () => {
      // review:82 finding 5 — nothing probes a `--notify-url` notifier, so a
      // vouch read off `live` lasted until a POST failed, which on an idle
      // machine is never. A poll that times out withdraws this one.
      const port = far.port;
      await far.close();
      far = await silentOn(port);
      // At worst one 5 s interval plus the poll's own 2 s timeout; the rest is
      // slack for a loaded runner, and costs nothing once it says `[]`.
      const d = await deliveryUntil(daemon?.port ?? 0, (d) => (d?.attached ?? []).length === 0, 15_000);
      expect(d?.attached).toEqual([]);
      const doc = await lineJson(daemon?.port ?? 0, port, cleanEnv(home));
      expect(doc.announced).toBe(0);
      expect(doc.warnings).toContainEqual(NOT_ANSWERING);
    }, 30_000);
  },
);

/**
 * review:82 F4 — a `--notify-url` notifier that refuses the daemon's `/state`
 * read (a token that does not match) still answered it: it is reached, and
 * reached is all `attached` says. Whether it will take a doorbell is
 * `delivery.live`'s question, not this one.
 */
describe("built daemon with --notify-url counts a refused /state as reached", () => {
  let home: string;
  let far: Far;
  let daemon: { proc: ChildProcess; port: number } | undefined;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "astir-notify-401-"));
    far = await notifierStandIn({ stateStatus: 401 });
    daemon = await startDaemon(["--notify-url", `http://127.0.0.1:${far.port}/notify`], cleanEnv(home));
  });

  afterAll(async () => {
    daemon?.proc.kill("SIGTERM");
    await far?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("lists it as attached", async () => {
    const d = await deliveryUntil(daemon?.port ?? 0, (d) => (d?.attached ?? []).length > 0, 7_000);
    expect(d?.attached).toEqual([`remote(http://127.0.0.1:${far.port}/notify)`]);
  }, 15_000);
});

/**
 * review:82 F3 — a daemon with no `--notify-url` FINDS its notifier: it
 * probes the notifier port (`--notify-port`, as the menu bar's and the TUI's
 * line ask it) and attaches what answers as one. That wiring,
 * `deliveryAttached → watch.reached()` in `runDaemon`, is what every probed
 * machine's line reads, and no unit test reaches it: listing nothing, or
 * listing what can deliver in its place, failed nothing.
 *
 * Two daemons, two stand-ins, both slow on `/state`: one that can show, and
 * one that cannot — reached by every probe, and never live. The second is
 * the case `attached` exists for.
 */
describe("built daemon vouches for the notifier its probe finds, whether or not it can deliver", () => {
  let home: string;
  const fars: Far[] = [];
  const daemons: ChildProcess[] = [];
  let shows: { far: Far; port: number };
  let mute: { far: Far; port: number };

  const name = (far: Far) => `remote(http://127.0.0.1:${far.port}/notify)`;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "astir-probed-"));
    const start = async (canShow: boolean) => {
      const far = await notifierStandIn({ stateMs: 700, canShow });
      fars.push(far);
      const d = await startDaemon(["--notify-port", String(far.port)], cleanEnv(home));
      daemons.push(d.proc);
      return { far, port: d.port };
    };
    [shows, mute] = await Promise.all([start(true), start(false)]);
  });

  afterAll(async () => {
    for (const d of daemons) d.kill("SIGTERM");
    for (const far of fars) await far.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("lists the notifier its probe reached as attached, and the line waits for it", async () => {
    const d = await deliveryUntil(shows.port, (d) => (d?.attached ?? []).length > 0, 7_000);
    expect(d?.attached).toEqual([name(shows.far)]);
    expect(d?.live).toContain(name(shows.far));
    const doc = await lineJson(shows.port, shows.far.port, cleanEnv(home));
    expect(doc.warnings).not.toContainEqual(NOT_ANSWERING);
    expect(doc.announced).toBe(1);
  }, 25_000);

  it("lists one that cannot show as attached too, though it is not live, and the line still waits for it", async () => {
    const d = await deliveryUntil(mute.port, (d) => (d?.attached ?? []).length > 0, 7_000);
    expect(d?.attached).toEqual([name(mute.far)]);
    expect(d?.live ?? []).not.toContain(name(mute.far));
    const doc = await lineJson(mute.port, mute.far.port, cleanEnv(home));
    // Not `toEqual([])`: on a machine whose local path is dead too, nothing
    // is live, and the line rightly says no one will be told.
    expect(doc.warnings).not.toContainEqual(NOT_ANSWERING);
    expect(doc.announced).toBe(1);
  }, 25_000);
});

/**
 * review:82 F5 — `doctor` on a port that accepts and never answers names two
 * causes, the likelier first, and which is likelier is read off this
 * machine: a `RemoteForward` for the notifier port in ~/.ssh/config means its
 * own notifier serves that port, so a hang is most likely that notifier's.
 * Without one, the port is most likely a forward from another machine left by
 * a dropped session. `runDoctor` works that out; the order is all that shows.
 *
 * `doctor --port P` probes the notifier on P + 1, so the silent socket takes
 * P + 1 of a pair found free — never 47000/47001.
 */
describe.skipIf(process.platform === "win32")(
  "built doctor orders a silent notifier port's causes by this machine's pairing",
  () => {
    const open: Far[] = [];
    const homes: string[] = [];

    afterAll(async () => {
      for (const far of open) await far.close();
      for (const home of homes) rmSync(home, { recursive: true, force: true });
    });

    const doctor = async (paired: boolean) => {
      const home = mkdtempSync(join(tmpdir(), "astir-doctor-82-"));
      homes.push(home);
      const { port, far } = await adjacentTo((p) => silentOn(p));
      open.push(far);
      if (paired) {
        mkdirSync(join(home, ".ssh"));
        // What `astir pair devbox` writes.
        writeFileSync(
          join(home, ".ssh", "config"),
          `\nHost devbox\n  RemoteForward ${far.port} 127.0.0.1:${far.port}\n`,
        );
      }
      const { stdout } = await run(process.execPath, [ENTRY, "doctor", "--port", String(port)], {
        env: cleanEnv(home),
        timeout: 20_000,
      });
      expect(stdout).toContain(`something holds 127.0.0.1:${far.port} but did not answer in time`);
      return stdout;
    };

    it("names this machine's own notifier first when it forwards the port to another", async () => {
      const out = await doctor(true);
      const hung = out.indexOf("the notifier on this machine has most likely hung");
      const forward = out.indexOf("left its `ssh -R` forward");
      expect(hung).toBeGreaterThan(-1);
      expect(forward).toBeGreaterThan(hung);
      expect(out.indexOf("`node`")).toBeLessThan(out.indexOf("`sshd`"));
    }, 30_000);

    it("names a stale forward first when nothing here pairs the port", async () => {
      const out = await doctor(false);
      const forward = out.indexOf("most likely an ssh session that dropped left its `ssh -R` forward");
      const hung = out.indexOf("a notifier on this machine has hung");
      expect(forward).toBeGreaterThan(-1);
      expect(hung).toBeGreaterThan(forward);
      expect(out.indexOf("`sshd`")).toBeLessThan(out.indexOf("`node`"));
    }, 30_000);
  },
);
