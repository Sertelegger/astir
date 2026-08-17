import { afterEach, describe, expect, it } from "vitest";
import { Dispatcher, localTarget, remoteTarget } from "../src/notify/dispatch.js";
import { buildEnvelope, ENVELOPE_VERSION, validateEnvelope } from "../src/notify/envelope.js";
import type { Notification } from "../src/notify/notify.js";
import { NotifyPolicy } from "../src/notify/policy.js";
import { RemoteView } from "../src/notify/remote.js";
import { NotifierServer } from "../src/notify/server.js";

const SEC = 1_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("PSH-02 — per-state notification lifetimes", () => {
  it("notifies immediately on becoming blocked", () => {
    const p = new NotifyPolicy();
    expect(p.shouldNotify("s:a", "blocked", 0)).toBe(true);
  });

  it("nags every minute for the first 10 minutes", () => {
    const p = new NotifyPolicy();
    expect(p.shouldNotify("s:a", "blocked", 0)).toBe(true); // initial

    expect(p.shouldNotify("s:a", "blocked", 30 * SEC)).toBe(false); // too soon
    for (let m = 1; m <= 9; m++) {
      expect(p.shouldNotify("s:a", "blocked", m * MIN), `minute ${m}`).toBe(true);
    }
  });

  it("relaxes to 2-minute, then 5-minute, then quarter-hourly cadence", () => {
    // Drive it the way the daemon does — a steady poll — and assert the gaps
    // between the reminders that actually fire. Sampling the schedule at
    // hand-picked instants would let a stale `lastAt` fake a passing result.
    const p = new NotifyPolicy();
    const firedAt: number[] = [];
    for (let t = 0; t <= 3 * HOUR; t += SEC) {
      if (p.shouldNotify("s:a", "blocked", t)) firedAt.push(t);
    }

    const gapAfter = (mins: number): number => {
      const i = firedAt.findIndex((t) => t >= mins * MIN);
      return (firedAt[i + 1] ?? 0) - (firedAt[i] ?? 0);
    };

    expect(gapAfter(2)).toBe(1 * MIN);
    expect(gapAfter(15)).toBe(2 * MIN);
    expect(gapAfter(45)).toBe(5 * MIN);
    expect(gapAfter(120)).toBe(15 * MIN);
  });

  it("delivers ~32 reminders in the first 90 minutes — insistent, not a single alert", () => {
    const p = new NotifyPolicy();
    let count = 0;
    // Poll once a second, exactly as the daemon heartbeat does.
    for (let t = 0; t <= 90 * MIN; t += SEC) {
      if (p.shouldNotify("s:a", "blocked", t)) count++;
    }
    // 1 initial + 9 (min 1-9) + 10 (10-30 @2min) + 12 (30-90 @5min).
    expect(count).toBe(32);
  });

  it("a late poll fires once, not a burst of catch-up reminders", () => {
    const p = new NotifyPolicy();
    p.shouldNotify("s:a", "blocked", 0);
    // The machine slept for 8 minutes; cadence is 1/min but only one fires.
    expect(p.shouldNotify("s:a", "blocked", 8 * MIN)).toBe(true);
    expect(p.shouldNotify("s:a", "blocked", 8 * MIN + SEC)).toBe(false);
  });

  it("stops after 24h — blocked persists, but not forever", () => {
    const p = new NotifyPolicy();
    p.shouldNotify("s:a", "blocked", 0);
    expect(p.shouldNotify("s:a", "blocked", 23 * HOUR)).toBe(true);
    expect(p.shouldNotify("s:a", "blocked", 25 * HOUR)).toBe(false);
  });

  it("terminal states notify once and never repeat", () => {
    const p = new NotifyPolicy();
    expect(p.shouldNotify("s:a", "completed", 0)).toBe(true);
    expect(p.shouldNotify("s:a", "completed", 1 * MIN)).toBe(false);
    expect(p.shouldNotify("s:a", "completed", 10 * MIN)).toBe(false);
  });

  it("resolving gives a fresh schedule rather than resuming a stale backoff", () => {
    const p = new NotifyPolicy();
    p.shouldNotify("s:a", "blocked", 0);
    p.shouldNotify("s:a", "blocked", 30 * MIN); // deep into the schedule

    p.resolve("s:a"); // the human answered

    // Blocked again later: this is a new situation and deserves an immediate alert,
    // not the next slot of the old relaxed cadence.
    expect(p.shouldNotify("s:a", "blocked", 31 * MIN)).toBe(true);
  });

  it("a change of kind is a new situation", () => {
    const p = new NotifyPolicy();
    expect(p.shouldNotify("s:a", "blocked", 0)).toBe(true);
    expect(p.shouldNotify("s:a", "completed", 1000)).toBe(true);
  });

  it("prunes so it cannot grow unbounded (DMN-06)", () => {
    const p = new NotifyPolicy();
    for (let i = 0; i < 100; i++) p.shouldNotify(`s:${i}`, "completed", 0);
    expect(p.size()).toBe(100);
    p.prune(10 * MIN);
    expect(p.size()).toBe(0);
  });
});

