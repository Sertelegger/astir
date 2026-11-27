/**
 * #98 — a quiet schedule must not make another machine's blocked agent read as
 * lost contact, nor leave it unlisted.
 *
 * The notifier's view of other machines (PSH-12) learned of a block only from a
 * `blocked` doorbell. It shows an entry as unreachable after 20 minutes of
 * silence and drops it after two hours, and every schedule used to remind at
 * least quarter-hourly, so that never happened to an agent still waiting on a
 * healthy tunnel. Calm now goes an hour between reminders, and `off` sends
 * none: the agent read as "lost contact" for most of each hour, left the
 * blocked count, and under `off` vanished at two hours. Worse, a notifier that
 * restarted mid-block, or a tunnel that came up after the first alert, missed
 * the one doorbell that would have listed it, and the agent stayed unlisted
 * until the next reminder: up to an hour under calm, for good under `off`.
 *
 * The roster (DMN-10) already crosses the same tunnel every 10 s. It now names
 * the agents blocked on its machine: an agent a roster names is listed,
 * silently if no doorbell announced it here, and kept from going stale. A
 * roster never removes one. Removal is what it was: a `resolved` doorbell, or
 * silence — an entry nothing names any more goes stale, then expires. Doorbells
 * stay the alert channel, on the daemon's schedule.
 *
 * Also here, DOC-2: a notification the notifier raises for another machine is
 * grouped, so a reminder replaces it, and withdrawn on `resolved` — what the
 * macOS Alerts tip promises.
 */

import { afterEach, describe, expect, it } from "vitest";
import { type AstirEvent, CONTRACT_VERSION, type Kind } from "../src/contract/event.js";
import type { DiscoveredSession } from "../src/discovery/sessions.js";
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
  RosterStore,
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
 * The far machine's daemon and this machine's notifier, on one fake clock:
 * the real loop at the daemon's 1 s tick, its doorbells applied to the view as
 * `POST /notify` does, and the roster built as the daemon builds it, every
 * 10 s, heard as `POST /roster` hears it. Both cross the tunnel, so while it
 * is down neither arrives. A restarted notifier starts with an empty view and
 * roster store, as `astir notifier` does.
 */
function farMachine(schedule: ReminderSchedule, opts: { tunnel?: boolean } = {}) {
  const clock = { t: 0 };
  const now = () => clock.t;
  const registry = new Registry({ nowMs: now });
  let view = new RemoteView();
  let store = new RosterStore(now);
  let tunnel = opts.tunnel ?? true;
  /** Every doorbell that reached the notifier, and whether it raised an alert there. */
  const doorbells: { kind: string; at: number; alerted: boolean }[] = [];
  const loop = new NotifyLoop({
    registry,
    policy: new NotifyPolicy({ reminders: () => schedule }),
    dispatcher: new Dispatcher([
      {
        name: "notifier",
        live: () => true,
        deliver: async (envelope) => {
          if (!tunnel) return { ok: false, reason: "the tunnel is down" };
          const { notify } = view.apply(
            { ...envelope, origin: { ...envelope.origin, host: "megabrain" } },
            clock.t,
          );
          doorbells.push({ kind: envelope.kind, at: clock.t, alerted: notify });
          return { ok: true };
        },
      },
    ]),
    now,
    dwellMs: () => 0,
  });
  const step = async (): Promise<void> => {
    clock.t += SEC;
    registry.tick();
    await loop.pulse();
    if (tunnel && clock.t % ROSTER_EVERY === 0) {
      const roster = rosterOf(registry, FAR);
      store.apply(roster);
      view.confirm(roster, clock.t);
    }
  };
  return {
    get view() {
      return view;
    },
    get store() {
      return store;
    },
    registry,
    clock,
    doorbells,
    block: () => registry.apply(ev("notification", { notificationKind: "permission_prompt" }), "/srv/astir"),
    /** The human answers on the far machine, so the block ends there. */
    answer: () => registry.apply(ev("pre_tool"), "/srv/astir"),
    tunnelDown: () => {
      tunnel = false;
    },
    tunnelUp: () => {
      tunnel = true;
    },
    restartNotifier: () => {
      view = new RemoteView();
      store = new RosterStore(now);
    },
    /** One second of the daemon, then a roster when one is due. */
    step,
    /** Step up to and including `ms`. */
    runTo: async (ms: number) => {
      while (clock.t < ms) await step();
    },
  };
}

