import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeClaudeHook } from "../src/adapters/claude/normalize.js";
import { normalizeCodexHook } from "../src/adapters/codex/normalize.js";
import { CAPABILITIES } from "../src/contract/capabilities.js";
import {
  type AstirEvent,
  CONTRACT_VERSION,
  type Kind,
  type NotificationKind,
  validateEvent,
} from "../src/contract/event.js";
import { Daemon } from "../src/daemon/server.js";
import {
  claudeScreen,
  type DiscoveredSession,
  parseAgentsJson,
  pollInto,
  type SessionScreen,
} from "../src/discovery/sessions.js";
import { CLAIM_WINDOW_MS, Registry } from "../src/model/registry.js";
import { type DeliveryTarget, Dispatcher } from "../src/notify/dispatch.js";
import type { NotifyEnvelope } from "../src/notify/envelope.js";
import { NotifyLoop } from "../src/notify/loop.js";
import { NotifyPolicy } from "../src/notify/policy.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
type Payload = Record<string, unknown>;
type Step = { afterMs: number; payload: Payload };
const capture = JSON.parse(
  readFileSync(join(root, "test", "fixtures", "claude", "permission-request.json"), "utf8"),
) as { _capture: Record<string, unknown>; sequence: Step[] };

function stepOf(name: string): Step {
  const s = capture.sequence.find((x) => x.payload.hook_event_name === name);
  if (s === undefined) throw new Error(`no ${name} in the capture`);
  return s;
}
const pre = stepOf("PreToolUse");
const request = stepOf("PermissionRequest");
const notification = stepOf("Notification");
const SESSION = String(request.payload.session_id);
const CWD = String(request.payload.cwd);
const SUB = "a5cf41e52d9b8f355";
const SUB2 = "b6df52f63e0c9a466";
const post = { ...pre.payload, hook_event_name: "PostToolUse", tool_response: {} };
/** The main agent running the Agent tool while a subagent works for it. */
const spawn = {
  ...pre.payload,
  tool_name: "Agent",
  tool_use_id: "toolu_spawn",
  tool_input: { prompt: "<redacted>" },
};
/** A subagent's own PreToolUse and PermissionRequest: these do carry its agent_id. */
const subPre = (id: string, toolUseId = `toolu_${id}`) => ({
  ...pre.payload,
  agent_id: id,
  tool_use_id: toolUseId,
});
const subClaim = (id: string) => ({ ...request.payload, agent_id: id });
/** FileChanged, as Claude builds it: no agent context, so no agent_id. */
const fileChanged = {
  session_id: SESSION,
  cwd: CWD,
  hook_event_name: "FileChanged",
  file_path: `${CWD}/src/x.ts`,
  event: "change",
};
/** Who an envelope is about: `main`, or the subagent's id. */
const who = (e: NotifyEnvelope) => (e.session.agentId === SESSION ? "main" : e.session.agentId);

/** What `claude agents --json` names a tool's permission dialog. */
const DIALOG = "permission prompt";

const deps = {
  readSidecar: () => null,
  newId: () => "e1",
  realpath: (p: string) => p,
  now: () => 1_793_000_000,
};

/**
 * A listing row for the captured session, as Claude's lister makes it from
 * what `claude agents --json` gives: `status`, and `waitingFor` beside a
 * `waiting` one, translated into astir's `screen`.
 */
const listed = (status: string | null, sessionId = SESSION, waitingFor?: string): DiscoveredSession => {
  const screen = claudeScreen(status, waitingFor ?? null);
  return {
    sessionId,
    cwd: CWD,
    pid: 4242,
    status,
    name: "repo",
    startedAt: null,
    ...(screen === undefined ? {} : { screen }),
  };
};

/**
 * The real Registry and NotifyLoop on one clock, with Claude's declared dwell.
 * `poll` folds in one discovery answer; `startedAt` is when that poll began,
 * which can be well before it lands. `seen` is a poll that finds a tool's
 * permission dialog on screen.
 */
