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
 * the agents blocked on its machine, and it is what the view's list follows:
 * an agent a roster names is listed, silently if no doorbell announced it
 * here, and one a later roster from the same machine stops naming is retired.
 * Doorbells stay the alert channel, on the daemon's schedule. Silence still
 * means what it meant: a machine whose rosters stop goes stale, then expires.
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
  ] as const)(
    "$schedule: a notifier restarted mid-block lists the agent again from the next roster, alerting nothing",
    async ({ schedule, restartAt }) => {
      const far = farMachine(schedule);
      far.block();
      await far.runTo(restartAt);
      far.restartNotifier();
      const rung = far.doorbells.length;

      await far.runTo(restartAt + ROSTER_EVERY);
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

      // And listed from then on, never as lost contact, with no doorbell
      // needed: calm's next is at +90, `off` has none.
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
      expect(far.doorbells).toHaveLength(rung);
    },
    30_000,
  );

  it.each(["calm", "off"] as const)(
    "%s: a tunnel that comes up after the first alert lists the agent from the next roster, replaying nothing",
    async (schedule) => {
      const far = farMachine(schedule, { tunnel: false });
      far.block();
      await far.runTo(2 * MIN);
      // The first alert went out and reached no one here.
      expect(far.doorbells).toEqual([]);
      expect(far.view.list(far.clock.t)).toEqual([]);

      far.tunnelUp();
      await far.runTo(2 * MIN + ROSTER_EVERY);
      expect(far.view.list(far.clock.t)).toHaveLength(1);
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

  it("a block that ended while its resolved was lost is retired by the first roster after", async () => {
    const far = farMachine("off");
    far.block();
    await far.runTo(5 * MIN);
    expect(far.view.list(far.clock.t)).toHaveLength(1);

    far.tunnelDown();
    far.answer();
    await far.runTo(6 * MIN);
    // The `resolved` went out into the dropped tunnel.
    expect(far.doorbells.map((d) => d.kind)).toEqual(["blocked"]);
    expect(far.view.list(far.clock.t)).toHaveLength(1);

    far.tunnelUp();
    await far.runTo(6 * MIN + ROSTER_EVERY);
    expect(far.view.list(far.clock.t)).toEqual([]);
    expect(lineAt(far.view, far.clock.t, far.store).blocked).toBe(0);
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

  it("hears an agent the roster names as blocked: its host matched however either end spells it", () => {
    const view = new RemoteView();
    view.apply(blocked(), 0);
    view.confirm(roster([session(["a1"])], "MEGABRAIN.example.net"), 30 * MIN);
    expect(view.list(30 * MIN)).toHaveLength(1);
    expect(view.list(30 * MIN)[0]?.stale).toBe(false);
    expect(view.list(30 * MIN)[0]?.lastSeen).toBe(30 * MIN);
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
    rosterFirst.confirm(roster([session(["a1"])], "MEGABRAIN.example.net"), 0);
    expect(rosterFirst.apply(blocked(), SEC).notify).toBe(true);
    expect(rosterFirst.list(SEC)).toHaveLength(1);

    const doorbellFirst = new RemoteView();
    expect(doorbellFirst.apply(blocked(), 0).notify).toBe(true);
    doorbellFirst.confirm(roster([session(["a1"])]), SEC);
    expect(doorbellFirst.list(SEC)).toHaveLength(1);
  });

  it("retires an agent a later roster from its machine no longer names", () => {
    for (const later of [
      roster([session()]),
      roster([{ ...session(["a2"]), status: "idle" }]),
      roster([{ ...session(["a1"]), sessionId: "s2" }]),
      roster([]),
    ]) {
      const view = new RemoteView();
      view.confirm(roster([session(["a1"])]), 0);
      view.confirm(later, ROSTER_EVERY);
      expect(view.list(ROSTER_EVERY).filter((a) => a.agentId === "a1" && a.sessionId === "s1")).toEqual([]);
    }
  });

  /**
   * How long a doorbell outranks a roster: three of the daemon's roster
   * ticks, well past its 5 s push timeout. Written out rather than imported,
   * so a change to it fails here.
   */
  const DOORBELL_WINS = 30 * SEC;

  it("retires a doorbell's block too, once a roster could have heard of it: 30 s on", () => {
    // A roster built a moment before the block was announced can arrive
    // after its doorbell; it is not news that the block ended.
    const view = new RemoteView();
    view.apply(blocked(), 0);
    view.confirm(roster([session()]), 2 * SEC);
    expect(view.list(2 * SEC)).toHaveLength(1);
    view.confirm(roster([session()]), DOORBELL_WINS - SEC);
    expect(view.list(DOORBELL_WINS - SEC)).toHaveLength(1);
    view.confirm(roster([session()]), DOORBELL_WINS);
    expect(view.list(DOORBELL_WINS)).toEqual([]);
  });

  it("each reminder outranks a roster again, a block a roster listed included", () => {
    const view = new RemoteView();
    view.confirm(roster([session(["a1"])]), 0);
    expect(view.apply(blocked(), HOUR).notify).toBe(true);
    view.confirm(roster([session()]), HOUR + 2 * SEC);
    expect(view.list(HOUR + 2 * SEC)).toHaveLength(1);
    view.confirm(roster([session()]), HOUR + DOORBELL_WINS - SEC);
    expect(view.list(HOUR + DOORBELL_WINS - SEC)).toHaveLength(1);
    view.confirm(roster([session()]), HOUR + DOORBELL_WINS);
    expect(view.list(HOUR + DOORBELL_WINS)).toEqual([]);
  });

  it("does not bring back a block whose resolved overtook the roster, for 30 s", () => {
    const view = new RemoteView();
    view.apply(blocked(), 0);
    view.apply(blocked({ kind: "resolved" }), MIN);
    view.confirm(roster([session(["a1"])]), MIN + SEC);
    expect(view.list(MIN + SEC)).toEqual([]);
    view.confirm(roster([session(["a1"])]), MIN + DOORBELL_WINS - SEC);
    expect(view.list(MIN + DOORBELL_WINS - SEC)).toEqual([]);
    // Named again after that, it is blocked again.
    view.confirm(roster([session(["a1"])]), MIN + DOORBELL_WINS);
    expect(view.list(MIN + DOORBELL_WINS)).toHaveLength(1);
  });

  it("another machine's roster neither hears nor retires it", () => {
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

  it("an older daemon's roster neither lists, nor hears, nor retires", () => {
    const view = new RemoteView();
    view.confirm(olderRoster([session(["a1"])]), 0);
    expect(view.list(0)).toEqual([]);

    view.apply(blocked(), 0);
    view.confirm(olderRoster([session(["a1"])]), 30 * MIN);
    expect(view.list(30 * MIN)[0]?.stale).toBe(true);
    view.confirm(olderRoster([]), 31 * MIN);
    expect(view.list(31 * MIN)).toHaveLength(1);
  });

  it("keeps a dismissed agent dismissed", () => {
    const view = new RemoteView();
    view.apply(blocked(), 0);
    view.acknowledge();
    view.confirm(roster([session(["a1"])]), 30 * MIN);
    expect(view.list(30 * MIN)[0]?.acknowledged).toBe(true);
    expect(view.blockedCount()).toBe(0);
  });

  /**
   * R98-3 — the far daemon restarts mid-block. Its restored block is not
   * named again until its loop has announced it again (`announcedAt` is not
   * persisted), so a roster in between retires the agent here, and the
   * doorbell that announces it again is the old block's, not a new one.
   */
  const dismissedThenRetired = (): RemoteView => {
    const view = new RemoteView();
    view.apply(blocked(), 0);
    expect(view.acknowledge("s1")).toBe(1);
    view.confirm(roster([session()]), 45 * MIN);
    expect(view.list(45 * MIN)).toEqual([]);
    return view;
  };

  it("a dismissal outlives a roster retiring the agent: announced again, it shows nothing and stays dismissed", () => {
    const view = dismissedThenRetired();
    const t = 45 * MIN + 40 * SEC;
    expect(view.apply(blocked(), t).notify).toBe(false);
    expect(view.list(t)).toMatchObject([{ sessionId: "s1", agentId: "a1", acknowledged: true, since: 0 }]);
    expect(view.blockedCount()).toBe(0);
    // And its reminders after that, as for any dismissed agent.
    expect(view.apply(blocked(), t + 10 * MIN).notify).toBe(false);
  });

  it("a dismissal outlives a roster retiring the agent: named again by a roster first, it is listed dismissed", () => {
    const view = dismissedThenRetired();
    const t = 45 * MIN + 40 * SEC;
    view.confirm(roster([session(["a1"], [t])]), t);
    expect(view.list(t)).toMatchObject([{ sessionId: "s1", agentId: "a1", acknowledged: true, since: 0 }]);
    expect(view.blockedCount()).toBe(0);
    expect(view.apply(blocked(), t + SEC).notify).toBe(false);
  });

  it("a resolved ends a retired agent's dismissal with its block: the next block alerts", () => {
    const view = dismissedThenRetired();
    expect(view.apply(blocked({ kind: "resolved" }), 46 * MIN).notify).toBe(false);
    expect(view.apply(blocked(), 50 * MIN).notify).toBe(true);
    expect(view.list(50 * MIN)).toMatchObject([{ acknowledged: false, since: 50 * MIN }]);
    expect(view.blockedCount()).toBe(1);
  });

  it("forgetting the session ends a retired agent's dismissal, as it does a listed one's", () => {
    const view = dismissedThenRetired();
    view.forget("s1");
    expect(view.apply(blocked(), 46 * MIN).notify).toBe(true);
    expect(view.blockedCount()).toBe(1);
  });

  it("a retired agent's dismissal is kept no longer than an entry not heard of would be", () => {
    const within = dismissedThenRetired();
    expect(within.apply(blocked(), 45 * MIN + 2 * HOUR - SEC).notify).toBe(false);

    const after = dismissedThenRetired();
    after.prune(45 * MIN + 2 * HOUR);
    expect(after.apply(blocked(), 45 * MIN + 2 * HOUR).notify).toBe(true);
    const unpruned = dismissedThenRetired();
    expect(unpruned.apply(blocked(), 45 * MIN + 2 * HOUR).notify).toBe(true);
  });

  it("an agent never dismissed, retired by a roster and announced again, alerts again", () => {
    const view = new RemoteView();
    view.apply(blocked(), 0);
    view.confirm(roster([session()]), 45 * MIN);
    expect(view.list(45 * MIN)).toEqual([]);
    expect(view.apply(blocked(), 45 * MIN + 40 * SEC).notify).toBe(true);
    expect(view.blockedCount()).toBe(1);
  });

  it("a dismissal is remembered only for its own agent", () => {
    const view = dismissedThenRetired();
    expect(view.apply(blocked({ agentId: "a2" }), 46 * MIN).notify).toBe(true);
    expect(view.apply(blocked({ sessionId: "s2" }), 46 * MIN).notify).toBe(true);
    expect(view.apply(blocked({ host: "buildbox" }), 46 * MIN).notify).toBe(true);
    expect(view.apply(blocked(), 46 * MIN).notify).toBe(false);
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
 * Claude's 5 s with discovery slow enough for a roster to land first.
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
      view.confirm(rosterOf(far.registry, FAR), clock.t);
    }
    if (clock.t > 45 * MIN && view.list(clock.t).length === 0) unlistedAfterRestart = true;
  }
  return { view, alerted, unlistedAfterRestart, t: clock.t };
}

describe("#98 — a dismissal here outlives the far daemon restarting", () => {
  it.each([
    { schedule: "calm", dwellMs: 30 * SEC, discoveryMs: SEC },
    { schedule: "calm", dwellMs: 30 * SEC, discoveryMs: 3 * SEC },
    { schedule: "off", dwellMs: 30 * SEC, discoveryMs: SEC },
    { schedule: "insistent", dwellMs: 30 * SEC, discoveryMs: SEC },
    { schedule: "calm", dwellMs: 5 * SEC, discoveryMs: 6 * SEC },
  ] as const)(
    "$schedule, dwell $dwellMs ms, discovered $discoveryMs ms after the restart: nothing alerts again",
    async ({ schedule, dwellMs, discoveryMs }) => {
      const { view, alerted, unlistedAfterRestart, t } = await dismissedThenFarRestart(
        schedule,
        dwellMs,
        discoveryMs,
      );
      // The first alert, before the dismissal; and the restart did open the
      // window in which a roster no longer named the agent.
      expect(alerted.filter((at) => at < 5 * MIN).length).toBeGreaterThan(0);
      expect(unlistedAfterRestart).toBe(true);

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

  it("says it names blocked agents even when none is, so the far end can retire one", () => {
    const r = rosterOf(new Registry({ nowMs: () => 0 }), FAR);
    expect(r).toEqual({ host: FAR, namesBlocked: true, sessions: [] });
  });

  it("leaves out an agent dismissed on its own machine: that block is retired, with a resolved", () => {
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
    const server = new NotifierServer({
      token: TOKEN,
      notify: async (n) => {
        shown.push(n);
        return { ok: true };
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

    // And the roster that stops naming it, a while on, retires it.
    clock.t += MIN;
    expect((await post(port, "/roster", { ...blockedRoster(), sessions: [] })).status).toBe(200);
    expect(await state(port)).toMatchObject({ blockedCount: 0, agents: [] });
    expect(shown).toHaveLength(1);
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

  it("DMN-10 — a roster this machine sent itself neither lists nor retires anything", async () => {
    // A daemon reaches the notifier on its own machine too, and its roster is
    // refused there (`ignored: "self"`). The view must be left as it was: no
    // agent of this machine listed from it, none retired by it.
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