/** The status line, as `astir status --line` on this machine sees the notifier at `t`. */
function lineAt(view: RemoteView, t: number, store?: RosterStore) {
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
    remote: { agents: view.list(t), sessions: store?.list() ?? [] },
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

describe("#98 — the roster, not the reminders, keeps a remote block listed", () => {
  it.each([
    // Just after calm's +30, so its next reminder is an hour off.
    { schedule: "calm", restartAt: 31 * MIN },
    { schedule: "off", restartAt: 15 * MIN },
    // Just after a reminder: insistent's next is 5 minutes off.
    { schedule: "insistent", restartAt: 30 * MIN + 30 * SEC },
  ] as const)(
    "$schedule: a notifier restarted mid-block lists the agent again from the next roster, alerting nothing",
    async ({ schedule, restartAt }) => {
      const far = farMachine(schedule);
      far.block();
      await far.runTo(restartAt);
      far.restartNotifier();
      const rung = far.doorbells.length;

      await far.runTo(restartAt + ROSTER_EVERY);
      // Listed by the roster alone: no doorbell has reached the new notifier.
      expect(far.doorbells).toHaveLength(rung);
      const [agent, ...rest] = far.view.list(far.clock.t);
      expect(rest).toEqual([]);
      expect(agent).toMatchObject({
        host: "megabrain",
        repo: "astir",
        sessionId: "s1",
        agentId: "s1",
        acknowledged: false,
        stale: false,
      });
      // Waiting since the block began, which the roster says, not since the
      // notifier came back.
      expect(far.clock.t - (agent?.since ?? far.clock.t)).toBeGreaterThanOrEqual(restartAt);
      expect(far.view.blockedCount()).toBe(1);

      // And listed from then on, never as lost contact. Under calm and off no
      // doorbell is needed for that: calm's next is at +90, off has none.
      let missing = 0;
      let stale = 0;
      while (far.clock.t < restartAt + 55 * MIN) {
        await far.step();
        far.view.prune(far.clock.t);
        const agents = far.view.list(far.clock.t);
        if (agents.length !== 1) missing++;
        else if (agents[0]?.stale === true) stale++;
      }
      expect({ missing, stale }).toEqual({ missing: 0, stale: 0 });
      const after = far.doorbells.slice(rung);
      if (schedule === "insistent") {
        // Its reminders still alert: the roster listed it undismissed.
        expect(after.length).toBeGreaterThan(0);
        expect(after.every((d) => d.kind === "blocked" && d.alerted)).toBe(true);
      } else {
        expect(after).toEqual([]);
      }
    },
    30_000,
  );

  it.each([
    { schedule: "calm", upAt: 2 * MIN },
    { schedule: "off", upAt: 2 * MIN },
    // Between insistent's reminders at +2 and +3 minutes.
    { schedule: "insistent", upAt: 2 * MIN + 30 * SEC },
  ] as const)(
    "$schedule: a tunnel that comes up after the first alert lists the agent from the next roster, replaying nothing",
    async ({ schedule, upAt }) => {
      const far = farMachine(schedule, { tunnel: false });
      far.block();
      await far.runTo(upAt);
      // The first alert went out and reached no one here.
      expect(far.doorbells).toEqual([]);
      expect(far.view.list(far.clock.t)).toEqual([]);

      far.tunnelUp();
      await far.runTo(upAt + ROSTER_EVERY);
      expect(far.view.list(far.clock.t)).toMatchObject([
        { sessionId: "s1", acknowledged: false, stale: false },
      ]);
      expect(far.view.blockedCount()).toBe(1);
      // Listed, not announced again: the roster is not a doorbell.
      expect(far.doorbells).toEqual([]);
    },
  );

  it.each(["calm", "off"] as const)(
    "%s: ten minutes after a notifier restart, the status line counts the agent and draws its row as blocked",
    async (schedule) => {
      const far = farMachine(schedule);
      far.block();
      await far.runTo(31 * MIN);
      far.restartNotifier();
      await far.runTo(41 * MIN);

      const line = lineAt(far.view, far.clock.t, far.store);
      expect(line.warnings).toEqual([]);
      expect(line.blocked).toBe(1);
      expect(line.announced).toBe(1);
      expect(line.line).toContain("1 waiting on you");
      const [row, ...others] = line.rows;
      expect(others).toEqual([]);
      expect(row).toMatchObject({ sessionId: "s1", state: "blocked", announced: true, acknowledged: false });
      // How long it has really waited, give or take the roster's tick.
      expect(row?.waitingMs).toBeGreaterThanOrEqual(41 * MIN - ROSTER_EVERY);
      expect(row?.waitingMs).toBeLessThanOrEqual(41 * MIN + ROSTER_EVERY);
    },
    30_000,
  );

  it("a block that ended while its resolved was lost is not removed by a roster: it goes stale, then expires, as on main", async () => {
    const far = farMachine("off");
    far.block();
    await far.runTo(5 * MIN);
    expect(far.view.list(far.clock.t)).toHaveLength(1);
    // Last heard of in the roster at 5:00, which named it.
    const lastHeard = far.clock.t;
    expect(far.view.list(far.clock.t)[0]?.lastSeen).toBe(lastHeard);

    far.tunnelDown();
    far.answer();
    await far.runTo(6 * MIN);
    // The `resolved` went out into the dropped tunnel.
    expect(far.doorbells.map((d) => d.kind)).toEqual(["blocked"]);

    // The rosters are back, and none names it. None removes it either: only
    // a `resolved` or silence does.
    far.tunnelUp();
    await far.runTo(lastHeard + 20 * MIN - SEC);
    far.view.prune(far.clock.t);
    expect(far.view.list(far.clock.t)).toMatchObject([
      { sessionId: "s1", lastSeen: lastHeard, stale: false },
    ]);
    await far.step();
    expect(far.view.list(far.clock.t)).toMatchObject([{ sessionId: "s1", lastSeen: lastHeard, stale: true }]);

    await far.runTo(lastHeard + 2 * HOUR - SEC);
    far.view.prune(far.clock.t);
    expect(far.view.list(far.clock.t)).toHaveLength(1);
    await far.step();
    far.view.prune(far.clock.t);
    expect(far.view.list(far.clock.t)).toEqual([]);
    expect(far.doorbells.map((d) => d.kind)).toEqual(["blocked"]);
  });

  it("listed from the roster alone, it still goes stale at 20 minutes and expires at 2 hours when the rosters stop", async () => {
    const far = farMachine("off");
    far.block();
    await far.runTo(5 * MIN);
    far.restartNotifier();
    await far.runTo(5 * MIN + ROSTER_EVERY);
    expect(far.view.list(far.clock.t)).toHaveLength(1);

    far.tunnelDown();
    const lastHeard = far.clock.t;
    await far.runTo(lastHeard + 20 * MIN - SEC);
    expect(far.view.list(far.clock.t)[0]?.stale).toBe(false);
    await far.step();
    expect(far.view.list(far.clock.t)[0]?.stale).toBe(true);
    expect(lineAt(far.view, far.clock.t).warnings.map((w) => w.kind)).toEqual(["contact-lost"]);

    await far.runTo(lastHeard + 2 * HOUR);
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
  /** A roster from a daemon that names its blocked agents: #98 and later. */
  const roster = (sessions: RosterPayload["sessions"], host = FAR): RosterPayload => ({
    host,
    namesBlocked: true,
    sessions,
  });
  /** A roster from a daemon older than #98, which says nothing about blocks. */
  const olderRoster = (sessions: RosterPayload["sessions"], host = FAR): RosterPayload => ({
    host,
    sessions,
  });
  const session = (blockedIds?: string[], forMs?: number[]): RosterPayload["sessions"][number] => ({
    sessionId: "s1",
    cwd: "/srv/astir",
    name: null,
    status: "busy",
    ...(blockedIds === undefined ? {} : { blocked: blockedIds }),
    ...(forMs === undefined ? {} : { blockedForMs: forMs }),
  });

  it("hears an agent the roster names as blocked: the roster's full hostname is its doorbells' short one", () => {
    // A daemon's doorbells carry `shortHost(hostname())` and its roster
    // `hostname()`, so the two routes key one agent alike.
    const view = new RemoteView();
    view.apply(blocked(), 0);
    view.confirm(roster([session(["a1"])], FAR), 30 * MIN);
    expect(view.list(30 * MIN)).toMatchObject([{ host: "megabrain", lastSeen: 30 * MIN, stale: false }]);
  });

  it("lists an agent it names that no doorbell announced here, waiting as long as the roster says", () => {
    const view = new RemoteView();
    const t = 5 * HOUR;
    view.confirm(roster([session(["a1"], [40 * MIN])]), t);
    expect(view.list(t)).toEqual([
      {
        host: "megabrain",
        repo: "astir",
        sessionId: "s1",
        agentId: "a1",
        reason: "blocked",
        since: t - 40 * MIN,
        lastSeen: t,
        acknowledged: false,
        stale: false,
      },
    ]);
    expect(view.blockedCount()).toBe(1);
  });

  it("without how long, waiting from when it was first named here", () => {
    const view = new RemoteView();
    view.confirm(roster([session(["a1"])]), 7 * MIN);
    view.confirm(roster([session(["a1"])]), 8 * MIN);
    expect(view.list(8 * MIN)[0]?.since).toBe(7 * MIN);
  });

  it("one agent is one entry, whichever of roster and doorbell came first, and the doorbell still alerts", () => {
    const rosterFirst = new RemoteView();
    rosterFirst.confirm(roster([session(["a1"])]), 0);
    expect(rosterFirst.apply(blocked(), SEC).notify).toBe(true);
    expect(rosterFirst.list(SEC)).toHaveLength(1);

    const doorbellFirst = new RemoteView();
    expect(doorbellFirst.apply(blocked(), 0).notify).toBe(true);
    doorbellFirst.confirm(roster([session(["a1"])]), SEC);
    expect(doorbellFirst.list(SEC)).toHaveLength(1);
  });

  it("R98-10 — a roster dates a block it names from how long it says it has waited, if that is earlier", () => {
    // A doorbell dates an entry from when it arrived here: after a notifier
    // restart that is the first reminder heard, not the block's start.
    const view = new RemoteView();
    view.apply(blocked(), HOUR);
    view.confirm(roster([session(["a1"], [40 * MIN])]), HOUR + ROSTER_EVERY);
    expect(view.list(HOUR + ROSTER_EVERY)[0]?.since).toBe(HOUR + ROSTER_EVERY - 40 * MIN);

    // Never later: a roster built just before the doorbell crossed it says
    // less than the entry already knows.
    view.confirm(roster([session(["a1"], [0])]), HOUR + 2 * ROSTER_EVERY);
    expect(view.list(HOUR + 2 * ROSTER_EVERY)[0]?.since).toBe(HOUR + ROSTER_EVERY - 40 * MIN);
    // And a roster without how long leaves it be.
    view.confirm(roster([session(["a1"])]), HOUR + 3 * ROSTER_EVERY);
    expect(view.list(HOUR + 3 * ROSTER_EVERY)[0]).toMatchObject({
      since: HOUR + ROSTER_EVERY - 40 * MIN,
      lastSeen: HOUR + 3 * ROSTER_EVERY,
    });
  });

  /**
   * R98-14 — `blockedForMs` runs parallel to `blocked`, so each agent's wait
   * is the one at its own index, in its own session. The waits are uneven, so
   * neither one index for all nor the list read backwards matches by chance.
   */
  it("several agents named at once: each is dated by its own wait, listed new or heard again", () => {
    const t = 5 * HOUR;
    const several = roster([
      session(["a1", "a2", "a3"], [40 * MIN, 5 * MIN, 90 * MIN]),
      { ...session(["b1", "b2"], [20 * MIN, 70 * MIN]), sessionId: "s2", cwd: "/srv/other" },
    ]);
    const expected = {
      "s1:a1": t - 40 * MIN,
      "s1:a2": t - 5 * MIN,
      "s1:a3": t - 90 * MIN,
      "s2:b1": t - 20 * MIN,
      "s2:b2": t - 70 * MIN,
    };
    const sinceOf = (view: RemoteView) =>
      Object.fromEntries(view.list(t).map((a) => [`${a.sessionId}:${a.agentId}`, a.since]));

    // Listed new, from the roster alone.
    const fresh = new RemoteView();
    fresh.confirm(several, t);
    expect(sinceOf(fresh)).toEqual(expected);

    // Heard of first from doorbells, as by a notifier restarted mid-block:
    // each dated later than its block began. The roster moves each back to
    // its own start.
    const heard = new RemoteView();
    for (const s of several.sessions) {
      for (const agentId of s.blocked ?? [])
        heard.apply(blocked({ sessionId: s.sessionId, agentId }), t - SEC);
    }
    expect(Object.values(sinceOf(heard))).toEqual(Object.keys(expected).map(() => t - SEC));
    heard.confirm(several, t);
    expect(sinceOf(heard)).toEqual(expected);
  });

  it("a refresh is silent and changes nothing else: dismissed stays dismissed, and the doorbell's reason stays", () => {
    const view = new RemoteView();
    view.apply(blocked(), 0);
    view.acknowledge("s1");
    view.confirm(roster([session(["a1"], [MIN])]), 30 * MIN);
    expect(view.list(30 * MIN)).toMatchObject([
      { acknowledged: true, reason: "permission_prompt", lastSeen: 30 * MIN, stale: false },
    ]);
    expect(view.blockedCount()).toBe(0);
    // Its reminders after that show nothing, as for any dismissed agent.
    expect(view.apply(blocked(), HOUR).notify).toBe(false);
  });

  it("no roster ever removes an entry, whatever it names or leaves out", () => {
    const later = [
      roster([session()]),
      roster([{ ...session(["a2"]), status: "idle" }]),
      roster([{ ...session(["a1"]), sessionId: "s2" }]),
      roster([]),
      roster([], "megabrain"),
      roster([], "MEGABRAIN"),
      roster([], "megabrain.other.net"),
      roster([], "buildbox"),
      olderRoster([]),
    ];
    const listedBy: Record<string, (v: RemoteView) => void> = {
      doorbell: (v) => v.apply(blocked(), 0),
      roster: (v) => v.confirm(roster([session(["a1"])]), 0),
      both: (v) => {
        v.apply(blocked(), 0);
        v.confirm(roster([session(["a1"])]), SEC);
      },
      dismissed: (v) => {
        v.apply(blocked(), 0);
        v.acknowledge();
      },
    };
    for (const [how, list] of Object.entries(listedBy)) {
      for (const [i, r] of later.entries()) {
        const view = new RemoteView();
        list(view);
        const before = view.list(SEC)[0];
        // Right after, and much later: tick after tick of it.
        for (let t = ROSTER_EVERY; t <= 19 * MIN; t += ROSTER_EVERY) view.confirm(r, t);
        const mine = view.list(19 * MIN).filter((a) => a.sessionId === "s1" && a.agentId === "a1");
        expect({ how, i, mine }).toEqual({
          how,
          i,
          mine: [{ ...before, stale: false }],
        });
      }
    }
  });

  /**
   * How long a `resolved` outranks a roster: three of the daemon's roster
   * ticks, well past its 5 s push timeout. Written out rather than imported,
   * so a change to it fails here.
   */
  const RESOLVED_WINS = 30 * SEC;

  it("does not bring back a block whose resolved overtook the roster, for 30 s", () => {
    const view = new RemoteView();
    view.apply(blocked(), 0);
    view.apply(blocked({ kind: "resolved" }), MIN);
    view.confirm(roster([session(["a1"])]), MIN + SEC);
    expect(view.list(MIN + SEC)).toEqual([]);
    view.confirm(roster([session(["a1"])]), MIN + RESOLVED_WINS - SEC);
    expect(view.list(MIN + RESOLVED_WINS - SEC)).toEqual([]);
    // Named again after that, it is blocked again.
    view.confirm(roster([session(["a1"])]), MIN + RESOLVED_WINS);
    expect(view.list(MIN + RESOLVED_WINS)).toHaveLength(1);
  });

  it("a resolved removes an entry a roster listed, as it does a doorbell's", () => {
    const view = new RemoteView();
    view.confirm(roster([session(["a1"], [5 * MIN])]), 0);
    expect(view.apply(blocked({ kind: "resolved" }), MIN).notify).toBe(false);
    expect(view.list(MIN)).toEqual([]);
    expect(view.blockedCount()).toBe(0);
  });

  it("another machine's roster neither hears nor removes it", () => {
    const view = new RemoteView();
    view.apply(blocked(), 0);
    view.confirm(roster([session(["a1"])], "buildbox"), 30 * MIN);
    view.confirm(roster([], "buildbox"), 31 * MIN);
    const mine = view.list(31 * MIN).filter((a) => a.host === "megabrain");
    expect(mine).toHaveLength(1);
    expect(mine[0]?.stale).toBe(true);
  });

  it("a roster from a daemon that does not say what is blocked says nothing about it", () => {
    // Older than #98: no `blocked` at all. Not evidence either way.
    const view = new RemoteView();
    view.apply(blocked(), 0);
    view.confirm(olderRoster([session()]), 30 * MIN);
    expect(view.list(30 * MIN)[0]?.stale).toBe(true);
  });

  it("an older daemon's roster neither lists nor hears", () => {
    const view = new RemoteView();
    view.confirm(olderRoster([session(["a1"])]), 0);
    expect(view.list(0)).toEqual([]);

    view.apply(blocked(), 0);
    view.confirm(olderRoster([session(["a1"])]), 30 * MIN);
    expect(view.list(30 * MIN)[0]?.stale).toBe(true);
  });

  it("a roster does not bring back an entry past its TTL: it lists the agent afresh, undismissed and silent", () => {
    // Nothing pruned it — no doorbell, no `/state` — but it expired all the
    // same, as it would have on main.
    const view = new RemoteView();
    view.apply(blocked(), 0);
    view.acknowledge();
    const t = 2 * HOUR;
    view.confirm(roster([session(["a1"], [2 * HOUR])]), t);
    expect(view.list(t)).toMatchObject([{ acknowledged: false, since: 0, lastSeen: t, reason: "blocked" }]);
    expect(view.blockedCount()).toBe(1);

    // One second short of it, the entry is heard of again, dismissed.
    const within = new RemoteView();
    within.apply(blocked(), 0);
    within.acknowledge();
    within.confirm(roster([session(["a1"], [2 * HOUR])]), t - SEC);
    expect(within.list(t - SEC)).toMatchObject([{ acknowledged: true, lastSeen: t - SEC }]);
  });

  /**
   * R98-3 — the far daemon restarts mid-block, with the agent dismissed here.
   * Its restored block is not named again until its loop has announced it
   * again (`announcedAt` is not persisted), so for a while its rosters leave
   * it out. They do not remove it, and the doorbell that announces it again
   * finds it dismissed, as on main.
   */
  it("R98-3 — a dismissed agent a roster leaves out stays listed and dismissed; announced again, it shows nothing", () => {
    const view = new RemoteView();
    view.apply(blocked(), 0);
    expect(view.acknowledge("s1")).toBe(1);
    view.confirm(roster([session()]), 45 * MIN);
    expect(view.list(45 * MIN)).toMatchObject([{ acknowledged: true, since: 0 }]);
    const t = 45 * MIN + 40 * SEC;
    expect(view.apply(blocked(), t).notify).toBe(false);
    view.confirm(roster([session(["a1"], [SEC])]), t + ROSTER_EVERY);
    expect(view.list(t + ROSTER_EVERY)).toMatchObject([{ acknowledged: true, since: 0 }]);
    expect(view.blockedCount()).toBe(0);
  });

  it("a resolved ends a dismissed agent's block: the next one alerts, as on main", () => {
    const view = new RemoteView();
    view.apply(blocked(), 0);
    view.acknowledge();
    expect(view.apply(blocked({ kind: "resolved" }), 46 * MIN).notify).toBe(false);
    expect(view.apply(blocked(), 50 * MIN).notify).toBe(true);
    expect(view.list(50 * MIN)).toMatchObject([{ acknowledged: false, since: 50 * MIN }]);
    expect(view.blockedCount()).toBe(1);
  });
});

/**
 * R98-3 — an agent dismissed here, and then the far daemon restarts.
 *
 * Through the real restore path: the far registry is snapshotted, a new one
 * stages the snapshot and adopts it once discovery sees the session again
 * (`discoveryMs` after the start, then every 5 s), and a new loop and policy
 * start from nothing, as a new process does. Its restored block is announced
 * again once it has outlasted the dwell, and until then the rosters, every
 * 10 s from each start, do not name it. The dwell is Codex's 30 s, or
 * Claude's 5 s with discovery slow enough for a roster to land first. A
 * roster that leaves the agent out removes nothing, so it stays listed and
 * dismissed throughout, as on main.
 */
async function dismissedThenFarRestart(schedule: ReminderSchedule, dwellMs: number, discoveryMs: number) {
  const clock = { t: 0 };
  const now = () => clock.t;
  const view = new RemoteView();
  const alerted: number[] = [];
  const disc: DiscoveredSession = {
    sessionId: "s1",
    cwd: "/srv/astir",
    pid: 4242,
    status: "busy",
    name: "astir-aa",
    startedAt: 1_000,
  };
  const start = (registry: Registry) => ({
    registry,
    startedAt: clock.t,
    loop: new NotifyLoop({
      registry,
      policy: new NotifyPolicy({ reminders: () => schedule }),
      dispatcher: new Dispatcher([
        {
          name: "notifier",
          live: () => true,
          deliver: async (envelope) => {
            const { notify } = view.apply(
              { ...envelope, origin: { ...envelope.origin, host: "megabrain" } },
              clock.t,
            );
            if (notify && envelope.kind === "blocked") alerted.push(clock.t);
            return { ok: true };
          },
        },
      ]),
      now,
      dwellMs: () => dwellMs,
    }),
  });

  let far = start(new Registry({ nowMs: now }));
  far.registry.apply(ev("notification", { notificationKind: "agent_needs_input" }), "/srv/astir");
  far.registry.reconcile([disc], { provider: "claude" });
  let discoverFrom: number | null = null;
  let unnamedAfterRestart = false;
  let unlistedAfterRestart = false;
  while (clock.t < 3 * HOUR) {
    clock.t += SEC;
    // Dismissed here, on the notifier: the far daemon is not told.
    if (clock.t === 5 * MIN) expect(view.acknowledge("s1")).toBe(1);
    if (clock.t === 45 * MIN) {
      const restored = new Registry({ nowMs: now });
      restored.stageRestore(far.registry.snapshot());
      far = start(restored);
      discoverFrom = clock.t + discoveryMs;
    }
    if (discoverFrom !== null && clock.t >= discoverFrom && (clock.t - discoverFrom) % (5 * SEC) === 0) {
      far.registry.reconcile([disc], { provider: "claude" });
    }
    far.registry.tick();
    await far.loop.pulse();
    if (clock.t > far.startedAt && (clock.t - far.startedAt) % ROSTER_EVERY === 0) {
      const roster = rosterOf(far.registry, FAR);
      if (clock.t > 45 * MIN && !roster.sessions.some((s) => s.blocked?.includes("s1")))
        unnamedAfterRestart = true;
      view.confirm(roster, clock.t);
    }
    if (clock.t > 45 * MIN && view.list(clock.t).length === 0) unlistedAfterRestart = true;
  }
  return { view, alerted, unnamedAfterRestart, unlistedAfterRestart, t: clock.t };
}

describe("#98 — R98-3: a dismissal here outlives the far daemon restarting, as on main", () => {
  it.each([
    { schedule: "calm", dwellMs: 30 * SEC, discoveryMs: SEC },
    { schedule: "calm", dwellMs: 30 * SEC, discoveryMs: 3 * SEC },
    { schedule: "off", dwellMs: 30 * SEC, discoveryMs: SEC },
    { schedule: "insistent", dwellMs: 30 * SEC, discoveryMs: SEC },
    { schedule: "calm", dwellMs: 5 * SEC, discoveryMs: 6 * SEC },
  ] as const)(
    "$schedule, dwell $dwellMs ms, discovered $discoveryMs ms after the restart: nothing alerts again",
    async ({ schedule, dwellMs, discoveryMs }) => {
      const { view, alerted, unnamedAfterRestart, unlistedAfterRestart, t } = await dismissedThenFarRestart(
        schedule,
        dwellMs,
        discoveryMs,
      );
      // The first alert, before the dismissal; and the restart did open the
      // window in which a roster no longer named the agent. It stayed listed.
      expect(alerted.filter((at) => at < 5 * MIN).length).toBeGreaterThan(0);
      expect(unnamedAfterRestart).toBe(true);
      expect(unlistedAfterRestart).toBe(false);

      expect(alerted.filter((at) => at > 5 * MIN).map((at) => `${(at / MIN).toFixed(2)} min`)).toEqual([]);
      const [agent, ...rest] = view.list(t);
      expect(rest).toEqual([]);
      expect(agent).toMatchObject({ sessionId: "s1", agentId: "s1", acknowledged: true, stale: false });
      expect(agent?.since).toBeLessThanOrEqual(dwellMs + SEC);
      expect(view.blockedCount()).toBe(0);
    },
    60_000,
  );
});

/**
 * R98-7 — dismissed here, the laptop sleeps, the block is answered while the
 * tunnel is down so its `resolved` is lost, and the same agent blocks again
 * later. What happens is what happened on main: the dismissed entry is held
 * until the TTL runs out from when it was last heard of, and a new block
 * inside that is taken for it; one after it alerts as new.
 */
describe("#98 — R98-7: a dismissed block whose resolved was lost, then a new one, as on main", () => {
  async function sleepThenBlockAgain(upAt: number, blockAgainAt: number) {
    const far = farMachine("calm");
    far.block();
    const stepPruned = async (to: number) => {
      // The menu bar polls `/state`, which prunes.
      while (far.clock.t < to) {
        await far.step();
        far.view.prune(far.clock.t);
      }
    };
    await stepPruned(5 * MIN);
    expect(far.view.acknowledge("s1")).toBe(1);
    await stepPruned(20 * MIN);
    // Last heard of in the roster at 20:00.
    const lastHeard = far.clock.t;
    expect(far.view.list(lastHeard)).toMatchObject([{ acknowledged: true, lastSeen: lastHeard }]);
    far.tunnelDown();
    await stepPruned(60 * MIN);
    far.answer();
    await stepPruned(upAt);
    far.tunnelUp();
    await stepPruned(blockAgainAt);
    const rung = far.doorbells.length;
    far.block();
    await stepPruned(blockAgainAt + 2 * MIN);
    return { far, lastHeard, again: far.doorbells.slice(rung) };
  }

  it("blocked again after the TTL from when it was last heard of: alerts, listed as new", async () => {
    const { far, lastHeard, again } = await sleepThenBlockAgain(110 * MIN, 150 * MIN);
    expect(lastHeard + 2 * HOUR).toBeLessThan(150 * MIN);
    expect(again[0]).toMatchObject({ kind: "blocked", alerted: true });
    const [entry, ...rest] = far.view.list(far.clock.t);
    expect(rest).toEqual([]);
    expect(entry?.acknowledged).toBe(false);
    // Its own wait, not the old block's: dated where the far daemon dates it,
    // a few seconds before its Notification (MOD-05).
    expect(entry?.since).toBeGreaterThanOrEqual(150 * MIN - 10 * SEC);
    expect(entry?.since).toBeLessThanOrEqual(150 * MIN + SEC);
    expect(far.view.blockedCount()).toBe(1);
  });

  it("blocked again inside it: taken for the dismissed block, which nothing removed", async () => {
    const { far, again } = await sleepThenBlockAgain(90 * MIN, 100 * MIN);
    expect(again[0]).toMatchObject({ kind: "blocked", alerted: false });
    expect(far.view.list(far.clock.t)).toMatchObject([{ acknowledged: true, since: 0 }]);
    expect(far.view.blockedCount()).toBe(0);
  });
});

describe("#98 — the roster says which agents are blocked", () => {
  it("names each announced blocked agent under its session, how long it has waited, and nothing for the rest", () => {
    let t = 0;
    const registry = new Registry({ nowMs: () => t });
    registry.apply(
      ev("notification", { sessionId: "s1", agentId: "s1", notificationKind: "permission_prompt" }),
      "/r",
    );
    registry.apply(ev("pre_tool", { sessionId: "s2", agentId: "s2" }), "/r2");
    t = 10 * SEC;
    registry.markAnnounced("s1", "s1", t);
    t = 4 * MIN;
    const r = rosterOf(registry, FAR);
    expect(r.host).toBe(FAR);
    expect(r.namesBlocked).toBe(true);
    const byId = new Map(r.sessions.map((s) => [s.sessionId, s]));
    expect(byId.get("s1")?.blocked).toEqual(["s1"]);
    const [forMs] = byId.get("s1")?.blockedForMs ?? [];
    expect(forMs).toBe(registry.blockedAgents()[0]?.blockedForMs);
    expect(forMs).toBeGreaterThanOrEqual(4 * MIN);
    expect(byId.get("s2")?.blocked).toBeUndefined();
    expect(byId.get("s2")?.blockedForMs).toBeUndefined();
    expect(byId.get("s2")?.cwd).toBe("/r2");
  });

  it("leaves out a block its loop has not announced: the far end must not list what the dwell may yet clear", () => {
    const registry = new Registry({ nowMs: () => 0 });
    registry.apply(
      ev("notification", { sessionId: "s1", agentId: "s1", notificationKind: "permission_prompt" }),
      "/r",
    );
    expect(rosterOf(registry, FAR).sessions[0]?.blocked).toBeUndefined();
  });

  it("says it names blocked agents even when none is", () => {
    const r = rosterOf(new Registry({ nowMs: () => 0 }), FAR);
    expect(r).toEqual({ host: FAR, namesBlocked: true, sessions: [] });
  });

  it("leaves out an agent dismissed on its own machine: that block is over there, and its resolved says so", () => {
    const registry = new Registry({ nowMs: () => 0 });
    registry.apply(
      ev("notification", { sessionId: "s1", agentId: "s1", notificationKind: "permission_prompt" }),
      "/r",
    );
    registry.markAnnounced("s1", "s1", 0);
    registry.acknowledge("s1");
    expect(rosterOf(registry, FAR).sessions[0]?.blocked).toBeUndefined();
  });

  it("survives validation, bounded, and with anything that is not an id dropped", () => {
    const many = Array.from({ length: MAX_BLOCKED_PER_SESSION + 5 }, (_, i) => `a${i}`);
    const r = validateRoster({
      host: FAR,
      namesBlocked: true,
      sessions: [
        { sessionId: "s1", cwd: "/x", blocked: ["a1", 7, null, "a2"], blockedForMs: [1_000, 2, 3, 4_000] },
        { sessionId: "s2", cwd: "/y", blocked: many, blockedForMs: many.map(() => 5) },
        { sessionId: "s3", cwd: "/z", blocked: "a1" },
        { sessionId: "s4", cwd: "/w" },
        // A duration that is not one, or one too few: none is believed.
        { sessionId: "s5", cwd: "/v", blocked: ["a1", "a2"], blockedForMs: [1_000, -1] },
        { sessionId: "s6", cwd: "/u", blocked: ["a1", "a2"], blockedForMs: [1_000] },
        { sessionId: "s7", cwd: "/t", blocked: ["a1"], blockedForMs: ["1000"] },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.roster.namesBlocked).toBe(true);
    const [s1, s2, s3, s4, s5, s6, s7] = r.roster.sessions;
    expect(s1?.blocked).toEqual(["a1", "a2"]);
    expect(s1?.blockedForMs).toEqual([1_000, 4_000]);
    expect(s2?.blocked).toHaveLength(MAX_BLOCKED_PER_SESSION);
    expect(s2?.blockedForMs).toHaveLength(MAX_BLOCKED_PER_SESSION);
    expect(s3?.blocked).toBeUndefined();
    expect(s4?.blocked).toBeUndefined();
    for (const s of [s5, s6, s7]) {
      expect(s?.blocked).toEqual(s === s7 ? ["a1"] : ["a1", "a2"]);
      expect(s?.blockedForMs).toBeUndefined();
    }
  });

  it("a roster that does not say it names blocked agents is read as not saying", () => {
    for (const namesBlocked of [undefined, false, "yes", 1]) {
      const r = validateRoster({ host: FAR, namesBlocked, sessions: [] });
      expect(r.ok && r.roster.namesBlocked).toBeFalsy();
    }
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
    ).json()) as {
      blockedCount: number;
      agents: { host: string; sessionId: string; agentId: string; since: number; stale?: boolean }[];
    };

  const envelope = (kind: "blocked" | "resolved", host = "megabrain"): NotifyEnvelope =>
    buildEnvelope({
      kind,
      reason: "permission_prompt",
      sessionId: "s1",
      agentId: "a1",
      cwd: "/srv/astir",
      host,
    });
  const blockedRoster = (forMs?: number) => ({
    host: FAR,
    namesBlocked: true,
    sessions: [
      {
        sessionId: "s1",
        cwd: "/srv/astir",
        name: null,
        status: "busy",
        blocked: ["a1"],
        ...(forMs === undefined ? {} : { blockedForMs: [forMs] }),
      },
    ],
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

    expect((await post(port, "/roster", blockedRoster())).status).toBe(200);
    const after = await state(port);
    expect(after.agents).toHaveLength(1);
    expect(after.agents[0]?.stale).toBe(false);
    expect(after.blockedCount).toBe(1);
  });

  it("a block it hears of from a roster alone is listed and shows nothing; its next reminder shows once", async () => {
    const clock = { t: 5 * HOUR };
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
      now: () => clock.t,
    });
    open.push(server);
    const port = await server.listen(0);

    expect((await post(port, "/roster", blockedRoster(40 * MIN))).status).toBe(200);
    expect(shown).toEqual([]);
    expect(server.snapshot().delivered).toBe(0);
    const listed = await state(port);
    expect(listed.blockedCount).toBe(1);
    expect(listed.agents).toHaveLength(1);
    expect(listed.agents[0]).toMatchObject({
      host: "megabrain",
      sessionId: "s1",
      agentId: "a1",
      since: clock.t - 40 * MIN,
      stale: false,
    });

    clock.t += 20 * MIN;
    expect((await post(port, "/notify", envelope("blocked"))).status).toBe(200);
    expect(shown.map((n) => n.group)).toEqual(["megabrain/s1:a1"]);
    expect((await state(port)).agents).toHaveLength(1);

    // A roster that stops naming it removes nothing; its `resolved` does,
    // and withdraws its alert.
    clock.t += MIN;
    expect((await post(port, "/roster", { ...blockedRoster(), sessions: [] })).status).toBe(200);
    expect(await state(port)).toMatchObject({
      blockedCount: 1,
      agents: [{ sessionId: "s1", agentId: "a1" }],
    });
    expect((await post(port, "/notify", envelope("resolved"))).status).toBe(200);
    expect(await state(port)).toMatchObject({ blockedCount: 0, agents: [] });
    expect(removed).toEqual(["megabrain/s1:a1"]);
    expect(shown).toHaveLength(1);
  });

  it("R98-14 — each agent a roster names is listed with its own wait, after validation drops what is not an id", async () => {
    const clock = { t: 5 * HOUR };
    const server = new NotifierServer({
      token: TOKEN,
      notify: () => undefined,
      host: "the-mac",
      now: () => clock.t,
    });
    open.push(server);
    const port = await server.listen(0);

    const sent = await post(port, "/roster", {
      host: FAR,
      namesBlocked: true,
      sessions: [
        {
          sessionId: "s1",
          cwd: "/srv/astir",
          name: null,
          status: "busy",
          blocked: ["a1", 7, "a2", "a3"],
          blockedForMs: [40 * MIN, 1, 5 * MIN, 90 * MIN],
        },
        {
          sessionId: "s2",
          cwd: "/srv/other",
          name: null,
          status: "busy",
          blocked: ["b1", "b2"],
          blockedForMs: [20 * MIN, 70 * MIN],
        },
      ],
    });
    expect(sent.status).toBe(200);
    const listed = await state(port);
    expect(
      Object.fromEntries(listed.agents.map((a) => [`${a.host}/${a.sessionId}:${a.agentId}`, a.since])),
    ).toEqual({
      "megabrain/s1:a1": clock.t - 40 * MIN,
      "megabrain/s1:a2": clock.t - 5 * MIN,
      "megabrain/s1:a3": clock.t - 90 * MIN,
      "megabrain/s2:b1": clock.t - 20 * MIN,
      "megabrain/s2:b2": clock.t - 70 * MIN,
    });
    expect(listed.blockedCount).toBe(5);
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

  it("DOC-2 — never takes the group of this machine's own alert, which carries the click action", async () => {
    // A daemon attaches whatever notifier answers on its loopback port, so on
    // a Mac running both, every local doorbell reaches the notifier too. The
    // local path shows it as `s1:a1` with a click that focuses the session;
    // the notifier's copy has no click, and under the same group it would
    // replace the one that does.
    const shown: Notification[] = [];
    const server = new NotifierServer({
      token: TOKEN,
      notify: async (n) => {
        shown.push(n);
        return { ok: true };
      },
      host: "the-mac.local",
    });
    open.push(server);
    const port = await server.listen(0);

    const fromHere = envelope("blocked", "the-mac");
    expect((await post(port, "/notify", fromHere)).status).toBe(200);
    expect(notificationGroup(fromHere)).toBe("s1:a1");
    expect(shown.map((n) => n.group)).toEqual(["the-mac/s1:a1"]);
    expect(notificationGroup(fromHere, { byHost: true })).toBe("the-mac/s1:a1");
  });

  it("DMN-10 — a roster this machine sent itself lists nothing", async () => {
    // A daemon reaches the notifier on its own machine too, and its roster is
    // refused there (`ignored: "self"`). The view must be left as it was: no
    // agent of this machine listed from it.
    const clock = { t: 0 };
    const server = new NotifierServer({
      token: TOKEN,
      notify: () => undefined,
      host: "the-mac",
      now: () => clock.t,
    });
    open.push(server);
    const port = await server.listen(0);

    expect((await post(port, "/notify", envelope("blocked", "the-mac"))).status).toBe(200);
    clock.t = MIN;
    const self = await post(port, "/roster", {
      host: "the-mac",
      namesBlocked: true,
      sessions: [{ sessionId: "s2", cwd: "/srv/other", name: null, status: "busy", blocked: ["a2"] }],
    });
    expect(await self.json()).toEqual({ ok: true, ignored: "self" });
    expect(server.snapshot()).toMatchObject({ selfRosters: 1, rosters: 0 });
    const after = await state(port);
    expect(after.agents.map((a) => `${a.host}/${a.sessionId}:${a.agentId}`)).toEqual(["the-mac/s1:a1"]);
    expect(after.blockedCount).toBe(1);
  });
});
