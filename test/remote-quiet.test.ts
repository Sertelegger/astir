/**
 * #98 — a quiet schedule must not make another machine's blocked agent read as
 * lost contact.
 *
 * The notifier's view of other machines (PSH-12) refreshed an entry only when a
 * `blocked` doorbell arrived. It shows an entry as unreachable after 20 minutes
 * of silence and drops it after two hours, and every schedule used to remind at
 * least quarter-hourly, so that never happened to an agent still waiting on a
 * healthy tunnel. Calm now goes an hour between reminders, and `off` sends
 * none: the agent read as "lost contact" for most of each hour, left the
 * blocked count, and under `off` vanished at two hours.
 *
 * The roster (DMN-10) already crosses the same tunnel every 10 s. It now says
 * which agents are still blocked, and the view hears them from it. Refresh
 * only: a roster never adds a block, which is the doorbell's job, and never
 * ends one, which is `resolved`'s.
 *
 * Also here, DOC-2: a notification the notifier raises for another machine is
 * grouped, so a reminder replaces it, and withdrawn on `resolved` — what the
 * macOS Alerts tip promises.
 */

import { afterEach, describe, expect, it } from "vitest";
import { type AstirEvent, CONTRACT_VERSION, type Kind } from "../src/contract/event.js";
import { Registry } from "../src/model/registry.js";
import { Dispatcher } from "../src/notify/dispatch.js";
import { buildEnvelope, type NotifyEnvelope, notificationGroup } from "../src/notify/envelope.js";
import { NotifyLoop } from "../src/notify/loop.js";
import type { Notification } from "../src/notify/notify.js";
import { NotifyPolicy, type ReminderSchedule } from "../src/notify/policy.js";
import { RemoteView } from "../src/notify/remote.js";
import {
  MAX_BLOCKED_PER_SESSION,
  type RosterPayload,
  rosterOf,
  validateRoster,
} from "../src/notify/roster.js";
import { NotifierServer } from "../src/notify/server.js";
import { statusLine } from "../src/status/line.js";
import type { StatusBody } from "../src/status/types.js";

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
/** The daemon's roster tick. */
const ROSTER_EVERY = 10 * SEC;
/** What `hostname()` says on the far machine; its envelopes carry the short form. */
const FAR = "megabrain.example.net";

let seq = 0;
function ev(kind: Kind, over: Partial<AstirEvent> = {}): AstirEvent {
  seq++;
  return {
    v: CONTRACT_VERSION,
    eventId: `quiet${seq}`,
    provider: "claude",
    sessionId: "s1",
    ts: 1_786_900_000 + seq,
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
  };
}

/**
 * The far machine's daemon and this machine's notifier view, on one fake
 * clock: the real loop at the daemon's 1 s tick, its doorbells applied to the
 * view as `POST /notify` does, and — while the tunnel is up — the roster built
 * as the daemon builds it, every 10 s, heard as `POST /roster` hears it.
 */
function farMachine(schedule: ReminderSchedule) {
  const clock = { t: 0 };
  const now = () => clock.t;
  const registry = new Registry({ nowMs: now });
  const view = new RemoteView();
  const loop = new NotifyLoop({
    registry,
    policy: new NotifyPolicy({ reminders: () => schedule }),
    dispatcher: new Dispatcher([
      {
        name: "notifier",
        live: () => true,
        deliver: async (envelope) => {
          view.apply({ ...envelope, origin: { ...envelope.origin, host: "megabrain" } }, clock.t);
          return { ok: true };
        },
      },
    ]),
    now,
    dwellMs: () => 0,
  });
  let rosters = true;
  return {
    view,
    registry,
    clock,
    block: () => registry.apply(ev("notification", { notificationKind: "permission_prompt" }), "/srv/astir"),
    tunnelDown: () => {
      rosters = false;
    },
    /** One second of the daemon, then a roster when one is due. */
    step: async () => {
      clock.t += SEC;
      registry.tick();
      await loop.pulse();
      if (rosters && clock.t % ROSTER_EVERY === 0) view.confirm(rosterOf(registry, FAR), clock.t);
    },
  };
}

/** The status line, as `astir status --line` on this machine sees the view at `t`. */
function lineAt(view: RemoteView, t: number) {
  const body: StatusBody = {
    v: { major: 2, minor: 2 },
    blockedCount: 0,
    sessions: [],
    silent: [],
    host: "the-mac",
  };
  return statusLine({
    session: null,
    port: 47_000,
    health: { ok: true, role: "daemon", host: "the-mac", delivery: { live: ["local"] } },
    status: { ok: true, body },
    remote: { agents: view.list(t), sessions: [] },
    now: t,
    selfHost: "the-mac",
  });
}