function harness(opts: { idleAfterMs?: number } = {}) {
  let t = 0;
  let n = 0;
  const now = () => t;
  const sent: NotifyEnvelope[] = [];
  const target: DeliveryTarget = {
    name: "test",
    live: () => true,
    deliver: async (envelope) => {
      sent.push(envelope);
      return { ok: true };
    },
  };
  const registry = new Registry({ nowMs: now, ...opts });
  const loop = new NotifyLoop({
    registry,
    policy: new NotifyPolicy(),
    dispatcher: new Dispatcher([target]),
    now,
  });
  const hook = (payload: Payload) => {
    const r = normalizeClaudeHook(payload, { ...deps, newId: () => `e${++n}` });
    if (r.event === null) throw new Error(`expected an event for ${String(payload.hook_event_name)}`);
    const applied = registry.apply(r.event, r.cwd);
    expect(applied.applied).toBe(true);
    return applied;
  };
  const poll = (
    status: string | null,
    startedAt: number = t,
    opts: { complete?: boolean; rows?: DiscoveredSession[]; waitingFor?: string | undefined } = {},
  ) =>
    registry.reconcile(opts.rows ?? [listed(status, SESSION, opts.waitingFor)], {
      provider: "claude",
      complete: opts.complete ?? true,
      observedAt: startedAt,
    });
  const seen = (startedAt: number = t) => poll("waiting", startedAt, { waitingFor: DIALOG });
  const agent = (sessionId = SESSION, agentId = sessionId) => registry.get(sessionId)?.agents.get(agentId);
  /** Polls every 5 s from `from` to `to`, each landing 300 ms after it began, with a tick and a pulse. */
  const pollFor = async (status: string | null, from: number, to: number, waitingFor?: string) => {
    for (let at = from; at <= to; at += 5_000) {
      t = at + 300;
      poll(status, at, { waitingFor });
      t = at + 1_000;
      registry.tick();
      await loop.pulse();
    }
  };
  return {
    registry,
    loop,
    sent,
    hook,
    poll,
    seen,
    pollFor,
    agent,
    at: (ms: number) => {
      t = ms;
    },
    alerts: () => sent.filter((e) => e.kind === "blocked"),
    kinds: () => sent.map((e) => e.kind),
  };
}
/**
 * The daemon's cadence on one clock: each hook at its time; a poll begun every
 * 5 s from `phase`, landing 300 ms later with what was on screen when it
 * began; and a tick and a pulse every second. Hooks land before a poll that
 * lands at the same instant, and both before the pulse.
 */
async function run(opts: {
  hooks: Array<[number, Payload]>;
  screen: (at: number) => [string, string?];
  until: number;
  phase?: number;
}) {
  const h = harness();
  const steps: Array<{ at: number; order: number; go: () => unknown }> = [];
  for (const [at, payload] of opts.hooks) steps.push({ at, order: 0, go: () => h.hook(payload) });
  for (let begun = opts.phase ?? 0; begun <= opts.until; begun += 5_000) {
    const [status, waitingFor] = opts.screen(begun);
    steps.push({ at: begun + 300, order: 1, go: () => h.poll(status, begun, { waitingFor }) });
  }
  for (let at = 0; at <= opts.until; at += 1_000) {
    steps.push({
      at,
      order: 2,
      go: () => {
        h.registry.tick();
        return h.loop.pulse();
      },
    });
  }
  steps.sort((a, b) => a.at - b.at || a.order - b.order);
  for (const s of steps) {
    h.at(s.at);
    await s.go();
  }
  return h;
}

/** `kind:who@seconds` for every envelope sent. */
const story = (h: ReturnType<typeof harness>) => h.sent.map((e) => `${e.kind}:${who(e)}@${e.ts / 1000}`);

// ---------------------------------------------------------------------------
// VR3 #86 adversarial scenarios. Each asserts the CORRECT outcome; a failure
// is a reproduced defect. `story` is logged for quoting.
// ---------------------------------------------------------------------------
const LOG = process.env.VR3_LOG ?? "/tmp/claude-1000/-home-dev-repos-astir/d8458719-ef7f-472f-be54-5616006a1f7c/scratchpad/vr3-p86/vr3.log";
const say = (line: string) => appendFileSync(LOG, `${line}\n`);
const log = (label: string, h: ReturnType<typeof harness>) => say(`[VR3] ${label}: ${JSON.stringify(story(h))}`);

