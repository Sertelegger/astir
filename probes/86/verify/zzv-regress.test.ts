/**
 * #86 — a Claude permission block is dated from when the dialog was claimed,
 * begins once something has seen the dialog, and ends when Claude's own
 * session listing says the dialog is gone.
 *
 * The sequence is `fixtures/claude/permission-request.json`, sanitised from
 * one real dialog on Claude Code 2.1.312: PreToolUse, then PermissionRequest
 * 1.1 s later, then the `permission_prompt` Notification 6.4 s after that —
 * which was all astir listened to. What the listing reports (`waiting` with
 * `waitingFor: "permission prompt"` while a tool's dialog is open, `idle`
 * after Esc, `busy` while working) was measured alongside it and is recorded
 * in the fixture's `_capture`.
 *
 * `PermissionRequest` is a claim, not a sighting: Claude also fires it for
 * asks that can never show a dialog (a background agent's, a headless
 * session's) and then denies them itself — read from the 2.1.312 binary. So
 * it blocks nothing by itself.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeClaudeHook } from "../src/adapters/claude/normalize.js";
import { normalizeCodexHook } from "../src/adapters/codex/normalize.js";
import { CAPABILITIES } from "../src/contract/capabilities.js";
import { validateEvent } from "../src/contract/event.js";
import { Daemon } from "../src/daemon/server.js";
import { claudeScreen, type DiscoveredSession, parseAgentsJson, pollInto } from "../src/discovery/sessions.js";
import { Registry } from "../src/model/registry.js";
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
const post = { ...pre.payload, hook_event_name: "PostToolUse", tool_response: {} };

/** What `claude agents --json` names a tool's permission dialog. */
const DIALOG = "permission prompt";

const deps = {
  readSidecar: () => null,
  newId: () => "e1",
  realpath: (p: string) => p,
  now: () => 1_793_000_000,
};

/** A listing row for the captured session, as `claude agents --json` gives it. */
const listed = (status: string | null, sessionId = SESSION, waitingFor?: string): DiscoveredSession => ({
  sessionId,
  cwd: CWD,
  pid: 4242,
  status,
  name: "repo",
  startedAt: null,
  ...(claudeScreen(status, waitingFor ?? null) === undefined ? {} : { screen: claudeScreen(status, waitingFor ?? null) }),
});

/**
 * The real Registry and NotifyLoop on one clock, with Claude's declared dwell.
 * `poll` folds in one discovery answer; `startedAt` is when that poll began,
 * which can be well before it lands. `seen` is a poll that finds a tool's
 * permission dialog on screen.
 */