describe("#98 — a blocked agent on another machine stays reachable under every schedule", () => {
  it.each(["calm", "off", "insistent"] as const)(
    "%s: six hours blocked on a healthy tunnel is never shown as lost contact, never dropped",
    async (schedule) => {
      const far = farMachine(schedule);
      far.block();
      let stale = 0;
      let missing = 0;
      for (let minute = 1; minute <= 6 * 60; minute++) {
        for (let s = 0; s < 60; s++) await far.step();
        far.view.prune(far.clock.t);
        const agents = far.view.list(far.clock.t);
        if (agents.length !== 1) missing++;
        else if (agents[0]?.stale === true) stale++;
      }
      expect({ stale, missing }).toEqual({ stale: 0, missing: 0 });

      const line = lineAt(far.view, far.clock.t);
      expect(line.warnings).toEqual([]);
      expect(line.blocked).toBe(1);
    },
    60_000,
  );

  it("calm at +60 min: counted as waiting, not as a machine astir lost contact with", async () => {
    const far = farMachine("calm");
    far.block();
    while (far.clock.t < HOUR) await far.step();
    const line = lineAt(far.view, far.clock.t);
    expect(line.warnings.map((w) => w.kind)).not.toContain("contact-lost");
    expect(line.blocked).toBe(1);
  });

  it("when the tunnel drops, contact is still lost at 20 minutes and the entry goes at 2 hours", async () => {
    // The control: the roster is what keeps the entry, and only while it
    // arrives. Silence still means what it meant.
    const far = farMachine("off");
    far.block();
    while (far.clock.t < 5 * MIN) await far.step();
    far.tunnelDown();
    const lastHeard = far.clock.t;
    while (far.clock.t < lastHeard + 20 * MIN - SEC) await far.step();
    expect(far.view.list(far.clock.t)[0]?.stale).toBe(false);
    await far.step();
    expect(far.view.list(far.clock.t)[0]?.stale).toBe(true);
    expect(lineAt(far.view, far.clock.t).warnings.map((w) => w.kind)).toEqual(["contact-lost"]);

    while (far.clock.t < lastHeard + 2 * HOUR) await far.step();
    far.view.prune(far.clock.t);
    expect(far.view.list(far.clock.t)).toEqual([]);
  });
});

describe("#98 — what a roster may do to the view", () => {
  const blocked = (over: Partial<Parameters<typeof buildEnvelope>[0]> = {}): NotifyEnvelope =>
    buildEnvelope({
      kind: "blocked",
      reason: "permission_prompt",
      sessionId: "s1",
      agentId: "a1",
      cwd: "/srv/astir",
      host: "megabrain",
      now: 0,
      ...over,
    });
  const roster = (sessions: RosterPayload["sessions"], host = FAR): RosterPayload => ({ host, sessions });
  const session = (blockedIds?: string[]): RosterPayload["sessions"][number] => ({
    sessionId: "s1",
    cwd: "/srv/astir",
    name: null,
    status: "busy",
    ...(blockedIds === undefined ? {} : { blocked: blockedIds }),
  });

  it("hears an agent the roster names as blocked: its host matched however either end spells it", () => {
    const view = new RemoteView();
    view.apply(blocked(), 0);
    view.confirm(roster([session(["a1"])], "MEGABRAIN.example.net"), 30 * MIN);
    expect(view.list(30 * MIN)[0]?.stale).toBe(false);
    expect(view.list(30 * MIN)[0]?.lastSeen).toBe(30 * MIN);
  });

  it("does not hear one the roster does not name, nor one from another machine", () => {
    const view = new RemoteView();
    view.apply(blocked(), 0);
    view.confirm(roster([session(["someone-else"])]), 30 * MIN);
    view.confirm(roster([session(["a1"])], "buildbox"), 30 * MIN);
    view.confirm(roster([{ ...session(["a1"]), sessionId: "s2" }]), 30 * MIN);
    expect(view.list(30 * MIN)[0]?.stale).toBe(true);
  });

  it("a roster from a daemon that does not say what is blocked says nothing about it", () => {
    // Older than #98: no `blocked` at all. Not evidence either way.
    const view = new RemoteView();
    view.apply(blocked(), 0);
    view.confirm(roster([session()]), 30 * MIN);
    expect(view.list(30 * MIN)[0]?.stale).toBe(true);
  });

  it("never adds a block, and never ends one", () => {
    // A doorbell announces a block and `resolved` ends it. A roster and a
    // `resolved` travel separately and can cross, so a roster that dropped
    // entries could end a block before its doorbell's reply had been heard.
    const view = new RemoteView();
    view.confirm(roster([session(["a1"])]), 0);
    expect(view.list(0)).toEqual([]);

    view.apply(blocked(), 0);
    view.confirm(roster([{ ...session(), status: "idle" }]), 1_000);
    view.confirm(roster([]), 2_000);
    expect(view.list(2_000)).toHaveLength(1);
  });

  it("keeps a dismissed agent dismissed", () => {
    const view = new RemoteView();
    view.apply(blocked(), 0);
    view.acknowledge();
    view.confirm(roster([session(["a1"])]), 30 * MIN);
    expect(view.list(30 * MIN)[0]?.acknowledged).toBe(true);
    expect(view.blockedCount()).toBe(0);
  });
});