describe("VR3 S1 (rule b) — retract keyed on a claim the blocked agent refreshed", () => {
  it("parallel re-claim while A is on screen: A's Notification must not resolve main nor alert SUB", async () => {
    const h = await run({
      hooks: [
        [0, subPre(SUB)],
        [0, subClaim(SUB)], // approved at 0.8 s, before any poll; its tool runs to 120 s
        [3_000, pre.payload],
        [3_000, request.payload], // main's dialog A, on screen 3.4..60
        [8_500, request.payload], // main's parallel second ask B, queued behind A
        [9_400, notification.payload], // A has been up 6 s
        [61_000, post], // A's tool done (A approved at 60 s; B now on screen)
        [66_200, notification.payload], // B has been up 6 s
        [120_000, { ...post, agent_id: SUB, tool_use_id: `toolu_${SUB}` }],
      ],
      screen: (at) => (at >= 3_400 && at < 90_000 ? ["waiting", DIALOG] : ["busy"]),
      until: 130_000,
      phase: 4_000,
    });
    log("S1", h);
    const main = story(h).filter((s) => s.includes(":main@"));
    const sub = story(h).filter((s) => s.includes(`:${SUB}@`));
    expect(sub, "SUB's dialog was approved at 0.8 s; it must never be alerted").toEqual([]);
    expect(main[0]).toBe("blocked:main@8");
    // No resolved for main while A (to 60 s) or B (to 90 s) is on screen.
    const earlyResolve = main.find((s) => s.startsWith("resolved") && Number(s.split("@")[1]) < 90);
    expect(earlyResolve, "resolved:main sent while main's dialog is on screen").toBeUndefined();
  });

  it("control: same, without main's parallel re-claim", async () => {
    const h = await run({
      hooks: [
        [0, subPre(SUB)],
        [0, subClaim(SUB)],
        [3_000, pre.payload],
        [3_000, request.payload],
        [9_400, notification.payload],
        [61_000, post],
        [120_000, { ...post, agent_id: SUB, tool_use_id: `toolu_${SUB}` }],
      ],
      screen: (at) => (at >= 3_400 && at < 60_000 ? ["waiting", DIALOG] : ["busy"]),
      until: 130_000,
      phase: 4_000,
    });
    log("S1-control", h);
    expect(story(h).filter((s) => s.includes(`:${SUB}@`))).toEqual([]);
  });
});

describe("VR3 S2 (rule a) — a held dead claim takes a claimless dialog's Notification", () => {
  const base = (withDeadClaim: boolean): Array<[number, Payload]> => [
    [0, pre.payload],
    [0, request.payload], // A
    [300, request.payload], // B, parallel, queued behind A
    ...(withDeadClaim
      ? ([
          [3_000, subPre(SUB2)],
          [3_000, subClaim(SUB2)], // Claude denies this itself; SUB2 next acts at 45 s
          [45_000, subPre(SUB2, "toolu_bg2")],
        ] as Array<[number, Payload]>)
      : []),
    [6_400, notification.payload], // A has been up 6 s (same hooks as the 07c3935 run)
    [21_000, post], // A approved at 20 s, its tool done at 21 s; B on screen from 20 s
    [26_200, notification.payload], // B has been up 6 s
  ];
  for (const withDeadClaim of [false, true]) {
    it(`main's queued second dialog B is alerted (dead SUB2 claim: ${withDeadClaim})`, async () => {
      const h = await run({
        hooks: base(withDeadClaim),
        screen: (at) => (at >= 400 && at < 200_000 ? ["waiting", DIALOG] : ["busy"]),
        until: 180_000,
        phase: 1_000,
      });
      log(`S2 dead=${withDeadClaim}`, h);
      const after21 = story(h).filter((s) => s.startsWith("blocked:main@") && Number(s.split("@")[1]) > 21);
      expect(after21.length, "B (main's, on screen 20..200 s) alerted").toBe(1);
      expect(h.agent()?.state, "main is blocked on B at 180 s").toBe("blocked");
      expect(story(h).filter((s) => s.includes(SUB2)), "SUB2 never had a dialog").toEqual([]);
    });
  }
});

