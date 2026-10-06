/**
 * #78, round two — the seams between the pieces that each said the right
 * thing alone.
 *
 * The integration review of aea46e4 found three ways a delivery path read as
 * live while nothing could reach anyone, and every one of them crossed a
 * boundary no unit test did:
 *
 * - a notifier that cannot show refused a doorbell with 503, then accepted the
 *   `resolved` that followed with 200 — and that 200 erased the 503, so the
 *   sending daemon's `/healthz`, the tmux line and `doctor` all went calm
 *   about a path that would refuse the next block;
 * - a notifier restarting inside the 15 s probe interval made one POST fail,
 *   and the probe that found it back did nothing, because "found and already
 *   attached" had no branch — the path stayed dead until a doorbell happened
 *   to get through, which on an idle machine is hours of "nothing can notify
 *   you" while doorbells would arrive fine;
 * - a local `notify-send` that ran, failed and exited 1 counted as delivered,
 *   because the spawn was fire-and-forget. On a headless systemd host the
 *   session bus address is exported to every SSH shell, so the static check
 *   passes and nothing ever appears.
 *
 * Each sequence below wires the real pieces together — the notifier server,
 * the probe, the dispatcher, the loop, the daemon's `/healthz`, the line and
 * doctor's wording — and walks the exact steps the reviewers reproduced.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { daemonDeliveryLive, describeDelivery, describeNotifier } from "../src/config/plugin.js";
import { CONTRACT_VERSION } from "../src/contract/event.js";
import { Daemon } from "../src/daemon/server.js";
import { Registry } from "../src/model/registry.js";
import { detectNotifier } from "../src/notify/detect.js";
import { Dispatcher, localTarget, NotifierWatch, remoteTarget } from "../src/notify/dispatch.js";
import { buildEnvelope } from "../src/notify/envelope.js";
import { NotifyLoop } from "../src/notify/loop.js";
import { createNotifierBackend, type NotifierBackend, type NotifyOutcome } from "../src/notify/notify.js";
import { NotifyPolicy } from "../src/notify/policy.js";
import { NotifierServer } from "../src/notify/server.js";
import { LINE_TEXT, runStatusLine } from "../src/status/line.js";

const DAEMON_TOKEN = "d".repeat(48);
const NOTIFY_TOKEN = "n".repeat(48);

/** The megabrain container's floor: no notify-send, no desktop. */
const headless = (): NotifierBackend =>
  createNotifierBackend({ platform: "linux", env: { PATH: "/usr/bin" }, exists: () => false });

const envelope = (kind: "blocked" | "resolved") =>
  buildEnvelope({ kind, reason: "permission_prompt", sessionId: "s1", agentId: "a1", cwd: "/repo" });

let seq = 0;
function event(kind: string, over: Record<string, unknown> = {}) {
  seq++;
  return {
    v: CONTRACT_VERSION,
    eventId: `seam-${seq}`,
    provider: "claude" as const,
    sessionId: "s1",
    ts: Math.floor(Date.now() / 1000),
    kind,
    agentId: "s1",
    agentType: null,
    parentAgentId: null,
    parentSource: null,
    tool: null,
    description: null,
    paths: [],
    op: null,
    ok: null,
    notificationKind: null,
    ...over,
  } as Parameters<Registry["apply"]>[0];
}