describe("#98 — the roster says which agents are blocked", () => {
  it("names each blocked agent under its session, and nothing for the rest", () => {
    let t = 0;
    const registry = new Registry({ nowMs: () => t });
    registry.apply(
      ev("notification", { sessionId: "s1", agentId: "s1", notificationKind: "permission_prompt" }),
      "/r",
    );
    registry.apply(ev("pre_tool", { sessionId: "s2", agentId: "s2" }), "/r2");
    t = 1_000;
    const r = rosterOf(registry, FAR);
    expect(r.host).toBe(FAR);
    const byId = new Map(r.sessions.map((s) => [s.sessionId, s]));
    expect(byId.get("s1")?.blocked).toEqual(["s1"]);
    expect(byId.get("s2")?.blocked).toBeUndefined();
    expect(byId.get("s2")?.cwd).toBe("/r2");
  });

  it("leaves out an agent dismissed on its own machine: that block is retired, with a resolved", () => {
    const registry = new Registry({ nowMs: () => 0 });
    registry.apply(
      ev("notification", { sessionId: "s1", agentId: "s1", notificationKind: "permission_prompt" }),
      "/r",
    );
    registry.acknowledge("s1");
    expect(rosterOf(registry, FAR).sessions[0]?.blocked).toBeUndefined();
  });

  it("survives validation, bounded, and with anything that is not an id dropped", () => {
    const many = Array.from({ length: MAX_BLOCKED_PER_SESSION + 5 }, (_, i) => `a${i}`);
    const r = validateRoster({
      host: FAR,
      sessions: [
        { sessionId: "s1", cwd: "/x", blocked: ["a1", 7, null, "a2"] },
        { sessionId: "s2", cwd: "/y", blocked: many },
        { sessionId: "s3", cwd: "/z", blocked: "a1" },
        { sessionId: "s4", cwd: "/w" },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [s1, s2, s3, s4] = r.roster.sessions;
    expect(s1?.blocked).toEqual(["a1", "a2"]);
    expect(s2?.blocked).toHaveLength(MAX_BLOCKED_PER_SESSION);
    expect(s3?.blocked).toBeUndefined();
    expect(s4?.blocked).toBeUndefined();
  });
});

describe("#98 — the notifier's routes, end to end", () => {
  const TOKEN = "q".repeat(48);
  const open: NotifierServer[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  const post = (port: number, path: string, body: unknown): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const state = async (port: number) =>
    (await (
      await fetch(`http://127.0.0.1:${port}/state`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    ).json()) as { blockedCount: number; agents: { stale?: boolean }[] };

  const envelope = (kind: "blocked" | "resolved", host = "megabrain"): NotifyEnvelope =>
    buildEnvelope({
      kind,
      reason: "permission_prompt",
      sessionId: "s1",
      agentId: "a1",
      cwd: "/srv/astir",
      host,
    });

  it("a roster heard an hour into a block keeps the agent waiting, not unreachable", async () => {
    const clock = { t: 0 };
    const server = new NotifierServer({
      token: TOKEN,
      notify: () => undefined,
      host: "the-mac",
      now: () => clock.t,
    });
    open.push(server);
    const port = await server.listen(0);

    expect((await post(port, "/notify", envelope("blocked"))).status).toBe(200);
    clock.t = HOUR;
    expect((await state(port)).agents[0]?.stale).toBe(true);

    const roster = {
      host: FAR,
      sessions: [{ sessionId: "s1", cwd: "/srv/astir", name: null, status: "busy", blocked: ["a1"] }],
    };
    expect((await post(port, "/roster", roster)).status).toBe(200);
    const after = await state(port);
    expect(after.agents[0]?.stale).toBe(false);
    expect(after.blockedCount).toBe(1);
  });

  it("DOC-2 — groups another machine's alert, so a reminder replaces it, and withdraws it on resolved", async () => {
    const shown: Notification[] = [];
    const removed: string[] = [];
    const server = new NotifierServer({
      token: TOKEN,
      notify: async (n) => {
        shown.push(n);
        return { ok: true };
      },
      remove: (group) => {
        removed.push(group);
      },
      host: "the-mac",
    });
    open.push(server);
    const port = await server.listen(0);

    expect((await post(port, "/notify", envelope("blocked"))).status).toBe(200);
    expect((await post(port, "/notify", envelope("blocked"))).status).toBe(200);
    expect((await post(port, "/notify", envelope("resolved"))).status).toBe(200);

    expect(shown.map((n) => n.group)).toEqual(["megabrain/s1:a1", "megabrain/s1:a1"]);
    expect(shown[0]?.body).toBe("megabrain · astir needs permission to run something");
    expect(removed).toEqual(["megabrain/s1:a1"]);
  });

  it("DOC-2 — an alert from this machine's own daemon shares the local alert's group", () => {
    // The local daemon's own target posts `s1:a1`; a doorbell it also sends to
    // this notifier then replaces that banner rather than adding a second.
    expect(notificationGroup(envelope("blocked", "the-mac"), "the-mac.local")).toBe("s1:a1");
    expect(notificationGroup(envelope("blocked", "megabrain"), "the-mac")).toBe("megabrain/s1:a1");
  });
});