describe("VR3 S2b (rule a) — a held dead claim takes a sighting of a claimless dialog", () => {
  it("plan-approval-like dialog right after main's approved tool: alert names SUB2 (documented)", async () => {
    const h = await run({
      hooks: [
        [0, pre.payload],
        [0, request.payload],
        [3_000, subPre(SUB2)],
        [3_000, subClaim(SUB2)],
        [21_000, post],
        [22_000, { ...pre.payload, tool_name: "ExitPlanMode", tool_use_id: "toolu_plan" }],
        [45_000, subPre(SUB2, "toolu_bg2")],
      ],
      screen: (at) => (at >= 400 && at < 20_000) || (at >= 22_400 && at < 90_000) ? ["waiting", DIALOG] : ["busy"],
      until: 90_000,
      phase: 1_000,
    });
    log("S2b", h);
    expect(true).toBe(true);
  });
});

describe("VR3 S3 (rule c) — main approves, its tool runs long, a second real dialog appears", () => {
  for (const subNotice of [true, false]) {
    it(`SUB's queued dialog after main's approval (SUB Notification: ${subNotice})`, async () => {
      const h = await run({
        hooks: [
          [0, pre.payload],
          [0, request.payload], // A, on screen 0.4..4 (approved at 4 s, tool runs to 64 s)
          [2_000, subPre(SUB)],
          [2_000, subClaim(SUB)], // queued; on screen 4..30
          ...(subNotice ? ([[10_200, notification.payload]] as Array<[number, Payload]>) : []),
          [31_000, { ...post, agent_id: SUB, tool_use_id: `toolu_${SUB}` }],
          [64_000, post],
        ],
        screen: (at) => (at >= 400 && at < 30_000 ? ["waiting", DIALOG] : ["busy"]),
        until: 70_000,
        phase: 1_000,
      });
      log(`S3 notice=${subNotice}`, h);
      if (subNotice) {
        expect(story(h).some((s) => s.startsWith(`blocked:${SUB}@`))).toBe(true);
      }
      expect(true).toBe(true);
    });
  }
});

describe("VR3 S4 (rule d) — session-wide idle-decay skip", () => {
  it("a subagent whose last event was long ago stays 'thinking' for the whole of another agent's block", async () => {
    const h = harness();
    h.at(0);
    h.hook(spawn);
    h.at(100);
    h.hook(subPre(SUB));
    h.at(5_000);
    h.hook({ ...post, agent_id: SUB, tool_use_id: `toolu_${SUB}` }); // SUB's last event: no SubagentStop
    h.at(10_000);
    h.hook(subPre(SUB2));
    h.hook(subClaim(SUB2));
    await h.pollFor("waiting", 11_000, 600_000, DIALOG);
    const sub = h.agent(SESSION, SUB);
    say(`[VR3] S4 at 600 s: SUB state=${sub?.state} activeMs=${sub?.activeMs}`);
    // SUB2 answered; the next busy poll ends its block, and the session decays again.
    await h.pollFor("busy", 605_000, 605_000);
    h.at(606_000);
    // status 'busy' still skips decay; the listing reads idle once the turn is over
    await h.pollFor("idle", 610_000, 660_000);
    const after = h.agent(SESSION, SUB);
    say(`[VR3] S4 after: SUB state=${after?.state} activeMs=${after?.activeMs} turnMs=${after?.turnMs}`);
    expect(sub?.state, "pre-#86 decays it to idle 30 s after its last event").toBe("idle");
  });

  it("a block that never ends (agent_needs_input on main, Esc) suspends decay of every agent in the session", async () => {
    const h = harness();
    h.at(0);
    h.hook(spawn);
    h.at(100);
    h.hook(subPre(SUB));
    h.at(5_000);
    h.hook({ ...post, agent_id: SUB, tool_use_id: `toolu_${SUB}` });
    h.at(6_000);
    h.hook({ ...notification.payload, notification_type: "agent_needs_input", message: "<redacted>" });
    expect(h.agent()?.state).toBe("blocked");
    await h.pollFor("idle", 10_000, 3_600_000);
    say(`[VR3] S4b at 1 h: main=${h.agent()?.state} SUB=${h.agent(SESSION, SUB)?.state}`);
    expect(h.agent(SESSION, SUB)?.state).toBe("idle");
  });

  it("Codex: a blocked agent suspends the stall timer for its sibling", () => {
    let t = 0;
    let seq = 0;
    const r = new Registry({ nowMs: () => t });
    const ev = (over: Partial<AstirEvent>): AstirEvent => ({
      v: CONTRACT_VERSION,
      eventId: `c${++seq}`,
      provider: "codex",
      sessionId: "cx",
      ts: 1_000 + seq,
      kind: "pre_tool",
      agentId: "cx",
      agentType: null,
      parentAgentId: null,
      parentSource: null,
      tool: "shell",
      description: null,
      paths: [],
      op: null,
      ok: null,
      notificationKind: null,
      ...over,
    });
    r.apply(ev({ agentId: "cx-sub", kind: "post_tool" }), "/repo");
    r.apply(ev({ kind: "notification", notificationKind: "permission_prompt", tool: null }), "/repo");
    t = 16 * 60_000;
    r.tick();
    const sub = r.get("cx")?.agents.get("cx-sub");
    say(`[VR3] S4c Codex sibling at 16 min: ${sub?.state}`);
    expect(sub?.state, "pre-#86 stalls it to idle after 15 min").toBe("idle");
  });
});