function harness() {
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
  const registry = new Registry({ nowMs: now });
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


const TASK_PRE = { ...pre.payload, tool_name: "Agent", tool_use_id: "toolu_task", tool_input: { prompt: "x" } };
const BG = "b6df52f63e0c9a466";
type Sched = [number, Payload];
type Screen = (at: number) => [string, string?];

/** 100 ms resolution; polls every 5 s from `phase`, landing 300 ms later; tick + pulse every 1 s. */
async function sim(events: Sched[], screen: Screen, end: number, phase = 0, watch: string[] = [SESSION]) {
  const h = harness();
  const evs = [...events].sort((a, b) => a[0] - b[0]);
  const pending: { land: number; start: number; s: [string, string?] }[] = [];
  const trace: string[] = [];
  const last = new Map<string, string>();
  for (let ms = 0; ms <= end; ms += 100) {
    h.at(ms);
    while (evs.length > 0 && evs[0]![0] <= ms) {
      const p = evs.shift()![1];
      try { h.hook(p); } catch (e) { trace.push(`@${ms} hook-not-applied ${String(p.hook_event_name)}`); }
    }
    if (ms >= phase && (ms - phase) % 5_000 === 0) pending.push({ land: ms + 300, start: ms, s: screen(ms) });
    for (const p of pending.filter((x) => x.land === ms)) h.poll(p.s[0], p.start, { waitingFor: p.s[1] });
    if (ms % 1_000 === 0) {
      h.registry.tick();
      await h.loop.pulse();
    }
    for (const id of watch) {
      const a = h.agent(SESSION, id);
      const st = a ? `${a.state}/${a.blockedReason ?? "-"}/ds=${a.dialogSince}` : "none";
      if (last.get(id) !== st) {
        trace.push(`@${ms} ${id === SESSION ? "main" : id.slice(0, 3)}=${st}`);
        last.set(id, st);
      }
    }
  }
  const sent = h.sent.map((e) => `${e.kind}:${e.session.agentId === SESSION ? "main" : e.session.agentId.slice(0, 3)}:${e.reason}@${e.ts / 1000}`);
  return { h, sent, trace };
}

describe("REGRESSIONS", () => {
  it("R1: a self-denied bg ask newer than main's unseen real dialog", async () => {
    for (const bgNext of [3_000, 5_000, 8_000, 15_000, 40_000]) {
      const ev: Sched[] = [
        [0, pre.payload],
        [0, request.payload], // main's real dialog
        [1_000, { ...pre.payload, agent_id: BG, tool_use_id: "toolu_bg" }],
        [1_000, { ...request.payload, agent_id: BG }], // self-denied
        [6_400, notification.payload], // main's dialog, still up
        [bgNext, { ...pre.payload, agent_id: BG, tool_use_id: "toolu_bg2" }],
        [60_000, post], // main approved at ~59 s
      ];
      const screen: Screen = (at) => (at >= 400 && at < 59_000 ? ["waiting", DIALOG] : ["busy"]);
      const r = await sim(ev, screen, 120_000, 2_000, [SESSION, BG]);
      console.log(`R1 bgNext=${bgNext}`, JSON.stringify(r.sent));
      console.log(`R1 bgNext=${bgNext} trace`, r.trace.join(" | "));
    }
  });

  it("R2: main seen, then a self-denied bg ask while main's dialog is still up", async () => {
    for (const bgNext of [4_000, 9_000, 20_000]) {
      const ev: Sched[] = [
        [0, pre.payload],
        [0, request.payload],
        [3_000, { ...pre.payload, agent_id: BG, tool_use_id: "toolu_bg" }],
        [3_000, { ...request.payload, agent_id: BG }],
        [6_400, notification.payload],
        [bgNext, { ...pre.payload, agent_id: BG, tool_use_id: "toolu_bg2" }],
        [60_000, post],
      ];
      const screen: Screen = (at) => (at >= 400 && at < 59_000 ? ["waiting", DIALOG] : ["busy"]);
      const r = await sim(ev, screen, 120_000, 1_000, [SESSION, BG]);
      console.log(`R2 bgNext=${bgNext}`, JSON.stringify(r.sent));
      console.log(`R2 bgNext=${bgNext} trace`, r.trace.join(" | "));
    }
  });

  it("R3: fixer-disclosed: parent decays to idle while subagent's dialog is up", async () => {
    const ev: Sched[] = [
      [0, TASK_PRE],
      [100, { ...pre.payload, agent_id: "a5cf41e52d9b8f355" }],
      [1_100, { ...request.payload, agent_id: "a5cf41e52d9b8f355" }],
      [7_500, notification.payload],
    ];
    const screen: Screen = (at) => (at >= 1_500 && at < 90_000 ? ["waiting", DIALOG] : ["busy"]);
    const r = await sim(ev, screen, 100_000, 0, [SESSION, "a5cf41e52d9b8f355"]);
    console.log("R3", JSON.stringify(r.sent));
    console.log("R3 trace", r.trace.join(" | "));
  });

  it("R4: agent_needs_input (no agent_id) during a listing-seen block, then Esc (idle polls)", async () => {
    const ev: Sched[] = [
      [0, pre.payload],
      [0, request.payload],
      [5_500, { ...notification.payload, notification_type: "agent_needs_input", message: "x needs your input" }],
    ];
    const screen: Screen = (at) => (at >= 400 && at < 6_000 ? ["waiting", DIALOG] : ["idle"]);
    const r = await sim(ev, screen, 200_000, 1_000);
    console.log("R4", JSON.stringify(r.sent));
    console.log("R4 trace", r.trace.join(" | "));
  });

  it("R5: lone stale claim (approved before any poll) + a later non-permission dialog that reads 'permission prompt'", async () => {
    for (const dlgAt of [6_000, 9_000, 12_000, 30_000]) {
      const ev: Sched[] = [
        [0, pre.payload],
        [0, request.payload], // approved at 0.8 s, tool runs for minutes
      ];
      const screen: Screen = (at) => (at >= dlgAt && at < dlgAt + 30_000 ? ["waiting", DIALOG] : ["busy"]);
      const r = await sim(ev, screen, 120_000, 1_000);
      console.log(`R5 dlgAt=${dlgAt}`, JSON.stringify(r.sent));
    }
  });
});