// The line reads its tokens from the environment, as every astir client does.
// Restored after each test so nothing leaks into the rest of the suite.
const saved = { daemon: process.env.ASTIR_TOKEN, notify: process.env.ASTIR_NOTIFY_TOKEN };
beforeEach(() => {
  process.env.ASTIR_TOKEN = DAEMON_TOKEN;
  process.env.ASTIR_NOTIFY_TOKEN = NOTIFY_TOKEN;
});

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const [key, value] of [
    ["ASTIR_TOKEN", saved.daemon],
    ["ASTIR_NOTIFY_TOKEN", saved.notify],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function notifierOn(port: number, opts: Partial<ConstructorParameters<typeof NotifierServer>[0]> = {}) {
  const server = new NotifierServer({ token: NOTIFY_TOKEN, notify: () => undefined, ...opts });
  const bound = await server.listen(port);
  let open = true;
  const close = async (): Promise<void> => {
    if (!open) return;
    open = false;
    await server.close();
  };
  closers.push(close);
  return { server, port: bound, close };
}

/** The daemon's side: its dispatcher behind a real `/healthz`, and what each surface makes of it. */
async function daemonFor(dispatcher: Dispatcher, local: NotifierBackend, notifyPort: number) {
  const registry = new Registry({ nowMs: () => Date.now() });
  const daemon = new Daemon({ token: DAEMON_TOKEN, registry, deliveryLive: () => dispatcher.live() });
  const port = await daemon.listen(0);
  closers.push(() => daemon.close());

  const healthz = async () =>
    (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as { delivery?: { live?: string[] } };
  return {
    registry,
    /** `/healthz.delivery.live` — what the line, astir-tui and doctor all read. */
    live: async () => (await healthz()).delivery?.live,
    /** `astir status --line`, plain: the tmux segment. */
    line: () => runStatusLine({ session: null, json: false, port, notifyPort, timeoutMs: 1_500 }),
    /** What `astir doctor` says about who can reach you. */
    doctor: async () => describeDelivery(local, daemonDeliveryLive(await healthz())).join("\n"),
  };
}

describe("a notifier that cannot show is never read as live", () => {
  it("stays dead through attach → doorbell 503 → resolved, on every surface", async () => {
    // The reviewers' sequence. Both ends headless: the notifier has no
    // notify-send, and neither does the daemon's own floor.
    const local = headless();
    const n = await notifierOn(0, { cannotShow: local.unavailableReason ?? "no notifier" });

    const dispatcher = new Dispatcher([localTarget(local)]);
    const watch = new NotifierWatch(dispatcher, NOTIFY_TOKEN);
    const d = await daemonFor(dispatcher, local, n.port);
    const loop = new NotifyLoop({
      registry: d.registry,
      policy: new NotifyPolicy(),
      dispatcher,
      dwellMs: () => 0,
    });

    // Attach, as the PSH-14 probe does. The notifier says it cannot show, so
    // the path is attached — the roster and the menu still want it — but dead.
    const said = watch.observe(await detectNotifier(n.port));
    expect(watch.url).toBe(`http://127.0.0.1:${n.port}/notify`);
    // And the daemon's log says so, rather than "delivering there too".
    expect(said).toContain("cannot show notifications");
    expect(said).not.toContain("delivering there too");
    expect(said).toContain("delivery paths: none live");
    expect(dispatcher.names()).toContain(`remote(${watch.url})`);
    expect(await d.live(), "dead from the moment it is attached").toEqual([]);

    // A block is announced and refused.
    d.registry.apply(event("session_start"), "/repo");
    d.registry.apply(event("notification", { notificationKind: "permission_prompt" }), "/repo");
    await new Promise((r) => setTimeout(r, 5));
    await loop.pulse();
    expect(n.server.snapshot().rejected).toBeGreaterThan(0);
    expect(await d.live()).toEqual([]);

    // The user answers; the loop sends `resolved`. This is where it used to
    // come back to life.
    d.registry.apply(event("pre_tool"), "/repo");
    await loop.pulse();
    expect(n.server.snapshot().resolved, "the resolution reached the notifier").toBe(1);
    expect(await d.live(), "and did not revive the path").toEqual([]);
    expect(await d.line()).toContain(LINE_TEXT.noDelivery);
    const doctor = await d.doctor();
    expect(doctor).not.toContain("reaching you through");
    expect(doctor).toContain("no one will be told");
  });

  it("stays dead with --notify-url too, where no probe ever runs", async () => {
    // Nothing reads `/healthz` here, so the notifier's refusals are the only
    // witness — and it must refuse the resolution as well as the doorbell.
    const n = await notifierOn(0, { cannotShow: "notify-send not found" });
    const remote = remoteTarget(`http://127.0.0.1:${n.port}/notify`, NOTIFY_TOKEN);
    const dispatcher = new Dispatcher([localTarget(headless()), remote]);

    expect(dispatcher.live(), "presumed live until something says otherwise").toEqual([remote.name]);
    await dispatcher.send(envelope("blocked"));
    expect(dispatcher.live()).toEqual([]);
    const [outcome] = (await dispatcher.send(envelope("resolved"))).filter((o) => o.target === remote.name);
    expect(outcome?.ok, "a resolution is refused like a doorbell").toBe(false);
    expect(dispatcher.live()).toEqual([]);
  });

  it("doctor says the notifier it found cannot show anything", async () => {
    const n = await notifierOn(0, { cannotShow: "notify-send not found" });
    const found = await detectNotifier(n.port);
    expect(found).toMatchObject({ found: true, canShow: false });
    const out = describeNotifier(found, true, null).join("\n");
    expect(out).toMatch(/cannot show/);
  });
});

describe("a healthy notifier is revived by the probe", () => {
  it("comes back on the next probe after a restart swallowed one POST", async () => {
    // The 5-second restart: an upgrade, a launchd KeepAlive restart, a Wi-Fi
    // blip the ssh session survives. Shorter than the probe interval, so the
    // probe never sees it gone and never re-attaches.
    const local = headless();
    let n = await notifierOn(0);
    const dispatcher = new Dispatcher([localTarget(local)]);
    const watch = new NotifierWatch(dispatcher, NOTIFY_TOKEN);
    const d = await daemonFor(dispatcher, local, n.port);

    watch.observe(await detectNotifier(n.port));
    const name = `remote(${watch.url})`;
    expect(await d.live()).toEqual([name]);

    await n.close();
    const [failed] = (await dispatcher.send(envelope("resolved"))).filter((o) => o.target === name);
    expect(failed?.ok).toBe(false);
    expect(await d.live(), "the failed POST is believed").toEqual([]);

    n = await notifierOn(n.port);
    const line = watch.observe(await detectNotifier(n.port));
    expect(await d.live(), "the probe reached it, so it is live again").toEqual([name]);
    expect(line, "and the daemon log says so").toMatch(/live|reachable/);
    expect(await d.line()).not.toContain(LINE_TEXT.noDelivery);
    expect(await d.doctor()).toContain(`reaching you through: ${name}`);
  });

  it("does not revive a notifier that refused the token — the probe needs none, so proves nothing", async () => {
    const n = await notifierOn(0);
    const dispatcher = new Dispatcher([localTarget(headless())]);
    const watch = new NotifierWatch(dispatcher, "not-the-notifiers-token");

    watch.observe(await detectNotifier(n.port));
    await dispatcher.send(envelope("blocked"));
    expect(dispatcher.live()).toEqual([]);

    watch.observe(await detectNotifier(n.port));
    expect(dispatcher.live(), "a reachable notifier that says 401 is still unauthorised").toEqual([]);
    expect(dispatcher.describe()).toContain("token mismatch");
  });

  it("follows a notifier that becomes able to show, and one that stops", async () => {
    // A notifier restarted from a desktop login after running headless, and
    // the reverse. The probe carries the answer both ways.
    let n = await notifierOn(0, { cannotShow: "no session bus or display" });
    const dispatcher = new Dispatcher([localTarget(headless())]);
    const watch = new NotifierWatch(dispatcher, NOTIFY_TOKEN);
    watch.observe(await detectNotifier(n.port));
    expect(dispatcher.live()).toEqual([]);

    await n.close();
    n = await notifierOn(n.port);
    watch.observe(await detectNotifier(n.port));
    expect(dispatcher.live()).toEqual([`remote(${watch.url})`]);

    await n.close();
    n = await notifierOn(n.port, { cannotShow: "no session bus or display" });
    watch.observe(await detectNotifier(n.port));
    expect(dispatcher.live()).toEqual([]);
  });

  it("detaches a notifier that went away, and says who is left", async () => {
    const n = await notifierOn(0);
    const dispatcher = new Dispatcher([localTarget(headless())]);
    const watch = new NotifierWatch(dispatcher, NOTIFY_TOKEN);
    watch.observe(await detectNotifier(n.port));
    await n.close();

    const line = watch.observe(await detectNotifier(n.port));
    expect(watch.url).toBeNull();
    expect(dispatcher.names()).toEqual(["local"]);
    expect(line).toContain("went away");
    expect(line).toContain("delivery paths: none live (local: notify-send not found)");
  });

  it("says nothing on a probe that changed nothing", async () => {
    const n = await notifierOn(0);
    const dispatcher = new Dispatcher([localTarget(headless())]);
    const watch = new NotifierWatch(dispatcher, NOTIFY_TOKEN);
    expect(watch.observe(await detectNotifier(n.port))).toMatch(/detected/);
    expect(watch.observe(await detectNotifier(n.port))).toBeNull();
  });
});

describe("a local notifier that fails is not counted as delivered", () => {
  it("goes dead on a failing notify-send, and live again when one succeeds", async () => {
    // The headless systemd host: notify-send installed, the session bus
    // exported to SSH shells by pam_systemd, and nothing on that bus owning
    // org.freedesktop.Notifications. The static check passes; every run
    // exits 1. The runner is injected — no real notifier is spawned here.
    const outcomes: NotifyOutcome[] = [{ ok: false, reason: "notify-send failed (exit 1)" }, { ok: true }];
    const local = createNotifierBackend({
      platform: "linux",
      env: { PATH: "/usr/bin", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" },
      exists: (p) => p === "/usr/bin/notify-send",
      run: () => Promise.resolve(outcomes.shift() ?? { ok: true }),
    });
    expect(local.available, "the static gate passes, as it does on that host").toBe(true);

    const dispatcher = new Dispatcher([localTarget(local)]);
    // Nothing on the notify port: a single machine, so its absence is calm.
    const d = await daemonFor(dispatcher, local, 1);
    expect(await d.live()).toEqual(["local"]);

    const [first] = await dispatcher.send(envelope("blocked"));
    expect(first).toMatchObject({ target: "local", ok: false, reason: "notify-send failed (exit 1)" });
    expect(await d.live()).toEqual([]);
    expect(dispatcher.describe()).toBe("none live (local: notify-send failed (exit 1))");
    expect(await d.line()).toContain(LINE_TEXT.noDelivery);

    const [second] = await dispatcher.send(envelope("blocked"));
    expect(second?.ok).toBe(true);
    expect(await d.live()).toEqual(["local"]);
    expect(await d.line()).not.toContain(LINE_TEXT.noDelivery);
  });

  it("a notifier on such a host refuses what it failed to show, and says it cannot show", async () => {
    // `astir notifier` hands the same backend's notify to its server. A
    // doorbell it tried and failed to show is refused, and its `/healthz`
    // stops claiming it can show one until a later doorbell proves otherwise.
    const outcomes: NotifyOutcome[] = [{ ok: false, reason: "notify-send failed (exit 1)" }, { ok: true }];
    const n = await notifierOn(0, { notify: () => Promise.resolve(outcomes.shift() ?? { ok: true }) });
    const dispatcher = new Dispatcher([localTarget(headless())]);
    const watch = new NotifierWatch(dispatcher, NOTIFY_TOKEN);
    watch.observe(await detectNotifier(n.port));
    const name = `remote(${watch.url})`;

    const [refused] = (await dispatcher.send(envelope("blocked"))).filter((o) => o.target === name);
    expect(refused?.ok).toBe(false);
    expect((await detectNotifier(n.port)).canShow).toBe(false);
    watch.observe(await detectNotifier(n.port));
    // Its resolution is refused too: nothing was shown, and a 200 here is the
    // answer that used to revive a dead path.
    const [resolution] = (await dispatcher.send(envelope("resolved"))).filter((o) => o.target === name);
    expect(resolution?.ok).toBe(false);
    expect(dispatcher.live()).toEqual([]);

    // A later doorbell shows, and the next probe believes it.
    const later = buildEnvelope({
      kind: "blocked",
      reason: "permission_prompt",
      sessionId: "s2",
      agentId: "a2",
      cwd: "/repo",
    });
    const [shown] = (await dispatcher.send(later)).filter((o) => o.target === name);
    expect(shown?.ok).toBe(true);
    expect((await detectNotifier(n.port)).canShow).toBe(true);
    watch.observe(await detectNotifier(n.port));
    expect(dispatcher.live()).toEqual([name]);
  });
});