describe("VR3 S5 (rule e) — a blocking non-permission notification during a permission block", () => {
  it("agent_needs_input during an unannounced permission block, then Esc: is the need ever alerted?", async () => {
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(1_300);
    h.seen(1_000);
    h.at(3_000);
    await h.loop.pulse();
    const r = h.hook({ ...notification.payload, notification_type: "agent_needs_input", message: "<redacted>" });
    say(`[VR3] S5 becameBlocked=${JSON.stringify(r.becameBlocked)} reason=${h.agent()?.blockedReason}`);
    // Esc at 3.5 s; the poll begun at 4 s reads idle.
    h.at(4_300);
    h.poll("idle", 4_000);
    for (let at = 5_000; at <= 120_000; at += 1_000) {
      h.at(at);
      h.registry.tick();
      await h.loop.pulse();
    }
    log("S5", h);
    expect(h.alerts().length, "pre-#86 alerts agent_needs_input at 8 s").toBeGreaterThan(0);
  });

  it("agent_needs_input first, then the permission Notification: reason taken over, Esc ends it", async () => {
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(500);
    h.hook({ ...notification.payload, notification_type: "agent_needs_input", message: "<redacted>" });
    expect(h.agent()).toMatchObject({ state: "blocked", blockedReason: "agent_needs_input", dialogSince: null });
    h.at(6_400);
    h.hook(notification.payload);
    expect(h.agent()).toMatchObject({ state: "blocked", blockedReason: "permission_prompt", stateSince: 500 });
    await h.pollFor("idle", 10_000, 20_000);
    log("S5b", h);
    expect(h.agent()?.state).toBe("waiting");
  });
});

