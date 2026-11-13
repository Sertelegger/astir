/**
 * #86 — a Claude permission prompt alerts ~6 s after it appears, and Esc
 * clears it (design C+, probes/86/design/DESIGN.md §5, amended by the 2.1.322
 * capture, probes/86/capture/REPORT.md §4).
 *
 * Claude says nothing when a dialog opens that astir can act on, and nothing
 * at all when Esc dismisses one. What it does say:
 *
 * - the `permission_prompt` Notification, once the dialog has been left alone
 *   for 6 s (5983-6125 ms after its PermissionRequest, n=53). It names no
 *   agent (0/69), so it blocks the session's main agent, as it always did;
 * - `claude agents --json`, which reads `waiting` while a dialog is up and
 *   `idle` or `busy` once it is gone (Esc 20/20, approval 11/11, on the first
 *   poll after the key).
 *
 * So the Notification begins the block, dated 5 s back, and the listing ends
 * it. Every timeline and timing here comes from that capture
 * (test/fixtures/claude/permission-capture.json); nothing is a designer's
 * synthetic timeline.
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeClaudeHook } from "../src/adapters/claude/normalize.js";
import { CAPABILITIES } from "../src/contract/capabilities.js";
import { type AstirEvent, CONTRACT_VERSION, type Kind } from "../src/contract/event.js";
import { Daemon } from "../src/daemon/server.js";
import { parseAgentsJson } from "../src/discovery/sessions.js";
import { Registry } from "../src/model/registry.js";
import { type DeliveryTarget, Dispatcher } from "../src/notify/dispatch.js";
import { NotifyLoop } from "../src/notify/loop.js";
import { NotifyPolicy } from "../src/notify/policy.js";

// ---------------------------------------------------------------------------
// The capture

interface CapEvent {
  t: number;
  hook: string;
  agent: string;
  agentType?: string;
  tool?: string;
  notificationType?: string;
}
interface CapPoll {
  start: number;
  end: number;
  status: string | null;
  waitingFor: string | null;
}
interface Timeline {
  lane: string;
  step: string;
  note: string;
  events: CapEvent[];
  polls: CapPoll[];
  screen: Array<{ t: number; dialog: boolean }>;
  actions: Array<{ t: number; action: string }>;
}
interface Notice {
  step: string;
  noticeAfterRequestMs: number | null;
  noticeAfterVisibleMs: number;
  keyBeforeNotice: boolean;
}

const capture = JSON.parse(
  readFileSync(new URL("./fixtures/claude/permission-capture.json", import.meta.url), "utf8"),
) as {
  _source: {
    claudeVersion: string;
    reportFacts: { noticeAfterPermissionRequestMs: { min: number; n: number } };
  };
  notices: Notice[];
  timelines: Record<string, Timeline>;
};

function timeline(name: string): Timeline {
  const tl = capture.timelines[name];
  if (tl === undefined) throw new Error(`no captured timeline ${name}`);
  return tl;
}

/** The hooks astir subscribes to. Anything else Claude sent never reaches it. */
const SUBSCRIBED = new Set(
  Object.keys(
    (
      JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8")) as {
        hooks: Record<string, unknown>;
      }
    ).hooks,
  ),
);

/** When the capture's first Notification for `tl` arrived (ms into the step). */
function firstNotice(tl: Timeline): number {
  const n = tl.events.find((e) => e.hook === "Notification" && e.notificationType === "permission_prompt");
  if (n === undefined) throw new Error(`${tl.step} has no permission_prompt Notification`);
  return n.t;
}

function eventAt(tl: Timeline, hook: string, agent: string, nth = 0): CapEvent {
  const e = tl.events.filter((x) => x.hook === hook && x.agent === agent)[nth];
  if (e === undefined) throw new Error(`${tl.step} has no ${hook} #${nth} for ${agent}`);
  return e;
}

/**
 * [on, off) intervals in which the screen recorder saw a dialog.
 *
 * One recorder (the listing lane's) stopped at its step's end, so P2's plan
 * dialog has no "off" record: a dialog still open at the end closes at the
 * step's last answering key, which the driver sent.
 */
