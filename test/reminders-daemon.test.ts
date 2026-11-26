/**
 * PSH-02 (#98) — the built daemon runs the reminder schedule it names, and
 * doctor reports the daemon's answer.
 *
 * reminders.test.ts drives the policy, the source, `/healthz` and doctor's
 * wording, each through a correct helper. None of that reaches the call sites
 * in `cli/main.ts` that join them up, and each could come apart quietly: a
 * policy built without the source runs calm whatever the file says, while the
 * startup line and `/healthz`, read from the source, go on naming the schedule
 * chosen. So this runs the real thing. A HOME whose config file asks for
 * insistent, the daemon built from source, and a reminder seen arriving a
 * minute after the first alert, which is the only way to tell insistent from
 * calm (calm waits ten). That makes one test here a minute long, on purpose.
 *
 * The rest of `main.ts`'s #98 wiring is run here too, each piece where a unit
 * test cannot reach it: the daemon re-reads an edited file and says so (last,
 * since every test before it assumes insistent); its roster names the agents
 * still blocked, which keeps them reachable on the far side under a quiet
 * schedule; `astir install` says what the default is; and on macOS — faked
 * with a preload that sets `process.platform`, since CI runs on Linux —
 * `astir notifier` and `astir doctor` carry the Alerts tip, and the notifier
 * groups and withdraws another machine's alerts through terminal-notifier
 * (a stub that logs its arguments).
 *
 * Built to a throwaway directory, as delivery-live.test.ts does, rather than
 * `dist/`, which artifact.test.ts rebuilds alongside. The environment is
 * scrubbed of display and bus variables and of ASTIR_REMINDERS, and the
 * doorbells go to a capture server through `--notify-url`, so nothing reaches
 * a screen and no notifier port is probed. Every spawned command gets a HOME
 * of its own under the throwaway directory and port 0.
 */

import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configPath } from "../src/config/paths.js";
import { buildEnvelope } from "../src/notify/envelope.js";
import { createNotifierBackend } from "../src/notify/notify.js";
import { type Far, httpOn } from "./fixtures/sockets.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "reminders-daemon-test-token";
const scrubbed = { PATH: "/usr/bin:/bin", ASTIR_NO_PERSIST: "1" };
// What this platform gives a process with no desktop. Where that can show a
// notification (macOS), the block below would put one on the screen.
const local = createNotifierBackend({ env: scrubbed });

/** Wait until `done` holds or `ms` runs out; the assertion after says which. */
async function until(done: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
}