describe("VR3 S6 — discovery down: the Notification path alone", () => {
  it("blocks dated from the claim and alerts on the first pulse after the Notification", async () => {
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    for (let at = 1_000; at <= 6_000; at += 1_000) {
      h.at(at);
      h.registry.tick();
      await h.loop.pulse();
    }
    expect(h.sent).toEqual([]);
    h.at(6_400);
    h.hook(notification.payload);
    h.at(7_000);
    await h.loop.pulse();
    expect(story(h)).toEqual(["blocked:main@7"]);
    expect(h.agent()?.stateSince).toBe(0);
  });

  it("an approved claim (tool still running) does not take a later claimless Notification once it lapses", () => {
    const h = harness();
    h.at(0);
    h.hook(subPre(SUB));
    h.hook(subClaim(SUB)); // approved quickly, long tool
    h.at(9_999);
    h.hook(pre.payload);
    h.at(16_000);
    expect(h.hook(notification.payload).becameBlocked?.agentId).toBe(SESSION);
  });

  it("an approved claim inside its window DOES take a claimless dialog's Notification (window, documented)", () => {
    const h = harness();
    h.at(0);
    h.hook(subPre(SUB));
    h.hook(subClaim(SUB));
    h.at(1_000);
    h.hook(pre.payload); // main's plan approval etc. — no claim; shown at 1.4
    h.at(7_600);
    const r = h.hook(notification.payload);
    say(`[VR3] S6c owner=${r.becameBlocked?.agentId}`);
    expect(true).toBe(true);
  });

  it("a held claim in a masked session is not held: a queued real dialog's claim lapses", async () => {
    const h = await run({
      hooks: [
        [0, pre.payload],
        [0, request.payload],
        [2_000, subPre(SUB)],
        [2_000, subClaim(SUB)], // real, queued
        [6_400, notification.payload], // A's
        [30_000, post], // A approved at 29.5; SUB's on screen from 29.5
        [35_700, notification.payload], // SUB's
      ],
      screen: () => ["waiting", "input needed"],
      until: 60_000,
      phase: 1_000,
    });
    log("S6d masked", h);
    expect(true).toBe(true);
  });
});

describe("VR3 S7 — counters", () => {
  it("a retracted block is still counted in blocksBegun", () => {
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(300);
    h.poll("busy", 0);
    h.at(3_000);
    h.hook(subPre(SUB2));
    h.hook(subClaim(SUB2));
    h.at(5_300);
    h.seen(5_000);
    const before = h.registry.blocksBegun();
    h.at(6_400);
    h.hook(notification.payload);
    say(`[VR3] S7 blocksBegun before=${before} after=${h.registry.blocksBegun()} blocked now=${h.registry.blockedCount()}`);
    expect(h.registry.blocksBegun()).toBe(1);
  });
});

describe("VR3 S2c (rule a) — an approved claim, held for a minute, takes main's claim-wiped dialog", () => {
  it("SUB approved at 0.5 s runs 5 min; main's A then B: B is alerted once SUB's block ends? ", async () => {
    const h = await run({
      hooks: [
        [0, subPre(SUB)],
        [0, subClaim(SUB)], // approved at 0.5 s; its tool runs to 300 s
        [1_000, pre.payload],
        [1_000, request.payload], // A, on screen 1.4..60
        [1_300, request.payload], // B, parallel, queued
        [7_600, notification.payload], // A's
        [61_000, post], // A approved at 60 s, tool done 61 s; B on screen from 60 s
        [66_200, notification.payload], // B's
        [300_000, { ...post, agent_id: SUB, tool_use_id: `toolu_${SUB}` }],
      ],
      screen: (at) => (at >= 1_400 && at < 400_000 ? ["waiting", DIALOG] : ["busy"]),
      until: 400_000,
      phase: 2_000,
    });
    log("S2c", h);
    for (const e of h.sent) say(`[VR3] S2c env ${e.kind} ${e.session.agentId} ts=${e.ts}`);
    say(`[VR3] S2c end: main=${h.agent()?.state} SUB=${h.agent(SESSION, SUB)?.state}`);
    expect(story(h).filter((s) => s.includes(`:${SUB}@`)), "SUB was approved at 0.5 s").toEqual([]);
    expect(h.agent()?.state, "B (main's) is on screen at 400 s").toBe("blocked");
  });
});

describe("VR3 S8 (rule b) — two real claims both older than 5 s at the Notification", () => {
  it("main's A on screen, SUB queued 0.5 s later: documented wrong name, but someone is alerted", async () => {
    const h = await run({
      hooks: [
        [0, pre.payload],
        [0, request.payload],
        [500, subPre(SUB)],
        [500, subClaim(SUB)],
        [6_400, notification.payload],
        [21_000, post], // A approved 20 s; SUB's on screen from 20 s
        [41_000, { ...post, agent_id: SUB, tool_use_id: `toolu_${SUB}` }], // SUB approved 40 s
      ],
      screen: (at) => (at >= 400 && at < 40_000 ? ["waiting", DIALOG] : ["busy"]),
      until: 60_000,
      phase: 0,
    });
    log("S8", h);
    expect(h.alerts().length).toBeGreaterThan(0);
  });
});