function dialogIntervals(tl: Timeline, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let on: number | null = null;
  for (const s of tl.screen) {
    if (s.dialog && on === null) on = s.t;
    else if (!s.dialog && on !== null) {
      out.push([on, s.t]);
      on = null;
    }
  }
  if (on !== null) {
    const from = on;
    const answer = tl.actions.filter((a) => a.t > from && /^(approve|esc|key)/.test(a.action)).at(-1);
    out.push([from, answer?.t ?? end]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Driving the registry the way the daemon does

const SID = "cap-session";
const BASE = 1_794_000_000_000;
const DAEMON_POLL_EVERY = 5; // the capture polled every 1 s; the daemon polls every 5 s

/** One captured listing row, through the real translation (claudeScreen). */
function listed(p: { status: string | null; waitingFor: string | null }) {
  return (
    parseAgentsJson(
      JSON.stringify([
        {
          sessionId: SID,
          cwd: "/repo",
          pid: 4242,
          kind: "interactive",
          startedAt: 1,
          name: "cap",
          status: p.status,
          ...(p.waitingFor === null ? {} : { waitingFor: p.waitingFor }),
        },
      ]),
    ) ?? []
  );
}

function payload(e: Pick<CapEvent, "hook" | "agent" | "agentType" | "tool" | "notificationType">) {
  return {
    hook_event_name: e.hook,
    session_id: SID,
    cwd: "/repo",
    ...(e.agent === "main" ? {} : { agent_id: e.agent }),
    ...(e.agentType === undefined ? {} : { agent_type: e.agentType }),
    ...(e.tool === undefined ? {} : { tool_name: e.tool }),
    ...(e.notificationType === undefined ? {} : { notification_type: e.notificationType }),
  };
}

/** A registry on a clock that reads capture-relative ms. */
function rig() {
  let t = BASE;
  let ids = 0;
  const registry = new Registry({ nowMs: () => t });
  const deps = {
    now: () => t,
    newId: () => `cap-${++ids}`,
    realpath: (p: string) => p,
    readSidecar: () => null,
  };
  const r = {
    registry,
    now: () => t,
    at(ms: number) {
      t = BASE + ms;
      return r;
    },
    hook(hook: string, over: Partial<CapEvent> = {}) {
      const res = normalizeClaudeHook(payload({ hook, agent: "main", ...over }), deps);
      if (res.event !== null) registry.apply(res.event, "/repo");
      return r;
    },
    /** A poll that began at `startMs` and lands now. */
    poll(startMs: number, status: string | null, waitingFor: string | null = null) {
      registry.reconcile(listed({ status, waitingFor }), {
        complete: true,
        provider: "claude",
        observedAt: BASE + startMs,
      });
      return r;
    },
    main: () => registry.get(SID)?.agents.get(SID),
    agent: (label: string) => registry.get(SID)?.agents.get(label),
    blocked: () => registry.blockedAgents().map((b) => b.agentId),
  };
  return r;
}

interface Sent {
  t: number;
  kind: string;
}

/**
 * Replay a captured step: its hooks (those astir subscribes to) through the
 * real normalizer, every DAEMON_POLL_EVERY-th captured poll landing at its end
 * and dated from its start (`pollInto`), and the daemon's 1 s tick + pulse.
 */
async function replay(tl: Timeline, opts: { phase?: number; polls?: boolean; until?: number } = {}) {
  const phase = opts.phase ?? 0;
  const r = rig();
  const sent: Sent[] = [];
  const target: DeliveryTarget = {
    name: "test",
    live: () => true,
    deliver: async (e) => {
      sent.push({ t: r.now() - BASE, kind: e.kind });
      return { ok: true };
    },
  };
  const loop = new NotifyLoop({
    registry: r.registry,
    policy: new NotifyPolicy(),
    dispatcher: new Dispatcher([target]),
    now: r.now,
  });
  const steps: Array<{ at: number; order: number; run: () => unknown }> = [];
  for (const e of tl.events) {
    if (!SUBSCRIBED.has(e.hook)) continue;
    steps.push({ at: e.t, order: 0, run: () => r.hook(e.hook, e) });
  }
  const polls = opts.polls === false ? [] : tl.polls.filter((_, i) => i % DAEMON_POLL_EVERY === phase);
  for (const p of polls)
    steps.push({ at: p.end, order: 1, run: () => r.poll(p.start, p.status, p.waitingFor) });
  const last = Math.max(...tl.events.map((e) => e.t), ...tl.polls.map((p) => p.end));
  const until = opts.until ?? last;
  for (let ms = 0; ms <= until; ms += 1_000) {
    steps.push({
      at: ms,
      order: 2,
      run: async () => {
        r.registry.tick();
        await loop.pulse();
      },
    });
  }
  steps.sort((a, b) => a.at - b.at || a.order - b.order);
  for (const s of steps) {
    if (s.at > until) break;
    r.at(s.at);
    await s.run();
  }
  return { r, sent, polls };
}

const PHASES = [0, 1, 2, 3, 4];

// ---------------------------------------------------------------------------

describe("the fixture is the 2.1.322 capture", () => {
  it("says where it came from, and carries no content (SEC-01)", () => {
    expect(capture._source.claudeVersion).toBe("2.1.322");
    const text = JSON.stringify(capture);
    for (const forbidden of [
      "tool_input",
      "tool_response",
      "transcript_path",
      "session_id",
      "toolu_",
      "sha256",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("every timeline names its lane and step, and was recorded with listing polls and a screen", () => {
    for (const [name, tl] of Object.entries(capture.timelines)) {
      expect(tl.lane, name).toMatch(/^(listing|hooks|queue)$/);
      expect(tl.polls.length, name).toBeGreaterThan(10);
      expect(tl.screen.length, name).toBeGreaterThan(0);
    }
  });
});

describe("PSH-16's invariant, pinned to the capture: a Notification is never younger than the age it is dated by", () => {
  it("Claude notifies at least promptNoticeAgeMs after its dialog appeared", () => {
    // The block is dated N − promptNoticeAgeMs. Were Claude ever to notify
    // sooner than that after a dialog appeared, the date would predate the
    // dialog and the dwell would be spent on time nobody was asked anything.
    const unkeyed = capture.notices.filter((n) => !n.keyBeforeNotice);
    expect(unkeyed.length).toBeGreaterThanOrEqual(20);
    const youngest = Math.min(...unkeyed.map((n) => n.noticeAfterVisibleMs));
    expect(youngest).toBe(5865);
    expect(CAPABILITIES.claude.promptNoticeAgeMs).toBe(5_000);
    expect(CAPABILITIES.claude.promptNoticeAgeMs).toBeLessThanOrEqual(youngest);
    // Across every lane, against the PermissionRequest: 5983 ms at the least.
    const report = capture._source.reportFacts.noticeAfterPermissionRequestMs;
    expect(report).toMatchObject({ min: 5983, n: 53 });
    expect(CAPABILITIES.claude.promptNoticeAgeMs).toBeLessThanOrEqual(report.min);
  });

  it("a key at the dialog moves the Notification to Claude's next 6 s check", () => {
    const keyed = capture.notices.filter((n) => n.keyBeforeNotice).map((n) => n.noticeAfterVisibleMs);
    expect(keyed.length).toBe(3);
    for (const ms of keyed) expect(ms).toBeGreaterThan(11_000);
  });

  it("Codex declares no notice age and no listing: its Notification IS its ask", () => {
    expect(CAPABILITIES.codex.promptNoticeAgeMs).toBe(0);
    expect(CAPABILITIES.codex.listingEndsPermissionBlocks).toBe(false);
    expect(CAPABILITIES.claude.listingEndsPermissionBlocks).toBe(true);
  });
});

describe("rule 1 — only the Notification begins a block", () => {
  it("a listing that reads a permission dialog for 11 s begins nothing (C1a: a key delayed the Notification)", () => {
    const tl = timeline("C1a-bash-inert-right");
    const r = rig();
    const pre = eventAt(tl, "PreToolUse", "main");
    r.at(pre.t).hook("PreToolUse", pre);
    for (const p of tl.polls.filter((p) => p.end < firstNotice(tl)))
      r.at(p.end).poll(p.start, p.status, p.waitingFor);
    expect(r.main()?.state).toBe("tool-running");
    expect(r.blocked()).toEqual([]);
  });
});

describe("rule 2 — the Notification's block is dated promptNoticeAgeMs back", () => {
  it("B2: blocked since 5 s before the Notification; the time before that banked as work", () => {
    const tl = timeline("B2-bash-approve");
    const pre = eventAt(tl, "PreToolUse", "main");
    const n = firstNotice(tl);
    const r = rig();
    r.at(pre.t).hook("PreToolUse", pre);
    r.at(n).hook("Notification", { notificationType: "permission_prompt" });
    expect(r.main()?.state).toBe("blocked");
    expect(r.main()?.stateSince).toBe(BASE + n - 5_000);
    expect(r.main()?.activeMs).toBe(n - 5_000 - pre.t);
    expect(r.registry.blockedAgents()[0]?.blockedForMs).toBe(5_000);
  });

  it("Q2c-mixed: never before the state it leaves began — main's PostToolUse came 496 ms before the Notification", () => {
    const tl = timeline("Q2c-mixed");
    const r = rig();
    const post = eventAt(tl, "PostToolUse", "main", 1); // the Bash, after the Agent launch
    expect(post.tool).toBe("Bash");
    const n = firstNotice(tl);
    expect(n - post.t).toBe(496);
    for (const e of tl.events.filter((e) => e.t <= n && SUBSCRIBED.has(e.hook))) r.at(e.t).hook(e.hook, e);
    expect(r.main()?.state).toBe("blocked");
    expect(r.main()?.stateSince).toBe(BASE + post.t);
  });

  it("Q2-sub-slow: a second Notification while blocked (a buried ask's) changes nothing", () => {
    const tl = timeline("Q2-sub-slow");
    const [n1, n2] = tl.events.filter((e) => e.notificationType === "permission_prompt");
    if (n1 === undefined || n2 === undefined) throw new Error("expected two Notifications");
    const r = rig();
    for (const e of tl.events.filter((e) => e.t <= n1.t && SUBSCRIBED.has(e.hook))) r.at(e.t).hook(e.hook, e);
    const since = r.main()?.stateSince;
    expect(since).toBe(BASE + n1.t - 5_000);
    r.at(n2.t).hook("Notification", n2);
    expect(r.main()?.stateSince).toBe(since);
  });

  it("Codex: no notice age, so its block is dated from the event, and its own next event ends it, as before", () => {
    let t = 50_000;
    const registry = new Registry({ nowMs: () => t });
    let seq = 0;
    const cx = (kind: Kind, over: Partial<AstirEvent> = {}): AstirEvent => ({
      v: CONTRACT_VERSION,
      eventId: `cx${++seq}`,
      provider: "codex",
      sessionId: "cx",
      ts: t,
      kind,
      agentId: "cx",
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
    });
    registry.apply(cx("pre_tool"), "/r");
    t += 100;
    registry.apply(cx("notification", { notificationKind: "permission_prompt" }), "/r");
    expect(registry.get("cx")?.agents.get("cx")?.stateSince).toBe(50_100);
    t += 1_000;
    registry.apply(cx("pre_tool"), "/r");
    expect(registry.get("cx")?.agents.get("cx")?.state).toBe("tool-running");
  });
});

describe("rule 4 — Esc: the listing reads at-prompt", () => {
  it("B3: the first poll after Esc reads idle, and the agent hands the floor back", () => {
    const tl = timeline("B3-bash-esc");
    const r = rig();
    r.at(eventAt(tl, "PreToolUse", "main").t).hook("PreToolUse", { tool: "Bash" });
    r.at(firstNotice(tl)).hook("Notification", { notificationType: "permission_prompt" });
    const esc = tl.actions.find((a) => a.action.startsWith("esc"));
    const after = tl.polls.find((p) => esc !== undefined && p.start > esc.t);
    expect(after?.status).toBe("idle");
    if (after === undefined) return;
    r.at(after.end).poll(after.start, after.status, after.waitingFor);
    expect(r.main()?.state).toBe("waiting");
    expect(r.main()?.blockedReason).toBeNull();
    expect(r.blocked()).toEqual([]);
  });

  it("only from a poll begun at least 1 s after the block's date", () => {
    const tl = timeline("B3-bash-esc");
    const n = firstNotice(tl);
    const dated = n - 5_000;
    const r = rig();
    r.at(eventAt(tl, "PreToolUse", "main").t).hook("PreToolUse", { tool: "Bash" });
    r.at(n).hook("Notification", { notificationType: "permission_prompt" });
    r.at(n + 100).poll(dated + 999, "idle");
    expect(r.main()?.state).toBe("blocked");
    r.at(n + 200).poll(dated + 1_000, "idle");
    expect(r.main()?.state).toBe("waiting");
  });

  it("rule 8: an agent_needs_input block is not ended by it", () => {
    const r = rig();
    r.at(1_000).hook("PreToolUse", { tool: "Bash" });
    r.at(8_000).hook("Notification", { notificationType: "agent_needs_input" });
    r.at(15_000).poll(14_000, "idle");
    expect(r.main()?.state).toBe("blocked");
    expect(r.main()?.blockedReason).toBe("agent_needs_input");
  });
});

describe("rules 3 and 5 — answered: working after the dialog was seen", () => {
  it("B4: approved with a long tool behind it — the first busy poll ends the block, tool-running", () => {
    const tl = timeline("B4-bash-slow-approve");
    const r = rig();
    r.at(eventAt(tl, "PreToolUse", "main").t).hook("PreToolUse", { tool: "Bash" });
    r.at(firstNotice(tl)).hook("Notification", { notificationType: "permission_prompt" });
    const approve = tl.actions.find((a) => a.action.startsWith("approve"));
    const busy = tl.polls.find((p) => approve !== undefined && p.start > approve.t);
    expect(busy?.status).toBe("busy");
    if (busy === undefined) return;
    r.at(busy.end).poll(busy.start, busy.status, busy.waitingFor);
    expect(r.main()?.state).toBe("tool-running");
    // Its PostToolUse came seconds later: on main the block lasted until then.
    expect(eventAt(tl, "PostToolUse", "main").t - busy.end).toBeGreaterThan(4_000);
  });

  it("the Notification is a sighting: a busy poll begun within 2 s of it is not an answer, one begun 2 s after is", () => {
    // The settle is insurance: the design was sized from a report that older
    // builds' AskUserQuestion listing read busy for a second or two after its
    // Notification (DESIGN §4, not re-measured). 2.1.322 read busy in 0 of 27
    // dialogs, so a busy reading this close to a sighting is the boundary
    // under test here, not a captured one.
    const tl = timeline("B4-bash-slow-approve");
    const n = firstNotice(tl);
    const r = rig();
    r.at(eventAt(tl, "PreToolUse", "main").t).hook("PreToolUse", { tool: "Bash" });
    r.at(n).hook("Notification", { notificationType: "permission_prompt" });
    r.at(n + 2_500).poll(n + 1_999, "busy");
    expect(r.main()?.state).toBe("blocked");
    r.at(n + 2_600).poll(n + 2_000, "busy");
    expect(r.main()?.state).toBe("tool-running");
  });

  it("a poll that reads the dialog is a sighting too, and moves the settle with it", () => {
    const tl = timeline("B4-bash-slow-approve");
    const n = firstNotice(tl);
    const r = rig();
    r.at(eventAt(tl, "PreToolUse", "main").t).hook("PreToolUse", { tool: "Bash" });
    r.at(n).hook("Notification", { notificationType: "permission_prompt" });
    r.at(n + 4_500).poll(n + 4_000, "waiting", "permission prompt");
    r.at(n + 6_500).poll(n + 5_999, "busy");
    expect(r.main()?.state).toBe("blocked");
    r.at(n + 6_600).poll(n + 6_000, "busy");
    expect(r.main()?.state).toBe("tool-running");
  });

  it("an 'input needed' reading is a sighting as well (AskUserQuestion)", () => {
    const tl = timeline("Q1-ask-answer");
    const n = firstNotice(tl);
    const r = rig();
    r.at(eventAt(tl, "PreToolUse", "main").t).hook("PreToolUse", { tool: "AskUserQuestion" });
    r.at(n).hook("Notification", { notificationType: "permission_prompt" });
    r.at(n + 6_000).poll(n + 5_500, "waiting", "input needed");
    r.at(n + 8_000).poll(n + 7_499, "busy");
    expect(r.main()?.state).toBe("blocked");
    r.at(n + 8_100).poll(n + 7_500, "busy");
    expect(r.main()?.state).toBe("tool-running");
  });
});

describe("rule 6 — while the listing can see, main's own progress is not an answer", () => {
  it("Q1-slow: approving one dialog and opening the next ~0.2 s later is one block", () => {
    const tl = timeline("Q1-slow");
    const r = rig();
    const ns = tl.events.filter((e) => e.notificationType === "permission_prompt");
    const [n1, n2] = ns;
    if (n1 === undefined || n2 === undefined) throw new Error("expected two Notifications");
    const pre = eventAt(tl, "PreToolUse", "main");
    r.at(pre.t).hook("PreToolUse", pre);
    const sighting = tl.polls.find((p) => p.start > n1.t && p.status === "waiting");
    if (sighting === undefined) throw new Error("no sighting");
    r.at(n1.t).hook("Notification", n1);
    r.at(sighting.end).poll(sighting.start, sighting.status, sighting.waitingFor);
    const since = r.main()?.stateSince;
    for (const e of tl.events.filter((e) => e.t > sighting.end && e.t < n2.t && SUBSCRIBED.has(e.hook))) {
      r.at(e.t).hook(e.hook, e); // main's PostToolUse for AAA, PreToolUse for BBB
    }
    expect(r.main()?.state).toBe("blocked");
    expect(r.main()?.stateSince).toBe(since);
    r.at(n2.t).hook("Notification", n2);
    expect(r.main()?.stateSince).toBe(since);
  });

  it("Q2-sub-slow: main's Stop while a subagent's dialog is still on screen does not end the block", () => {
    // Background agents are the default (17/17 general-purpose launches), so
    // main's turn Stops while their dialogs are up (n=4 in the capture). C+ as
    // first written ended the block there: a `resolved` with a dialog on screen.
    const tl = timeline("Q2-sub-slow");
    const stop = eventAt(tl, "Stop", "main", 1);
    const r = rig();
    for (const e of tl.events.filter((e) => e.t < stop.t && SUBSCRIBED.has(e.hook)))
      r.at(e.t).hook(e.hook, e);
    const lastPoll = [...tl.polls].reverse().find((p) => p.end < stop.t);
    if (lastPoll === undefined) throw new Error("no poll");
    expect(lastPoll.waitingFor).toBe("permission prompt");
    r.at(lastPoll.end).poll(lastPoll.start, lastPoll.status, lastPoll.waitingFor);
    expect(r.main()?.state).toBe("blocked");
    r.at(stop.t).hook("Stop");
    expect(r.main()?.state).toBe("blocked");
  });

  it("…but a Stop after the listing last read no dialog ends it, as on main", () => {
    const r = rig();
    r.at(1_000).hook("PreToolUse", { tool: "Bash" });
    r.at(7_000).hook("Notification", { notificationType: "permission_prompt" });
    // Busy, but too soon after the sighting to count as an answer.
    r.at(8_000).poll(7_500, "busy");
    expect(r.main()?.state).toBe("blocked");
    r.at(8_500).hook("Stop");
    expect(r.main()?.state).toBe("waiting");
  });

  it("main's own events are held for 12 s after an informative reading, and end the block after (rule 7)", () => {
    const held = rig();
    held.at(1_000).hook("PreToolUse", { tool: "Bash" });
    held.at(7_000).hook("Notification", { notificationType: "permission_prompt" });
    held.at(8_000).poll(7_500, "waiting", "permission prompt");
    held.at(19_500).hook("PostToolUse", { tool: "Bash" });
    expect(held.main()?.state).toBe("blocked");

    const degraded = rig();
    degraded.at(1_000).hook("PreToolUse", { tool: "Bash" });
    degraded.at(7_000).hook("Notification", { notificationType: "permission_prompt" });
    degraded.at(8_000).poll(7_500, "waiting", "permission prompt");
    degraded.at(19_501).hook("PostToolUse", { tool: "Bash" });
    expect(degraded.main()?.state).toBe("thinking");
  });

  it("rule 7: with no listing at all (discovery down, an unlisted session), main's progress ends it as on main", () => {
    const r = rig();
    r.at(1_000).hook("PreToolUse", { tool: "Bash" });
    r.at(7_000).hook("Notification", { notificationType: "permission_prompt" });
    r.at(7_500).hook("PostToolUse", { tool: "Bash" });
    expect(r.main()?.state).toBe("thinking");
  });

  it("…and a stale listing lets main's Stop end it too", () => {
    const r = rig();
    r.at(1_000).hook("PreToolUse", { tool: "Bash" });
    r.at(7_000).hook("Notification", { notificationType: "permission_prompt" });
    r.at(8_000).poll(7_500, "waiting", "permission prompt");
    r.at(19_501).hook("Stop");
    expect(r.main()?.state).toBe("waiting");
  });

  it("the latest reading is the poll that BEGAN last, whatever order the answers land in", () => {
    const r = rig();
    r.at(1_000).hook("PreToolUse", { tool: "Bash" });
    r.at(7_000).hook("Notification", { notificationType: "permission_prompt" });
    r.at(12_500).poll(12_000, "waiting", "permission prompt");
    // An older poll, slower to answer: busy, but too close to the newer
    // sighting to be an answer, and older than it.
    r.at(12_600).poll(11_000, "busy");
    expect(r.main()?.state).toBe("blocked");
    r.at(13_000).hook("Stop");
    expect(r.main()?.state, "the screen still reads the dialog").toBe("blocked");
  });

  it("SessionEnd and SessionStart end it whatever the listing reads", () => {
    for (const hook of ["SessionEnd", "SessionStart"]) {
      const r = rig();
      r.at(1_000).hook("PreToolUse", { tool: "Bash" });
      r.at(7_000).hook("Notification", { notificationType: "permission_prompt" });
      r.at(8_000).poll(7_500, "waiting", "permission prompt");
      r.at(9_000).hook(hook);
      expect(r.main()?.state, hook).not.toBe("blocked");
    }
  });

  it("a FileChanged never ends it, even with no listing to vouch for the dialog", () => {
    const r = rig();
    r.at(1_000).hook("PreToolUse", { tool: "Bash" });
    r.at(7_000).hook("Notification", { notificationType: "permission_prompt" });
    r.at(8_000).hook("FileChanged");
    expect(r.main()?.state).toBe("blocked");
  });

  it("(b) AskUserQuestion: 'input needed' read during the block keeps it informative past 12 s", () => {
    // Q1-ask-answer's own rows and timing. No lane captured an AskUserQuestion
    // with a background agent's turn arriving under it, so the Stop below is
    // the one thing not from the capture: it stands for that arrival.
    const tl = timeline("Q1-ask-answer");
    const n = firstNotice(tl);
    const answer = eventAt(tl, "PostToolUse", "main").t;
    const r = rig();
    r.at(eventAt(tl, "PreToolUse", "main").t).hook("PreToolUse", { tool: "AskUserQuestion" });
    r.at(n).hook("Notification", { notificationType: "permission_prompt" });
    const during = tl.polls
      .filter((p) => p.start > n && p.end < answer)
      .filter((_, i) => i % DAEMON_POLL_EVERY === 0);
    expect(during.length).toBeGreaterThanOrEqual(2);
    for (const p of during) {
      expect(p.waitingFor).toBe("input needed");
      r.at(p.end).poll(p.start, p.status, p.waitingFor);
    }
    expect(answer - n).toBeGreaterThan(12_000);
    r.at(answer - 50).hook("Stop");
    expect(r.main()?.state).toBe("blocked");
  });

  it("(b) 'input needed' read before any block stood is not what keeps one informative", () => {
    const tl = timeline("Q1-ask-answer");
    const n = firstNotice(tl);
    const r = rig();
    r.at(eventAt(tl, "PreToolUse", "main").t).hook("PreToolUse", { tool: "AskUserQuestion" });
    const before = tl.polls.filter((p) => p.end < n && p.waitingFor === "input needed");
    expect(before.length).toBeGreaterThan(0);
    for (const p of before) r.at(p.end).poll(p.start, p.status, p.waitingFor);
    r.at(n).hook("Notification", { notificationType: "permission_prompt" });
    r.at(n + 100).hook("Stop");
    expect(r.main()?.state).toBe("waiting");
  });
});

describe("rule 9 — an agent mid-tool is not idled while a permission dialog is on screen", () => {
  it("Q3-sub-esc: sub2 sits at its dialog for 37 s and is still tool-running (30 s idles it on main)", async () => {
    const tl = timeline("Q3-sub-esc");
    const sub2Pre = eventAt(tl, "PreToolUse", "sub2");
    const esc = tl.actions.filter((a) => a.action === "key Escape")[1];
    if (esc === undefined) throw new Error("no second Esc");
    expect(esc.t - sub2Pre.t).toBeGreaterThan(30_000);
    const { r } = await replay(tl, { until: esc.t - 100 });
    expect(r.agent("sub2")?.state).toBe("tool-running");
  });

  it("only while the screen shows a permission dialog: at an idle prompt, the usual idle rule applies", () => {
    const r = rig();
    r.at(1_000).hook("PreToolUse", { agent: "sub1", agentType: "general-purpose", tool: "Bash" });
    r.at(2_000).poll(1_500, "waiting", "permission prompt");
    r.registry.tick();
    r.at(40_000).registry.tick();
    expect(r.agent("sub1")?.state).toBe("tool-running");
    r.at(41_000).poll(40_500, "idle");
    r.registry.tick();
    expect(r.agent("sub1")?.state).toBe("idle");
  });
});

describe("captured timelines, replayed at the daemon's 5 s poll, in all five phases", () => {
  /**
   * Each must: alert exactly once, never send `resolved` while the screen
   * recorder saw a dialog, and send it once the last dialog is gone, by the
   * pulse after the first daemon poll begun after that.
   */
  const cases: Array<{ name: string; why: string }> = [
    {
      name: "B2-bash-approve",
      why: "approved; the fast tool's PostToolUse and Stop land before the next poll",
    },
    { name: "B3-bash-esc", why: "Esc: no hook fires at all" },
    { name: "B4-bash-slow-approve", why: "approved; the tool runs on" },
    { name: "C1a-bash-inert-right", why: "a key delayed the Notification to 12 s; then Esc" },
    { name: "Q1-ask-answer", why: "AskUserQuestion, 'input needed' throughout" },
    { name: "P2-plan-approve", why: "plan approval" },
    { name: "Q1-slow", why: "two serial dialogs are one block" },
    { name: "Q2-sub-slow", why: "SUB2: main Stops while a background agent's dialog is up" },
    { name: "Q3-sub-esc", why: "SUB6: Esc at one background dialog, main Stops while the other is up" },
    { name: "Q2c-mixed", why: "SUB8: main's dialog answered, main Stops, a background agent's dialog is up" },
    { name: "OOO", why: "main's dialog approved, main Stops, a background agent's dialog (OOO) is up" },
  ];

  for (const { name, why } of cases) {
    it.each(PHASES)(`${name} (${why}), phase %i`, async (phase) => {
      const tl = timeline(name);
      const { sent, polls } = await replay(tl, { phase });
      const last = Math.max(...tl.events.map((e) => e.t), ...tl.polls.map((p) => p.end));
      const dialogs = dialogIntervals(tl, last + 1);
      const up = (t: number) => dialogs.some(([on, off]) => t >= on && t < off);

      const blocked = sent.filter((s) => s.kind === "blocked");
      const resolved = sent.filter((s) => s.kind === "resolved");
      expect(blocked, "one alert").toHaveLength(1);
      expect(
        resolved.filter((s) => up(s.t)),
        "no resolved while a dialog is on screen",
      ).toEqual([]);

      const closed = dialogs.at(-1)?.[1];
      if (closed === undefined || closed > last) return; // still up when the step ended
      const firstAfter = polls.find((p) => p.start >= closed);
      if (firstAfter === undefined) throw new Error("no poll after the dialog closed");
      expect(resolved, "resolved once the dialog is gone").toHaveLength(1);
      expect(resolved[0]?.t).toBeLessThanOrEqual(firstAfter.end + 1_000);
    });
  }

  it.each(PHASES)(
    "the alert comes on the first pulse after the Notification (B2, B3, B4, P2, Q1-ask, Q2-sub-slow, OOO), phase %i",
    async (phase) => {
      for (const name of [
        "B2-bash-approve",
        "B3-bash-esc",
        "B4-bash-slow-approve",
        "P2-plan-approve",
        "Q1-ask-answer",
        "Q2-sub-slow",
        "OOO",
      ]) {
        const tl = timeline(name);
        const n = firstNotice(tl);
        const { sent } = await replay(tl, { phase });
        const alert = sent.find((s) => s.kind === "blocked");
        expect(alert, name).toBeDefined();
        expect((alert?.t ?? 0) - n, name).toBeGreaterThanOrEqual(0);
        expect((alert?.t ?? 0) - n, name).toBeLessThanOrEqual(1_000);
        // ~6 s after the dialog appeared, where main took ~11 s.
        const shown = tl.screen.find((s) => s.dialog)?.t ?? 0;
        expect((alert?.t ?? 0) - shown, name).toBeLessThan(7_500);
      }
    },
  );

  it("Q2c-mixed: a block clamped to main's PostToolUse 496 ms before the Notification alerts once it has lasted the dwell", async () => {
    const tl = timeline("Q2c-mixed");
    const post = eventAt(tl, "PostToolUse", "main", 1);
    const { sent } = await replay(tl);
    const alert = sent.find((s) => s.kind === "blocked");
    expect(alert?.t).toBe(Math.ceil((post.t + 5_000) / 1_000) * 1_000);
  });

  it.each(PHASES)(
    "C1a: a key at the dialog moves the alert to Claude's 12 s check, phase %i",
    async (phase) => {
      const tl = timeline("C1a-bash-inert-right");
      const n = firstNotice(tl);
      const { sent } = await replay(tl, { phase });
      const alert = sent.find((s) => s.kind === "blocked");
      expect((alert?.t ?? 0) - n).toBeLessThanOrEqual(1_000);
      expect(n - (tl.screen.find((s) => s.dialog)?.t ?? 0)).toBeGreaterThan(11_000);
    },
  );

  it("with no listing at all, an Esc'd dialog stays blocked until the session's next event, as on main", async () => {
    const tl = timeline("B3-bash-esc");
    const { sent, r } = await replay(tl, { polls: false });
    expect(sent.map((s) => s.kind)).toEqual(["blocked"]);
    expect(r.main()?.state).toBe("blocked");
  });
});

describe("KNOWN LIMITATIONS (documented in CHANGELOG, not fixed)", () => {
  it("a poll landing in the ~0.2 s busy gap between serial dialogs clears the block; the next dialog re-alerts ~6 s after it mounts", () => {
    // Q1-slow's events. No 1 s poll landed in its gap (208 ms on screen), but
    // one did in Q1-quick's: begun 405 ms before the approval, it read busy.
    // At the daemon's 5 s cadence that happens to ~4-6% of serial pairs.
    const tl = timeline("Q1-slow");
    const [n1, n2] = tl.events.filter((e) => e.notificationType === "permission_prompt");
    if (n1 === undefined || n2 === undefined) throw new Error("expected two Notifications");
    const approve = tl.actions.find((a) => a.action === "key Enter");
    const [off, on] = [tl.screen[1], tl.screen[2]];
    if (approve === undefined || off === undefined || on === undefined) throw new Error("bad fixture");
    expect(on.t - off.t).toBeLessThanOrEqual(281);
    const gapPollStart = approve.t - 405;
    // The daemon's poll before it, 5 s earlier: the captured one nearest.
    const before = tl.polls.reduce((a, b) =>
      Math.abs(b.start - (gapPollStart - 5_000)) < Math.abs(a.start - (gapPollStart - 5_000)) ? b : a,
    );
    expect(before.waitingFor).toBe("permission prompt");
    const r = rig();
    r.at(eventAt(tl, "PreToolUse", "main").t).hook("PreToolUse", { tool: "Bash" });
    r.at(before.end).poll(before.start, before.status, before.waitingFor);
    r.at(n1.t).hook("Notification", n1);
    const alertedSince = r.main()?.stateSince;
    // Q1-quick's gap poll landed 177 ms after the key; here that is after
    // main's PostToolUse and next PreToolUse, which the hold kept off the block.
    const lands = approve.t + 177;
    for (const e of tl.events.filter((e) => e.t > approve.t && e.t < lands && SUBSCRIBED.has(e.hook))) {
      r.at(e.t).hook(e.hook, e);
    }
    expect(r.main()?.state).toBe("blocked");
    r.at(lands).poll(gapPollStart, "busy");
    expect(r.main()?.state, "the block ends with BBB's dialog on screen").toBe("tool-running");
    r.at(n2.t).hook("Notification", n2);
    expect(r.main()?.state).toBe("blocked");
    expect(r.main()?.stateSince, "a new block, which alerts afresh").not.toBe(alertedSince);
    expect(n2.t - on.t).toBe(5_943);
  });

  it("a dialog that never gets a Notification (the user typing in that terminal throughout) never alerts, as on main", () => {
    const tl = timeline("C1a-bash-inert-right");
    const r = rig();
    r.at(eventAt(tl, "PreToolUse", "main").t).hook("PreToolUse", { tool: "Bash" });
    for (const p of tl.polls.filter((p) => p.end < firstNotice(tl)))
      r.at(p.end).poll(p.start, p.status, p.waitingFor);
    expect(r.blocked()).toEqual([]);
  });
});

describe("what the listing tells the registry stays in memory, on no surface", () => {
  let daemon: Daemon | undefined;
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  const words = [
    "screen",
    "dialogSeenAt",
    "informativeAt",
    "waitingFor",
    "permission-dialog",
    "input needed",
  ];

  it("not in the crash-recovery snapshot (DMN-06)", () => {
    const r = rig();
    r.at(1_000).hook("PreToolUse", { tool: "Bash" });
    r.at(7_000).hook("Notification", { notificationType: "permission_prompt" });
    r.at(8_000).poll(7_500, "waiting", "permission prompt");
    const text = JSON.stringify(r.registry.snapshot());
    for (const w of words) expect(text).not.toContain(w);
  });

  it("not in /state", async () => {
    const r = rig();
    r.at(1_000).hook("PreToolUse", { tool: "Bash" });
    r.at(7_000).hook("Notification", { notificationType: "permission_prompt" });
    r.at(8_000).poll(7_500, "waiting", "permission prompt");
    const token = "t".repeat(48);
    daemon = new Daemon({ token, registry: r.registry });
    const port = await daemon.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/state`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    expect(text).toContain(SID);
    for (const w of words) expect(text).not.toContain(w);
  });
});