describe.skipIf(process.platform === "win32")("PSH-02 — the built daemon runs the schedule it names", () => {
  let root = "";
  let entry = "";
  let path = "";
  let env: Record<string, string> = {};
  let proc: ChildProcess | undefined;
  let capture: Far | undefined;
  let base = "";
  let stdout = "";
  const doorbells: { kind: string; at: number }[] = [];
  const rosters: { sessions?: { sessionId?: string; blocked?: unknown }[] }[] = [];

  beforeAll(async () => {
    // Made here, not at collection, so a skipped run leaves nothing behind.
    root = mkdtempSync(join(tmpdir(), "astir-98-"));
    entry = join(root, "dist", "cli", "main.js");
    const home = join(root, "home");
    env = { ...scrubbed, HOME: home };
    mkdirSync(join(home, ".astir"), { recursive: true });
    path = configPath(home);
    writeFileSync(path, JSON.stringify({ notify: { reminders: "insistent" } }));

    const tsc = join(REPO, "node_modules", "typescript", "bin", "tsc");
    execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json", "--outDir", join(root, "dist")], {
      cwd: REPO,
      stdio: "pipe",
    });
    // ESM and a version, as the repo's own package.json gives `dist/`.
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string };
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", version: pkg.version }));

    // The notifier, as far as the daemon can tell: it takes every doorbell,
    // and answers the daemon's `/state` reads and roster pushes.
    capture = await httpOn((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => {
        body += c.toString();
      });
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/notify") {
          const envelope = JSON.parse(body) as { kind?: unknown };
          doorbells.push({ kind: String(envelope.kind), at: Date.now() });
        }
        if (req.method === "POST" && req.url === "/roster") rosters.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(req.url === "/state" ? JSON.stringify({ sessions: [] }) : "{}");
      });
    });

    proc = spawn(
      process.execPath,
      [
        entry,
        "daemon",
        "--port",
        "0",
        "--token",
        TOKEN,
        "--notify-url",
        `http://127.0.0.1:${capture.port}/notify`,
        "--notify-token",
        "t",
      ],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"], env },
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no listening line; stdout=${stdout}`)), 15_000);
      proc?.stdout?.on("data", (c: Buffer) => {
        stdout += c.toString();
        const p = /listening on 127\.0\.0\.1:(\d+)/.exec(stdout);
        if (p?.[1]) {
          clearTimeout(timer);
          base = `http://127.0.0.1:${p[1]}`;
          resolve();
        }
      });
      proc?.on("exit", (code) => reject(new Error(`daemon exited early (code ${code}); stdout=${stdout}`)));
    });
  }, 60_000);

  afterAll(async () => {
    proc?.kill("SIGTERM");
    await capture?.close();
    if (root !== "") rmSync(root, { recursive: true, force: true });
  });

  /** `astir doctor` against this daemon, from a terminal with `extra` in its environment. */
  const doctor = (extra: Record<string, string>): Promise<string> =>
    // Async: the capture server answers the daemon from this process.
    new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [entry, "doctor", "--port", new URL(base).port],
        { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 30_000 },
        (err, out) => (err ? reject(err) : resolve(out)),
      );
    });

  it("says on its startup line which schedule it runs, and from where", async () => {
    await until(() => /^reminders: /m.test(stdout), 5_000);
    expect(stdout).toMatch(/^delivery paths: /m);
    expect(/^reminders: .*$/m.exec(stdout)?.[0]).toBe(`reminders: insistent (${path})`);
  });

  it("says the same on /healthz", async () => {
    const body = (await (await fetch(`${base}/healthz`)).json()) as { reminders?: unknown };
    expect(body.reminders).toEqual({ schedule: "insistent", source: "config" });
  });

  it("doctor reports the daemon's schedule, not this terminal's", async () => {
    // An ASTIR_REMINDERS exported in the terminal the daemon never saw.
    const out = await doctor({ ASTIR_REMINDERS: "off" });
    expect(out).toContain(`insistent, from ${path}`);
    expect(out).toContain("this terminal reads off, from ASTIR_REMINDERS");
    expect(out).not.toContain("read here");
  });

  it("doctor names this terminal's unknown value while the daemon runs another", async () => {
    const out = await doctor({ ASTIR_REMINDERS: "loud" });
    expect(out).toContain(`insistent, from ${path}`);
    expect(out).toContain('this terminal reads calm, from ASTIR_REMINDERS — "loud" is not a schedule');
  });

  it.skipIf(local.available)(
    "reminds a blocked agent on that schedule: insistent's first reminder a minute after the alert",
    async () => {
      const posted = await fetch(`${base}/hook/claude`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          hook_event_name: "Notification",
          session_id: "astir-98-blocked",
          cwd: root,
          notification_type: "permission_prompt",
        }),
      });
      expect(posted.ok).toBe(true);
      const blocked = () => doorbells.filter((d) => d.kind === "blocked");

      // The first alert, once the dwell (PSH-16) has passed.
      await until(() => blocked().length >= 1, 20_000);
      expect(blocked(), "no first alert reached the notifier").toHaveLength(1);

      // Insistent's first reminder is a minute later; calm's would be ten.
      await until(() => blocked().length >= 2, 75_000);
      const [first, second] = blocked();
      expect(second, "no reminder within 75 s of the first alert").toBeDefined();
      const gap = (second?.at ?? 0) - (first?.at ?? 0);
      expect(gap).toBeGreaterThanOrEqual(55_000);
      expect(gap).toBeLessThanOrEqual(70_000);

      // #98 — and the roster, pushed every 10 s, names the agent still
      // blocked: under a quiet schedule it is what keeps the far side from
      // reading the agent as out of contact between reminders.
      const named = rosters
        .flatMap((r) => r.sessions ?? [])
        .filter((s) => s.sessionId === "astir-98-blocked");
      expect(named.length, "no roster listed the blocked session").toBeGreaterThan(0);
      expect(named.at(-1)?.blocked).toEqual(["astir-98-blocked"]);
    },
    120_000,
  );

  it("astir install says what the default reminders are", async () => {
    // Its own HOME, and no CLAUDE_CONFIG_DIR in the environment: the token and
    // settings it writes land in the throwaway directory.
    const home = join(root, "home-install");
    mkdirSync(home, { recursive: true });
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [entry, "install", "--no-plugin"],
        { cwd: root, env: { ...scrubbed, HOME: home }, encoding: "utf8", timeout: 30_000 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
    expect(out).toContain("the first alert, then +10 and +30 min, then hourly");
    expect(out).toContain(configPath(home));
    expect(out).not.toContain("every minute for ten");
  });

  describe("on macOS (process.platform faked), with terminal-notifier", () => {
    let darwin: Record<string, string> = {};
    let preload = "";
    let shown = "";
    let notifier: ChildProcess | undefined;
    let notifierOut = "";

    beforeAll(() => {
      preload = join(root, "fake-darwin.mjs");
      writeFileSync(preload, 'Object.defineProperty(process, "platform", { value: "darwin" });\n');
      // A terminal-notifier that shows nothing and logs what it was asked.
      const bin = join(root, "stub-bin");
      shown = join(root, "terminal-notifier.log");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "terminal-notifier"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${shown}'\n`);
      chmodSync(join(bin, "terminal-notifier"), 0o755);
      const home = join(root, "home-darwin");
      mkdirSync(home, { recursive: true });
      darwin = { ...scrubbed, PATH: `${bin}:${scrubbed.PATH}`, HOME: home };
    });

    afterAll(() => {
      notifier?.kill("SIGTERM");
    });

    const asDarwin = (args: string[]): string[] => ["--import", pathToFileURL(preload).href, entry, ...args];

    it("astir notifier greets with the Alerts tip, and groups and withdraws another machine's alerts", async () => {
      notifier = spawn(process.execPath, asDarwin(["notifier", "--port", "0", "--token", "tok"]), {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: darwin,
      });
      notifier.stdout?.on("data", (c: Buffer) => {
        notifierOut += c.toString();
      });
      await until(
        () => /listening on 127\.0\.0\.1:\d+/.test(notifierOut) && /dismiss it;/.test(notifierOut),
        15_000,
      );
      expect(notifierOut).toContain("Set terminal-notifier's notification style to Alerts");
      expect(notifierOut).not.toContain("brew install terminal-notifier");

      const port = /listening on 127\.0\.0\.1:(\d+)/.exec(notifierOut)?.[1];
      const post = (kind: "blocked" | "resolved") =>
        fetch(`http://127.0.0.1:${port}/notify`, {
          method: "POST",
          headers: { Authorization: "Bearer tok", "content-type": "application/json" },
          body: JSON.stringify(
            buildEnvelope({
              kind,
              reason: "permission_prompt",
              sessionId: "far-session",
              agentId: "far-agent",
              cwd: "/srv/astir",
              host: "megabrain",
            }),
          ),
        });
      expect((await post("blocked")).status).toBe(200);
      expect((await post("resolved")).status).toBe(200);
      await until(() => existsSync(shown) && readFileSync(shown, "utf8").includes("-remove"), 5_000);
      const calls = existsSync(shown) ? readFileSync(shown, "utf8").trim().split("\n") : [];
      expect(calls[0]).toContain("-group megabrain/far-session:far-agent");
      expect(calls[1]).toBe("-remove megabrain/far-session:far-agent");
    });

    it("astir doctor carries the Alerts tip under its own label", async () => {
      const out = await new Promise<string>((resolve, reject) => {
        execFile(
          process.execPath,
          asDarwin(["doctor", "--port", new URL(base).port]),
          { cwd: root, env: darwin, encoding: "utf8", timeout: 30_000 },
          (err, stdout) => (err ? reject(err) : resolve(stdout)),
        );
      });
      expect(out).toMatch(/^ {2}alert style {5}Set terminal-notifier's notification style to Alerts/m);
    });
  });

  // Last: every test above assumes the file still says insistent.
  it("re-reads an edited file while it runs, and says so with the value it refused", async () => {
    writeFileSync(path, JSON.stringify({ notify: { reminders: "loud" } }));
    const line = `reminders: calm (${path}) — "loud" is not a schedule`;
    // Stat at most every 5 s, announced on the next 1 s tick.
    await until(() => stdout.includes(line), 15_000);
    expect(stdout).toContain(line);
    const body = (await (await fetch(`${base}/healthz`)).json()) as { reminders?: unknown };
    expect(body.reminders).toEqual({ schedule: "calm", source: "config", fellBack: true });
  }, 30_000);
});