describe("PSH-09 — the envelope is a doorbell", () => {
  const built = buildEnvelope({
    kind: "blocked",
    reason: "permission_prompt",
    sessionId: "abcdef12-3456-7890-aaaa-bbbbbbbbbbbb",
    agentId: "agent-1",
    cwd: "/Users/sascha/clients/acme/secret-project",
    now: 1_786_900_000_000,
    id: "fixed-id",
    host: "devbox",
    user: "sascha",
  });

  it("carries routing and identity", () => {
    expect(built.origin.host).toBe("devbox");
    expect(built.session.repo).toBe("secret-project");
    expect(built.reason).toBe("permission_prompt");
    expect(built.body).toContain("devbox");
  });

  it("carries the repo NAME, never the full path", () => {
    // "which repo" is routing. "/Users/sascha/clients/acme/..." is a disclosure,
    // and this message may cross a machine boundary or a hosted push service.
    const serialized = JSON.stringify(built);
    expect(serialized).not.toContain("/Users/sascha");
    expect(serialized).not.toContain("clients/acme");
  });

  it("has no field that could carry code, arguments or reasoning", () => {
    const keys = Object.keys(built).sort();
    expect(keys).toEqual(["body", "id", "kind", "origin", "reason", "session", "title", "ts", "v"]);
  });
});

