/**
 * #78 / PSH-07 — a delivery path says whether it can deliver, and nothing
 * reports a dead one as working.
 *
 * Measured on the megabrain container, where development happens over SSH and
 * tmux: no `notify-send`, no `DISPLAY`, no session bus. The daemon printed
 * `delivery paths: local`, the local target answered `{ ok: true }` to every
 * doorbell, and the ENOENT from spawning a binary that is not there was
 * swallowed by a fire-and-forget callback. When the `ssh -R` tunnel to the Mac
 * dropped — the log shows it doing so — the only path left was the dead one,
 * and astir counted every block as delivered.
 */

import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { daemonDeliveryLive, describeDelivery } from "../src/config/plugin.js";
import { CONTRACT_VERSION } from "../src/contract/event.js";
import { Daemon } from "../src/daemon/server.js";
import { Registry } from "../src/model/registry.js";
import { detectNotifier } from "../src/notify/detect.js";
import { Dispatcher, localTarget, REMOTE_TIMEOUT_MS, remoteTarget } from "../src/notify/dispatch.js";
import { buildEnvelope } from "../src/notify/envelope.js";
import { NotifyLoop } from "../src/notify/loop.js";
import {
  backendFromNotifier,
  childRunner,
  createNotifierBackend,
  NOTIFIER_TIMEOUT_MS,
  type NotifierBackend,
  type NotifyOutcome,
} from "../src/notify/notify.js";
import { NotifyPolicy } from "../src/notify/policy.js";
import { NotifierServer } from "../src/notify/server.js";

const blocked = buildEnvelope({
  kind: "blocked",
  reason: "permission_prompt",
  sessionId: "s1",
  agentId: "a1",
  cwd: "/repo",
});
const resolved = buildEnvelope({
  kind: "resolved",
  reason: "permission_prompt",
  sessionId: "s1",
  agentId: "a1",
  cwd: "/repo",
});

/** A file system holding exactly these paths, so no test depends on the machine. */
const only =
  (...paths: string[]) =>
  (p: string): boolean =>
    paths.includes(p);

function linux(env: Record<string, string | undefined>, exists: (p: string) => boolean) {
  const ran: Array<{ cmd: string; args: string[] }> = [];
  const backend = createNotifierBackend({
    platform: "linux",
    env,
    exists,
    run: (cmd, args) => {
      ran.push({ cmd, args });
      return Promise.resolve({ ok: true });
    },
  });
  return { backend, ran };
}

/** A runner for backends whose spawn nothing here looks at. */
const shown = (): Promise<NotifyOutcome> => Promise.resolve({ ok: true });

describe("the Linux backend checks what it needs instead of assuming it", () => {
  it("is dead when notify-send is not installed — the megabrain case", () => {
    const { backend } = linux({ DISPLAY: ":0", PATH: "/usr/bin" }, only());
    expect(backend.available).toBe(false);
    expect(backend.unavailableReason).toBe("notify-send not found");
  });

  it("is dead when there is nothing to show a notification on", () => {
    // Installed, but over SSH with no desktop: the binary runs and nothing appears.
    const { backend } = linux({ PATH: "/usr/bin" }, only("/usr/bin/notify-send"));
    expect(backend.available).toBe(false);
    expect(backend.unavailableReason).toBe("no session bus or display");
  });

  it("names the missing binary first, since it is the first thing to fix", () => {
    const { backend } = linux({ PATH: "/usr/bin" }, only());
    expect(backend.unavailableReason).toBe("notify-send not found");
  });

  it.each([
    ["DISPLAY", ":0"],
    ["WAYLAND_DISPLAY", "wayland-0"],
    ["DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"],
  ])("is live with notify-send and %s", (key, value) => {
    // The first gate only. A bus address alone is what pam_systemd exports on
    // a headless host too; the run's exit status is the second gate — see
    // "the local path learns from what its notifier did".
    const { backend } = linux({ [key]: value, PATH: "/usr/bin" }, only("/usr/bin/notify-send"));
    expect(backend.available).toBe(true);
    expect(backend.unavailableReason).toBeUndefined();
  });

  it("treats an empty variable as unset", () => {
    // `DISPLAY=` exported empty is what a stripped environment often carries.
    const { backend } = linux({ DISPLAY: "", PATH: "/usr/bin" }, only("/usr/bin/notify-send"));
    expect(backend.available).toBe(false);
  });

  it("finds notify-send on PATH, not only in the usual directories", () => {
    // NixOS and friends install it nowhere the fixed list looks.
    const { backend } = linux(
      { DISPLAY: ":0", PATH: "/run/current-system/sw/bin" },
      only("/run/current-system/sw/bin/notify-send"),
    );
    expect(backend.available).toBe(true);
  });

  it("runs the binary it found, not whatever a bare name resolves to later", () => {
    const { backend, ran } = linux({ DISPLAY: ":0", PATH: "/opt/x/bin" }, only("/opt/x/bin/notify-send"));
    backend.notify({ title: "t", body: "b" });
    expect(ran[0]?.cmd).toBe("/opt/x/bin/notify-send");
  });

  it("never spawns anything when it is dead, and answers failure", async () => {
    const { backend, ran } = linux({}, only());
    // `astir notifier` calls this directly: silence here was a delivery.
    expect(await backend.notify({ title: "t", body: "b" })).toEqual({
      ok: false,
      reason: "notify-send not found",
    });
    expect(ran).toEqual([]);
  });

  it("never spawns the binary it found when there is no desktop to show it on", () => {
    // The backend's own guard, not only the local target's: `astir notifier`
    // calls `notify` directly, and a spawn whose failure is swallowed is the
    // lie #78 is about.
    const { backend, ran } = linux({ PATH: "/usr/bin" }, only("/usr/bin/notify-send"));
    backend.notify({ title: "t", body: "b" });
    expect(ran).toEqual([]);
  });
});

describe("other platforms keep what works today", () => {
  it("macOS with terminal-notifier is live", () => {
    const b = createNotifierBackend({
      platform: "darwin",
      env: {},
      exists: only("/opt/homebrew/bin/terminal-notifier"),
      run: shown,
    });
    expect(b.name).toBe("terminal-notifier");
    expect(b.available).toBe(true);
  });

  it("macOS without it falls back to osascript, which ships with the OS — still live", () => {
    // The user's Mac receives astir's notifications today. Nothing in #78 may
    // turn that into a reported failure.
    const b = createNotifierBackend({ platform: "darwin", env: {}, exists: only(), run: shown });
    expect(b.name).toBe("osascript");
    expect(b.available).toBe(true);
  });

  it("Windows is unchanged", () => {
    const b = createNotifierBackend({ platform: "win32", env: {}, exists: only(), run: shown });
    expect(b.available).toBe(true);
  });

  it("WSL is unchanged, even with no Linux desktop", () => {
    const b = createNotifierBackend({
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      exists: only(),
      run: shown,
    });
    expect(b.name).toBe("burnt-toast");
    expect(b.available).toBe(true);
  });

  it("a platform with no notifier says so", () => {
    const b = createNotifierBackend({ platform: "aix", env: {}, exists: only(), run: shown });
    expect(b.available).toBe(false);
    expect(b.unavailableReason).toBe("no notifier on this platform");
  });

  it("and answers failure if asked anyway, rather than a delivery it never made", async () => {
    // Unreachable today — the local target and `astir notifier` both stop at
    // `available` — but a backend's answer is its own contract, not its
    // callers' gate.
    const b = createNotifierBackend({ platform: "aix", env: {}, exists: only(), run: shown });
    expect(await b.notify({ title: "t", body: "b" })).toEqual({
      ok: false,
      reason: "no notifier on this platform",
    });
  });

  it("a wrapped function is assumed to work, as callers that pass one mean", () => {
    expect(backendFromNotifier(() => undefined).available).toBe(true);
  });
});

function dead(reason = "notify-send not found"): NotifierBackend & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "notify-send",
    available: false,
    unavailableReason: reason,
    capabilities: { click: false, replace: false, remove: false },
    notify: () => {
      calls.push("notify");
      return Promise.resolve({ ok: true });
    },
    remove: () => {
      calls.push("remove");
    },
    calls,
  };
}

describe("a dead local target reports failure, never success", () => {
  it("is not live", () => {
    expect(localTarget(dead()).live()).toBe(false);
    expect(localTarget(backendFromNotifier(() => undefined)).live()).toBe(true);
  });

  it("answers a doorbell with ok:false and the reason", async () => {
    const backend = dead();
    const r = await localTarget(backend).deliver(blocked);
    expect(r).toEqual({ ok: false, reason: "notify-send not found" });
    expect(backend.calls, "and does not try anyway").toEqual([]);
  });

  it("answers a resolution the same way — there is no banner to remove", async () => {
    const backend = dead();
    const r = await localTarget(backend).deliver(resolved);
    expect(r.ok).toBe(false);
    expect(backend.calls).toEqual([]);
  });

  it("carries its reason so the startup line and doctor can say why", () => {
    expect(localTarget(dead("no session bus or display")).unavailableReason).toBe(
      "no session bus or display",
    );
    expect(localTarget(backendFromNotifier(() => undefined)).unavailableReason).toBeUndefined();
  });

  it("a notifier is presumed live when attached, before anything has been sent", () => {
    // The probe that attaches a detected one has just reached it.
    expect(remoteTarget("http://127.0.0.1:1/notify", "t").live()).toBe(true);
  });
});