describe("VER-01 — envelope versioning", () => {
  const valid = buildEnvelope({
    kind: "blocked",
    reason: "permission_prompt",
    sessionId: "s1",
    agentId: "a1",
    cwd: "/repo",
  });

  it("accepts the current major", () => {
    expect(validateEnvelope(valid).ok).toBe(true);
  });

  it("rejects an unknown major", () => {
    const future = { ...valid, v: { major: ENVELOPE_VERSION.major + 1, minor: 0 } };
    const r = validateEnvelope(future);
    expect(r.ok).toBe(false);
  });

  it("tolerates an unknown minor — skew across a boundary is the normal case", () => {
    const newerMinor = { ...valid, v: { major: ENVELOPE_VERSION.major, minor: 99 } };
    expect(validateEnvelope(newerMinor).ok).toBe(true);
  });

  it("rejects malformed and oversized input", () => {
    expect(validateEnvelope(null).ok).toBe(false);
    expect(validateEnvelope({ ...valid, ts: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(validateEnvelope({ ...valid, body: "x".repeat(600) }).ok).toBe(false);
  });
});

describe("PSH-06 — cross-boundary delivery", () => {
  let server: NotifierServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const envelope = buildEnvelope({
    kind: "blocked",
    reason: "permission_prompt",
    sessionId: "s1",
    agentId: "a1",
    cwd: "/repo",
  });

  it("delivers a doorbell from a 'remote' daemon to a notifier over a port", async () => {
    // Loopback is exactly what an `ssh -R` tunnel presents to the sender, so this
    // exercises the real path rather than a stand-in.
    const seen: Notification[] = [];
    server = new NotifierServer({ token: "shared", notify: (n) => seen.push(n) });
    const port = await server.listen(0);

    const dispatcher = new Dispatcher([remoteTarget(`http://127.0.0.1:${port}/notify`, "shared")]);
    const outcomes = await dispatcher.send(envelope);

    expect(outcomes[0]?.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.title).toContain("needs your input");
  });

  it("rejects an unauthenticated attempt", async () => {
    const seen: Notification[] = [];
    server = new NotifierServer({ token: "shared", notify: (n) => seen.push(n) });
    const port = await server.listen(0);

    const dispatcher = new Dispatcher([remoteTarget(`http://127.0.0.1:${port}/notify`, "wrong-token")]);
    const outcomes = await dispatcher.send(envelope);

    expect(outcomes[0]?.ok).toBe(false);
    expect(outcomes[0]?.reason).toContain("unauthorized");
    expect(seen).toHaveLength(0);
  });

  it("dedupes a retried id so a flaky tunnel cannot double-notify", async () => {
    const seen: Notification[] = [];
    server = new NotifierServer({ token: "shared", notify: (n) => seen.push(n) });
    const port = await server.listen(0);

    const dispatcher = new Dispatcher([remoteTarget(`http://127.0.0.1:${port}/notify`, "shared")]);
    await dispatcher.send(envelope);
    await dispatcher.send(envelope);

    expect(seen).toHaveLength(1);
    expect(server.snapshot().duplicates).toBe(1);
  });

  it("a dead remote never suppresses local delivery (PSH-07)", async () => {
    const local: Notification[] = [];
    const dispatcher = new Dispatcher([
      localTarget((n) => local.push(n)),
      // Nothing is listening here.
      remoteTarget("http://127.0.0.1:1/notify", "shared", 500),
    ]);

    const outcomes = await dispatcher.send(envelope);
    expect(local).toHaveLength(1);
    expect(outcomes.find((o) => o.target === "local")?.ok).toBe(true);
    expect(outcomes.find((o) => o.target.startsWith("remote"))?.ok).toBe(false);
  });

  it("reports which path is live, so silent non-delivery is diagnosable", async () => {
    const dispatcher = new Dispatcher([localTarget(() => undefined)]);
    expect(dispatcher.status()[0]?.reason).toBe("not yet attempted");
    await dispatcher.send(envelope);
    expect(dispatcher.status()[0]?.ok).toBe(true);
  });
});

describe("PSH-12 — the notifier's view of other machines", () => {
  const env = (over: Partial<Parameters<typeof buildEnvelope>[0]> = {}) =>
    buildEnvelope({
      kind: "blocked",
      reason: "permission_prompt",
      sessionId: "remote-1",
      agentId: "a1",
      cwd: "/srv/payments-api",
      host: "devbox",
      ...over,
    });

  it("tracks a remote blocked agent and clears it on resolve", () => {
    const v = new RemoteView();
    expect(v.apply(env(), 0).notify).toBe(true);
    expect(v.blockedCount()).toBe(1);
    expect(v.list()[0]?.host).toBe("devbox");

    // Without this the entry is immortal: a doorbell is edge-triggered, so the
    // receiver never learns the agent stopped waiting.
    expect(v.apply(env({ kind: "resolved" }), 1_000).notify, "resolve is silent").toBe(false);
    expect(v.blockedCount()).toBe(0);
    expect(v.list()).toHaveLength(0);
  });

  it("expires an entry whose machine went quiet", () => {
    // The tunnel dropped between `blocked` and `resolved`. A menu bar confidently
    // reporting a host it can no longer hear from is worse than one that forgets.
    const v = new RemoteView({ ttlMs: 60_000 });
    v.apply(env(), 0);
    v.prune(30_000);
    expect(v.list()).toHaveLength(1);
    v.prune(61_000);
    expect(v.list()).toHaveLength(0);
  });

  it("a reminder for a dismissed remote agent stays silent", () => {
    const v = new RemoteView();
    v.apply(env(), 0);
    expect(v.acknowledge()).toBe(1);
    expect(v.blockedCount()).toBe(0);
    // The sender keeps reminding — it has no idea we dismissed it here.
    expect(v.apply(env(), 60_000).notify).toBe(false);
    expect(v.list(), "but it is still listed, still honest").toHaveLength(1);
  });

  it("keeps agents from different hosts distinct even with the same session id", () => {
    const v = new RemoteView();
    v.apply(env({ host: "devbox" }), 0);
    v.apply(env({ host: "buildbox" }), 0);
    expect(v.list()).toHaveLength(2);
  });
});