describe("a notifier that refuses or cannot be reached stops counting as live", () => {
  /**
   * Being attached is not being reachable. A daemon given `--notify-url` never
   * probes, so a dead tunnel stayed attached — and live — forever; a notifier
   * holding another token answers the probe (which needs none) and refuses
   * every doorbell. Both reported a path that delivered nothing.
   */
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  async function notifier(status: () => number): Promise<string> {
    server = createServer((req, res) => {
      req.resume();
      res.writeHead(status(), { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/notify`;
  }

  it("is not live after a 401, and says why", async () => {
    let code = 401;
    const url = await notifier(() => code);
    const remote = remoteTarget(url, "wrong-token", 2_000);
    const d = new Dispatcher([localTarget(dead()), remote]);
    await d.send(blocked);
    expect(d.live(), "nothing can reach anyone").toEqual([]);
    expect(remote.unavailableReason).toBe("unauthorized — token mismatch");
    expect(d.describe()).toBe(
      `none live (local: notify-send not found; ${remote.name}: unauthorized — token mismatch)`,
    );

    // And live again the moment a doorbell gets through.
    code = 200;
    await d.send(resolved);
    expect(d.live()).toEqual([remote.name]);
    expect(remote.unavailableReason).toBeUndefined();
  });

  it("is not live once a delivery finds nothing listening", async () => {
    // The `--notify-url` case: the tunnel is gone and nothing will detach it.
    const url = await notifier(() => 200);
    await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
    const remote = remoteTarget(url, "t", 2_000);
    const d = new Dispatcher([remote]);
    const [outcome] = await d.send(blocked);
    expect(outcome?.ok).toBe(false);
    expect(d.live()).toEqual([]);
    expect(remote.unavailableReason).toBe(outcome?.reason);
  });
});

describe("the probe tells a notifier's target what it found", () => {
  /**
   * Two facts, held apart: what the PSH-14 probe last read at `/healthz`, and
   * whether the last POST failed. A successful POST answers the second and
   * never the first — a 200 to a resolution is what made a notifier that
   * refuses every block read as live between blocks.
   */
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  async function notifier(status: () => number): Promise<string> {
    server = createServer((req, res) => {
      req.resume();
      res.writeHead(status(), { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/notify`;
  }

  it.each([
    ["a string", "yes"],
    ["a number", 1],
    ["null", null],
  ])("the probe drops a canShow that is %s rather than guessing what it meant", async (_label, canShow) => {
    // `/healthz` takes no token, so anything on the port can answer it. A
    // truthy non-boolean read as `true` would revive a path; read as
    // `false` it would kill one. Absent is "did not say", which is the truth.
    server = createServer((req, res) => {
      req.resume();
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, role: "notifier", canShow }));
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    expect(await detectNotifier(port)).toEqual({ found: true, url: `http://127.0.0.1:${port}/notify` });
  });

  it("is dead when the probe says the notifier cannot show, and says why", () => {
    const remote = remoteTarget("http://127.0.0.1:47001/notify", "t");
    remote.probed({ canShow: false });
    expect(remote.live()).toBe(false);
    expect(remote.unavailableReason).toBe("the notifier cannot show notifications");
  });

  it("a successful POST does not overrule a probe that said it cannot show", async () => {
    const url = await notifier(() => 200);
    const remote = remoteTarget(url, "t", 2_000);
    remote.probed({ canShow: false });
    expect((await remote.deliver(resolved)).ok).toBe(true);
    expect(remote.live()).toBe(false);
    remote.probed({ canShow: true });
    expect(remote.live()).toBe(true);
  });

  it("reachability clears a failure that was only about reaching it", async () => {
    const url = await notifier(() => 200);
    await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
    const remote = remoteTarget(url, "t", 2_000);
    expect((await remote.deliver(blocked)).ok).toBe(false);
    expect(remote.live()).toBe(false);
    remote.probed({ canShow: true });
    expect(remote.live()).toBe(true);
    expect(remote.unavailableReason).toBeUndefined();
  });

  it("an older notifier that does not say is read as before — reachable, not unable", async () => {
    const url = await notifier(() => 200);
    await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
    const remote = remoteTarget(url, "t", 2_000);
    await remote.deliver(blocked);
    remote.probed({});
    expect(remote.live()).toBe(true);
  });

  it("does not clear a refused token — /healthz needs none, so reaching it proves nothing", async () => {
    const url = await notifier(() => 401);
    const remote = remoteTarget(url, "wrong", 2_000);
    await remote.deliver(blocked);
    remote.probed({ canShow: true });
    expect(remote.live()).toBe(false);
    expect(remote.unavailableReason).toBe("unauthorized — token mismatch");
  });

  it("clears a 503 only when the notifier says it can show now", async () => {
    const url = await notifier(() => 503);
    const remote = remoteTarget(url, "t", 2_000);
    await remote.deliver(blocked);
    remote.probed({});
    expect(remote.live(), "a notifier too old to say has not disproved its refusal").toBe(false);
    remote.probed({ canShow: true });
    expect(remote.live()).toBe(true);
  });
});

describe("the local path learns from what its notifier did", () => {
  /**
   * The headless systemd host: `notify-send` installed, the session bus
   * exported to every SSH shell and user service by pam_systemd, and nothing
   * on that bus owning org.freedesktop.Notifications. The static gate passes;
   * every run exits 1 with nothing on screen. Measured by the review with the
   * real Ubuntu 24.04 binary and a private bus.
   */
  const bus = { PATH: "/usr/bin", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };
  function host(outcomes: NotifyOutcome[]) {
    const ran: string[] = [];
    const backend = createNotifierBackend({
      platform: "linux",
      env: bus,
      exists: only("/usr/bin/notify-send"),
      run: (cmd) => {
        ran.push(cmd);
        return Promise.resolve(outcomes.shift() ?? { ok: true });
      },
    });
    return { backend, ran };
  }
  const exit1: NotifyOutcome = { ok: false, reason: "notify-send failed (exit 1)" };

  it("a failed run is a failed delivery, with its reason", async () => {
    const { backend } = host([exit1]);
    expect(backend.available, "the static gate still passes").toBe(true);
    expect(await localTarget(backend).deliver(blocked)).toEqual({
      ok: false,
      reason: "notify-send failed (exit 1)",
    });
  });

  it("is not live after one, and says why", async () => {
    const { backend } = host([exit1]);
    const d = new Dispatcher([localTarget(backend)]);
    expect(d.live()).toEqual(["local"]);
    await d.send(blocked);
    expect(d.live()).toEqual([]);
    expect(d.describe()).toBe("none live (local: notify-send failed (exit 1))");
  });

  it("is live again once a later delivery succeeds", async () => {
    const { backend } = host([exit1, { ok: true }]);
    const target = localTarget(backend);
    await target.deliver(blocked);
    expect(target.live()).toBe(false);
    // Still tried: a dead verdict that stopped trying could never be lifted.
    expect((await target.deliver(blocked)).ok).toBe(true);
    expect(target.live()).toBe(true);
    expect(target.unavailableReason).toBeUndefined();
  });

  it("a withdrawal neither kills nor revives it — it shows nothing either way", async () => {
    const { backend } = host([exit1]);
    const target = localTarget(backend);
    await target.deliver(blocked);
    await target.deliver(resolved);
    expect(target.live(), "a dead path is not revived").toBe(false);

    const healthy = localTarget(host([]).backend);
    expect((await healthy.deliver(resolved)).ok).toBe(true);
    expect(healthy.live(), "and a live one is not killed").toBe(true);
    expect(healthy.unavailableReason).toBeUndefined();
  });

  it("a backend that throws is a failure too", async () => {
    const target = localTarget({
      ...backendFromNotifier(() => undefined),
      notify: () => {
        throw new Error("spawn EAGAIN");
      },
    });
    expect((await target.deliver(blocked)).ok).toBe(false);
    expect(target.live()).toBe(false);
  });

  it("names the backend, never the error, when one throws — the reason is content-free (SEC-01)", async () => {
    // A spawn's error message is the command line it ran, title and body
    // included, and this reason reaches the startup line and doctor.
    const target = localTarget({
      ...backendFromNotifier(() => undefined),
      notify: () => {
        throw new Error("Command failed: notify-send An agent needs you secret-project");
      },
    });
    expect(await target.deliver(blocked)).toEqual({ ok: false, reason: "custom failed to run" });
    expect(target.unavailableReason).toBe("custom failed to run");
  });

  it.each([
    [
      "terminal-notifier",
      { platform: "darwin" as const, exists: only("/opt/homebrew/bin/terminal-notifier") },
    ],
    ["osascript", { platform: "darwin" as const, exists: only() }],
    ["burnt-toast", { platform: "win32" as const, exists: only() }],
    ["notify-send", { platform: "linux" as const, exists: only("/usr/bin/notify-send"), env: bus }],
  ])("every backend answers with what its run did — %s", async (name, probe) => {
    const backend = createNotifierBackend({
      env: {},
      ...probe,
      run: () => Promise.resolve({ ok: false, reason: `${name} failed (exit 2)` }),
    });
    expect(backend.name).toBe(name);
    expect(await backend.notify({ title: "t", body: "b" })).toEqual({
      ok: false,
      reason: `${name} failed (exit 2)`,
    });
  });

  it("the loop says NO PATH DELIVERED when the only path's notifier failed", async () => {
    let t = 0;
    const registry = new Registry({ nowMs: () => t });
    const lines: string[] = [];
    const loop = new NotifyLoop({
      registry,
      policy: new NotifyPolicy(),
      dispatcher: new Dispatcher([localTarget(host([exit1]).backend)]),
      now: () => t,
      dwellMs: () => 0,
      onDelivered: (l) => lines.push(l),
    });
    registry.apply(
      {
        v: CONTRACT_VERSION,
        eventId: "e1",
        provider: "claude",
        sessionId: "s1",
        ts: 1,
        kind: "notification",
        agentId: "s1",
        agentType: null,
        parentAgentId: null,
        parentSource: null,
        tool: null,
        description: null,
        paths: [],
        op: null,
        ok: null,
        notificationKind: "permission_prompt",
      },
      "/repo",
    );
    t += 1;
    await loop.pulse();
    expect(lines[0]).toContain("NO PATH DELIVERED");
  });
});

describe("the default runner watches the child it spawns", () => {
  // Node stands in for the notifier: these test how an exit, a spawn error
  // and a hang are read, and must never put a notification on anyone's screen.
  const node = basename(process.execPath);

  it("an exit of 0 is a delivery", async () => {
    expect(await childRunner()(process.execPath, ["-e", "process.exit(0)"])).toEqual({ ok: true });
  });

  it("a non-zero exit is not, and says which binary and which code", async () => {
    expect(await childRunner()(process.execPath, ["-e", "process.exit(3)"])).toEqual({
      ok: false,
      reason: `${node} failed (exit 3)`,
    });
  });

  it("a binary that cannot be started is not", async () => {
    const r = await childRunner()("/nonexistent/astir-test/notify-send", []);
    expect(r).toEqual({ ok: false, reason: "notify-send could not start (ENOENT)" });
  });

  it("a spawn that throws before starting is not — answered, never rejected", async () => {
    // A NUL in an argument throws from `spawn` itself and never reaches the
    // child's `error` event. Callers catch a rejection, but with the error's
    // text — which for a spawn is the command line — so the runner answers.
    const r = await childRunner()(process.execPath, ["-e", "process.exit(0)", "a\u0000b"]);
    expect(r).toEqual({ ok: false, reason: `${node} could not start (ERR_INVALID_ARG_VALUE)` });
  });

  it.skipIf(process.platform === "win32")("a child killed by a signal is not a delivery", async () => {
    // Exit code null: an OOM kill, a session teardown, a SIGTERM from outside.
    // Whatever it was doing, it did not finish showing anything.
    expect(await childRunner()(process.execPath, ["-e", 'process.kill(process.pid, "SIGTERM")'])).toEqual({
      ok: false,
      reason: `${node} was killed (SIGTERM)`,
    });
  });

  it("gives up on a child no later than a daemon gives up on the notifier running it", () => {
    // `astir notifier` answers its sender only once its child settles. Waiting
    // longer than the sender does turns a wedged notify-send into "could not
    // reach it" at the daemon, which the next probe — reaching a `/healthz`
    // that still says it can show — clears, and the path reads live while
    // nothing can appear.
    expect(NOTIFIER_TIMEOUT_MS).toBeLessThanOrEqual(REMOTE_TIMEOUT_MS);
  });

  it("a child that does not exit in time is not, and is killed rather than left behind", async () => {
    // One wedged notify-send per doorbell, every minute, behind a bus that
    // never answers, is a process leak. The child writes its pid so the test
    // can see it gone.
    const dir = mkdtempSync(join(tmpdir(), "astir-runner-"));
    try {
      const pidFile = join(dir, "pid");
      const started = Date.now();
      const r = await childRunner(2_000)(process.execPath, [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ]);
      expect(r).toEqual({ ok: false, reason: `${node} did not exit within 2 s` });
      expect(Date.now() - started).toBeLessThan(5_000);

      const pid = Number(readFileSync(pidFile, "utf8"));
      const alive = (): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 40 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(alive(), "the hung child was killed").toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never repeats what it was asked to show — the reason is content-free (SEC-01)", async () => {
    const r = await childRunner()(process.execPath, [
      "-e",
      "process.exit(1)",
      "An agent needs you",
      "secret-project needs permission",
    ]);
    expect(r.ok).toBe(false);
    const reason = r.ok ? "" : r.reason;
    expect(reason).not.toContain("secret-project");
    expect(reason).not.toContain("An agent");
    expect(reason).not.toContain("process.exit");
  });
});

describe("the dispatcher separates configured from live", () => {
  const remote = remoteTarget("http://127.0.0.1:47001/notify", "t", 200);

  it("lists only live paths", () => {
    const d = new Dispatcher([localTarget(dead()), remote]);
    expect(d.names()).toEqual(["local", "remote(http://127.0.0.1:47001/notify)"]);
    expect(d.live()).toEqual(["remote(http://127.0.0.1:47001/notify)"]);
  });

  it("follows a notifier coming and going", () => {
    const d = new Dispatcher([localTarget(dead())]);
    expect(d.live()).toEqual([]);
    d.add(remote);
    expect(d.live()).toEqual([remote.name]);
    d.remove(remote.name);
    expect(d.live(), "the issue's case: tunnel dropped, floor dead").toEqual([]);
  });

  it("describes a healthy setup as before", () => {
    expect(new Dispatcher([localTarget(backendFromNotifier(() => undefined))]).describe()).toBe("local");
  });

  it("names a dead path and why, instead of listing it", () => {
    expect(new Dispatcher([localTarget(dead())]).describe()).toBe("none live (local: notify-send not found)");
  });

  it("lists what is live and still names what is not", () => {
    expect(new Dispatcher([localTarget(dead()), remote]).describe()).toBe(
      "remote(http://127.0.0.1:47001/notify) (local: notify-send not found)",
    );
  });

  it("says why a dead path has not been tried, rather than 'not yet attempted'", () => {
    const d = new Dispatcher([localTarget(dead())]);
    expect(d.status()[0]).toMatchObject({ target: "local", ok: false, reason: "notify-send not found" });
  });

  it("records the dead path's failure once it is tried", async () => {
    const d = new Dispatcher([localTarget(dead())]);
    const [outcome] = await d.send(blocked);
    expect(outcome).toMatchObject({ target: "local", ok: false, reason: "notify-send not found" });
  });
});

describe("the notify loop no longer counts a dead floor as delivered", () => {
  it("says NO PATH DELIVERED when the only path is dead", async () => {
    let t = 0;
    const registry = new Registry({ nowMs: () => t });
    const lines: string[] = [];
    const loop = new NotifyLoop({
      registry,
      policy: new NotifyPolicy(),
      dispatcher: new Dispatcher([localTarget(dead())]),
      now: () => t,
      dwellMs: () => 0,
      onDelivered: (l) => lines.push(l),
    });
    registry.apply(
      {
        v: CONTRACT_VERSION,
        eventId: "e1",
        provider: "claude",
        sessionId: "s1",
        ts: 1,
        kind: "notification",
        agentId: "s1",
        agentType: null,
        parentAgentId: null,
        parentSource: null,
        tool: null,
        description: null,
        paths: [],
        op: null,
        ok: null,
        notificationKind: "permission_prompt",
      },
      "/repo",
    );
    t += 1;
    await loop.pulse();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("NO PATH DELIVERED");
  });
});

describe("/healthz says which paths are live", () => {
  let daemon: Daemon | undefined;
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  const start = async (opts: { deliveryLive?: () => string[] }) => {
    daemon = new Daemon({ token: "t".repeat(48), registry: new Registry({ nowMs: () => 0 }), ...opts });
    const port = await daemon.listen(0);
    // Unauthenticated, like the rest of /healthz: a surface must be able to
    // ask "can anything notify me" before it holds a token.
    return async () =>
      (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as {
        delivery?: { live?: unknown };
      };
  };

  it("reports the live names, read at request time", async () => {
    let live = ["local"];
    const healthz = await start({ deliveryLive: () => live });
    expect((await healthz()).delivery).toEqual({ live: ["local"] });
    // The tunnel dropped: the next answer must say so, not the startup one.
    live = [];
    expect((await healthz()).delivery).toEqual({ live: [] });
  });

  it("carries names only — no reasons, no counts, nothing about sessions", async () => {
    const healthz = await start({ deliveryLive: () => ["local"] });
    expect(Object.keys((await healthz()).delivery ?? {})).toEqual(["live"]);
  });

  it("says nothing is live when nothing was wired, rather than implying a path", async () => {
    const healthz = await start({});
    expect((await healthz()).delivery).toEqual({ live: [] });
  });
});

describe("doctor names a dead local path and why", () => {
  const text = (lines: string[]) => lines.join("\n");
  const live = { name: "notify-send", available: true };
  const deadLocal = { name: "notify-send", available: false, unavailableReason: "notify-send not found" };

  it("says the local path is live when it is", () => {
    const out = text(describeDelivery(live, ["local"]));
    expect(out).toContain("notify-send");
    expect(out).toContain("live");
    expect(out).not.toMatch(/dead/i);
  });

  it("names the dead path and the reason", () => {
    const out = text(describeDelivery(deadLocal, null));
    expect(out).toMatch(/dead/i);
    expect(out).toContain("notify-send not found");
    // Nobody asked the daemon, so nothing is known about who will be told.
    expect(out).not.toContain("no one will be told");
    expect(out).not.toContain("reaching you through");
  });

  it.each([[["local"]], [["local", "remote(http://127.0.0.1:47001/notify)"]]])(
    "believes the daemon over this terminal when the daemon can deliver locally (%j)",
    (daemonLive) => {
      // Doctor over SSH into a desktop box, or under `env -i`: this terminal has
      // no display, the daemon does. Printing DEAD and "no one will be told"
      // here contradicted the witness that actually delivers.
      const out = text(describeDelivery(deadLocal, daemonLive));
      expect(out).toContain("live");
      expect(out).toContain("daemon");
      expect(out).not.toMatch(/dead/i);
      expect(out).not.toContain("no one will be told");
      // What this terminal lacks is still worth a line: it explains a test
      // notification that never appears from here.
      expect(out).toContain("notify-send not found");
    },
  );

  it("says no one will be told when the daemon has nothing live", () => {
    const out = text(describeDelivery(deadLocal, []));
    expect(out).toContain("no one will be told");
  });

  it("names the path that IS reaching you when the floor is dead", () => {
    const out = text(describeDelivery(deadLocal, ["remote(http://127.0.0.1:47001/notify)"]));
    expect(out).toContain("remote(http://127.0.0.1:47001/notify)");
    expect(out).not.toContain("no one will be told");
  });

  it("catches a daemon whose environment cannot show one even though this terminal can", () => {
    // Doctor probes from the terminal it runs in; a supervised daemon can lack
    // the session bus that terminal has. The daemon's own answer wins.
    const out = text(describeDelivery(live, []));
    expect(out).toMatch(/dead/i);
    expect(out).toContain("daemon");
  });

  it("does not blame the daemon's environment for a notifier that fails in both", () => {
    // The headless systemd host: notify-send installed and a bus exported in
    // this terminal AND in the daemon, and nothing on that bus to show one, so
    // every run exits 1. The static check passes here, the daemon's runs
    // fail, and this branch cannot tell that from a daemon started without
    // this terminal's bus. Round two said it "works here" and that the daemon
    // "was started without" that bus — false on this host, and a restart
    // fixes nothing — while `--notify`, a few lines down, printed
    // `local FAILED — notify-send failed (exit 1)`.
    const out = text(describeDelivery(live, []));
    expect(out).toMatch(/dead in the daemon/i);
    expect(out).not.toContain("works here");
    expect(out).not.toContain("it was started without");
    // Both causes named, and the test send that tells them apart.
    expect(out).toContain("display or session bus");
    expect(out).toContain("astir doctor --notify");
    expect(out).toContain("no one will be told");
  });

  it("does not grade what it could not ask the daemon", () => {
    const out = text(describeDelivery(live, null));
    expect(out).not.toMatch(/dead/i);
  });
});

describe("doctor reads the daemon's answer without inventing one", () => {
  it("takes the live list from /healthz", () => {
    expect(daemonDeliveryLive({ delivery: { live: ["local", "remote(x)"] } })).toEqual([
      "local",
      "remote(x)",
    ]);
  });

  it("keeps an empty list empty — that IS the answer 'nothing'", () => {
    expect(daemonDeliveryLive({ delivery: { live: [] } })).toEqual([]);
  });

  it.each([
    ["a daemon older than #78", { ok: true, counters: {} }],
    ["a delivery with no list", { delivery: {} }],
    ["a list that is not a list", { delivery: { live: "local" } }],
    ["a delivery that is not an object", { delivery: null }],
    ["a body that is not an object", "ok"],
    ["no body", null],
  ])("is null — cannot tell, not nothing — for %s", (_label, body) => {
    // Read as [], an older daemon would be reported as "no one will be told".
    expect(daemonDeliveryLive(body)).toBeNull();
  });

  it("drops entries that are not names", () => {
    expect(daemonDeliveryLive({ delivery: { live: ["local", 3, null] } })).toEqual(["local"]);
  });
});

/**
 * The wiring in `cli/main.ts`, which no unit test above can reach: the startup
 * line, `/healthz.delivery` and `doctor --notify` each had a correct helper
 * and one call site that could quietly go back to the lie — `names()`, no
 * `deliveryLive`, a wrapped `createNotifier()`. Built to a throwaway directory
 * rather than `dist/`, which the running daemon and the artifact test share.
 *
 * The environment is scrubbed of every display and bus variable, and HOME is
 * a temp directory, so the local path is whatever this platform gives a
 * process with no desktop — computed the same way below rather than assumed.
 * A dead `--notify-url` stands in for the notifier, so the daemon never probes
 * for (or delivers to) a real one.
 */
describe.skipIf(process.platform === "win32")("the built daemon and doctor say what can deliver", () => {
  const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
  const TOKEN = "delivery-live-test-token";
  const scrubbed = { PATH: "/usr/bin:/bin", ASTIR_NO_PERSIST: "1" };
  // What this platform can do for a process with no desktop. HOME is a fresh,
  // empty directory, so leaving it out here changes nothing it could find.
  const local = createNotifierBackend({ env: scrubbed });
  let root = "";
  let entry = "";
  let env: Record<string, string> = {};
  let proc: ChildProcess | undefined;
  let port = 0;
  let line = "";
  let notifyUrl = "";

  beforeAll(async () => {
    // Made here, not at collection, so a skipped run leaves nothing behind.
    root = mkdtempSync(join(tmpdir(), "astir-78-"));
    entry = join(root, "dist", "cli", "main.js");
    env = { ...scrubbed, HOME: join(root, "home") };
    mkdirSync(env.HOME as string, { recursive: true });
    const tsc = join(REPO, "node_modules", "typescript", "bin", "tsc");
    execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json", "--outDir", join(root, "dist")], {
      cwd: REPO,
      stdio: "pipe",
    });
    // ESM and a version, as the repo's own package.json gives `dist/`.
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string };
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", version: pkg.version }));

    // A port with nothing on it: the tunnel that went away.
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
    notifyUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}/notify`;
    await new Promise<void>((r) => closed.close(() => r()));

    proc = spawn(
      process.execPath,
      [entry, "daemon", "--port", "0", "--token", TOKEN, "--notify-url", notifyUrl, "--notify-token", "t"],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"], env },
    );
    await new Promise<void>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error(`no delivery line; stdout=${buf}`)), 15_000);
      proc?.stdout?.on("data", (c: Buffer) => {
        buf += c.toString();
        const p = /listening on 127\.0\.0\.1:(\d+)/.exec(buf);
        const d = /^delivery paths: (.*)\n/m.exec(buf);
        if (p?.[1] && d?.[1] !== undefined) {
          clearTimeout(timer);
          port = Number(p[1]);
          line = d[1];
          resolve();
        }
      });
      proc?.on("exit", (code) => reject(new Error(`daemon exited early (code ${code}); stdout=${buf}`)));
    });
  }, 60_000);

  afterAll(() => {
    proc?.kill("SIGTERM");
    if (root !== "") rmSync(root, { recursive: true, force: true });
  });

  const remote = () => `remote(${notifyUrl})`;

  it("prints what is live on the startup line, and names what is not", () => {
    expect(line).toBe(
      local.available ? `local, ${remote()}` : `${remote()} (local: ${local.unavailableReason})`,
    );
  });

  it("serves the same answer from /healthz", async () => {
    const body = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as {
      delivery?: { live?: unknown };
    };
    expect(body.delivery?.live).toEqual(local.available ? ["local", remote()] : [remote()]);
  });

  // Only where nothing can appear: on a desktop this would put a real
  // notification in front of whoever is running the suite.
  it.skipIf(local.available)(
    "doctor names the dead floor, what IS live, and fails the test send",
    () => {
      const out = execFileSync(process.execPath, [entry, "doctor", "--notify", "--port", String(port)], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(out).toContain(`DEAD — ${local.unavailableReason}`);
      expect(out).toContain(`reaching you through: ${remote()}`);
      expect(out).toMatch(new RegExp(`local\\s+FAILED — ${local.unavailableReason}`));
      expect(out).not.toMatch(/local\s+sent/);
    },
    40_000,
  );

  it("doctor does not read a daemon older than #78 as 'nothing is live'", async () => {
    // It answers /healthz as itself and says nothing about delivery. "Cannot
    // tell" must not become "no one will be told" about a daemon that may be
    // delivering perfectly well.
    const old = createServer((req, res) => {
      req.resume();
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, role: "daemon", host: hostname(), startedAt: Date.now() }));
      } else {
        res.writeHead(401).end();
      }
    });
    await new Promise<void>((r) => old.listen(0, "127.0.0.1", () => r()));
    try {
      const oldPort = (old.address() as AddressInfo).port;
      // Async: a synchronous spawn would block the event loop serving it.
      const out = await new Promise<string>((resolve, reject) => {
        execFile(
          process.execPath,
          [entry, "doctor", "--port", String(oldPort)],
          { cwd: root, env, encoding: "utf8", timeout: 30_000 },
          (err, stdout) => (err ? reject(err) : resolve(stdout)),
        );
      });
      expect(out).toContain("local alerts");
      expect(out).not.toContain("no one will be told");
      expect(out).not.toContain("DEAD in the daemon");
    } finally {
      await new Promise<void>((r) => old.close(() => r()));
    }
  }, 40_000);

  /** Run `astir <args>` from the build above; resolves once its stdout matches `ready`. */
  async function launch(args: string[], childEnv: Record<string, string>, ready: RegExp) {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    let out = "";
    const match = await new Promise<RegExpExecArray>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${args[0]} never said ${ready}; stdout=${out}`)),
        15_000,
      );
      child.stdout?.on("data", (c: Buffer) => {
        out += c.toString();
        const m = ready.exec(out);
        if (m !== null) {
          clearTimeout(timer);
          resolve(m);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`${args[0]} exited early (code ${code}); stdout=${out}`));
      });
    });
    return { child, match, out: () => out };
  }

  /** Read until `done` holds or `ms` runs out, and hand back the last reading to assert on. */
  async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms: number): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = await read();
      if (done(v) || Date.now() > deadline) return v;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /**
   * `runDaemon`'s PSH-14 probe, which only the built daemon runs: what the
   * roster push and `/state` read follow, and what a probe that finds the
   * notifier already attached does with it. Round one did nothing at all
   * there, so a notifier that came back able to show stayed dead.
   *
   * Two probes are needed and the interval is the daemon's own 15 s, so this
   * one is slow on purpose. An in-process notifier stands in, with a
   * do-nothing `notify`: nothing here can reach a screen.
   */
  it("the daemon's probe follows the notifier it finds, and revives it once it can show", async () => {
    const notifyToken = "delivery-live-notify-token";
    let notifier = new NotifierServer({
      token: notifyToken,
      notify: () => undefined,
      cannotShow: "no display",
    });
    const notifyPort = await notifier.listen(0);
    let daemon: Awaited<ReturnType<typeof launch>> | undefined;
    try {
      // Another machine's roster, held by the notifier. The daemon shows it
      // in `/state` only if it reads the notifier its probe attached.
      const seeded = await fetch(`http://127.0.0.1:${notifyPort}/roster`, {
        method: "POST",
        headers: { Authorization: `Bearer ${notifyToken}`, "content-type": "application/json" },
        body: JSON.stringify({ host: "astir-78-elsewhere", sessions: [{ sessionId: "far-1", cwd: "/far" }] }),
      });
      expect(seeded.status).toBe(200);

      daemon = await launch(
        [
          "daemon",
          "--port",
          "0",
          "--token",
          TOKEN,
          "--notify-port",
          String(notifyPort),
          "--notify-token",
          notifyToken,
        ],
        env,
        /notifier detected on .*\n/,
      );
      const daemonPort = Number(/listening on 127\.0\.0\.1:(\d+)/.exec(daemon.out())?.[1]);
      const name = `remote(http://127.0.0.1:${notifyPort}/notify)`;
      const live = async () =>
        (
          (await (await fetch(`http://127.0.0.1:${daemonPort}/healthz`)).json()) as {
            delivery?: { live?: string[] };
          }
        ).delivery?.live ?? [];
      const remote = async () =>
        (
          (await (
            await fetch(`http://127.0.0.1:${daemonPort}/state`, {
              headers: { Authorization: `Bearer ${TOKEN}` },
            })
          ).json()) as { remote?: Array<{ sessionId?: string }> }
        ).remote ?? [];

      expect(daemon.out()).toContain(
        `notifier detected on 127.0.0.1:${notifyPort}, but it cannot show notifications`,
      );
      expect(await live(), "attached, and dead from the start").not.toContain(name);

      // The `/state` read follows the attached notifier (it polls every 5 s).
      const far = await until(remote, (r) => r.some((s) => s.sessionId === "far-1"), 10_000);
      expect(far.map((s) => s.sessionId)).toContain("far-1");

      // Restarted from a desktop login, quicker than the probe interval: the
      // probe never sees it gone, so only the "already attached" branch can
      // carry the news.
      await notifier.close();
      notifier = new NotifierServer({ token: notifyToken, notify: () => undefined });
      await notifier.listen(notifyPort);
      expect(await until(live, (l) => l.includes(name), 25_000)).toContain(name);
      expect(daemon.out()).toContain(`notifier on 127.0.0.1:${notifyPort} is live again`);
    } finally {
      daemon?.child.kill("SIGTERM");
      await notifier.close();
    }
  }, 60_000);

  // `astir notifier` hands its backend's answer to the server, so a
  // notify-send that runs and exits 1 is refused to the sender. A fake one on
  // PATH stands in — so Linux only (elsewhere another backend, and a real
  // notification, would answer), and only where no real notify-send sits in a
  // directory searched before PATH, since nothing real may be spawned here.
  const realNotifySend = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].some((d) =>
    existsSync(join(d, "notify-send")),
  );
  const wsl = existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");
  it.skipIf(process.platform !== "linux" || wsl || realNotifySend)(
    "astir notifier refuses a doorbell its notify-send failed to show, and accepts one that shows",
    async () => {
      // The headless systemd host: a bus address exported, the binary there,
      // and every run exiting 1. The address goes nowhere.
      const fake = join(root, "fake-bin");
      const exitCode = join(root, "fake-exit");
      const ran = join(root, "fake-ran");
      mkdirSync(fake, { recursive: true });
      writeFileSync(exitCode, "1");
      writeFileSync(
        join(fake, "notify-send"),
        `#!/bin/sh\necho ran >> '${ran}'\nexit "$(cat '${exitCode}')"\n`,
        {
          mode: 0o755,
        },
      );
      const notifier = await launch(
        ["notifier", "--port", "0", "--token", "nt"],
        {
          ...env,
          PATH: `${fake}:${env.PATH}`,
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/astir-78-bus",
        },
        /notifier listening on 127\.0\.0\.1:(\d+)/,
      );
      try {
        const base = `http://127.0.0.1:${notifier.match[1]}`;
        const post = (body: unknown) =>
          fetch(`${base}/notify`, {
            method: "POST",
            headers: { Authorization: "Bearer nt", "content-type": "application/json" },
            body: JSON.stringify(body),
          });
        const canShow = async () =>
          ((await (await fetch(`${base}/healthz`)).json()) as { canShow?: unknown }).canShow;

        expect(await canShow(), "nothing tried, nothing known").toBe(true);
        expect((await post(blocked)).status).toBe(503);
        expect(readFileSync(ran, "utf8"), "the fake ran, and nothing else").toBe("ran\n");
        expect(await canShow()).toBe(false);

        writeFileSync(exitCode, "0");
        expect((await post({ ...blocked, id: `${blocked.id}-later` })).status).toBe(200);
        expect(await canShow()).toBe(true);
      } finally {
        notifier.child.kill("SIGTERM");
      }
    },
    40_000,
  );
});
