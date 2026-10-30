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
const LOG = process.env.VR3_LOG ?? "/tmp/claude-1000/-home-dev-repos-astir/d8458719-ef7f-472f-be54-5616006a1f7c/scratchpad/vr3-f3r/own.log";
const say = (line: string) => appendFileSync(LOG, `${line}\n`);
const DLG = (from: number, to: number) => (at: number): [string, string?] =>
  at >= from && at < to ? ["waiting", DIALOG] : ["busy"];
/** Main agent state sampled after the run, and the alerts after a time. */
const report = (label: string, h: ReturnType<typeof harness>) => {
  say(`[F3R] ${label}: story=${JSON.stringify(story(h))} mainEnd=${h.agent()?.state} sub2End=${h.agent(SESSION, SUB2)?.state}`);
};

describe("F3R — CHANGELOG 'The real prompt is never dropped'", () => {
  it("V0 = S2 dead=true, sampling main's state through the run", async () => {
    // Same hooks and screen as S2 dead=true.
    const hooks: Array<[number, Payload]> = [
      [0, pre.payload],
      [0, request.payload],
      [300, request.payload],
      [3_000, subPre(SUB2)],
      [3_000, subClaim(SUB2)],
      [45_000, subPre(SUB2, "toolu_bg2")],
      [6_400, notification.payload],
      [21_000, post],
      [26_200, notification.payload],
    ];
    const h = await run({ hooks, screen: DLG(400, 200_000), until: 180_000, phase: 1_000 });
    report("V0 S2-dead", h);
    const mainBlockedAfter45 = story(h).filter((s) => s.startsWith("blocked:main@") && Number(s.split("@")[1]) > 45);
    say(`[F3R] V0 main blocked alerts after 45 s: ${JSON.stringify(mainBlockedAfter45)}; blockedCount at 180 s=${h.registry.blockedCount()}`);
    expect(mainBlockedAfter45.length).toBeGreaterThan(0);
  });

  it("V1 control — plain documented case: refusal within 1.5 s of main's unseen ask, one ask each", async () => {
    const hooks: Array<[number, Payload]> = [
      [0, pre.payload],
      [0, request.payload], // main's real prompt, on screen 0.4..200
      [500, subPre(SUB2)],
      [500, subClaim(SUB2)], // refused by Claude itself; SUB2 next acts at 45 s
      [6_400, notification.payload],
      [45_000, subPre(SUB2, "toolu_bg2")],
    ];
    const h = await run({ hooks, screen: DLG(400, 200_000), until: 180_000, phase: 1_000 });
    report("V1 control", h);
    const mainAfter45 = story(h).filter((s) => s.startsWith("blocked:main@") && Number(s.split("@")[1]) >= 45);
    expect(mainAfter45.length).toBeGreaterThan(0);
  });

  it("V2 — strict documented precondition, plus a concurrent auto-allowed main tool finishing while the prompt is up", async () => {
    const read = { ...pre.payload, tool_name: "Read", tool_use_id: "toolu_read" };
    const readPost = { ...read, hook_event_name: "PostToolUse", tool_response: {} };
    const hooks: Array<[number, Payload]> = [
      [0, read], // main's parallel auto-allowed tool
      [0, pre.payload],
      [400, request.payload], // main's real prompt, on screen 0.8..200
      [800, subPre(SUB2)],
      [800, subClaim(SUB2)], // refused by Claude itself, while main's prompt is open and not yet seen
      [900, readPost], // main's parallel tool finishes: main's own progress
      [6_600, notification.payload],
      [45_000, subPre(SUB2, "toolu_bg2")],
    ];
    const h = await run({ hooks, screen: DLG(800, 200_000), until: 180_000, phase: 1_000 });
    report("V2 concurrent-own-progress", h);
    const mainAfter45 = story(h).filter((s) => s.startsWith("blocked:main@") && Number(s.split("@")[1]) >= 45);
    expect(mainAfter45.length).toBeGreaterThan(0);
  });

  it("V2-control — same without SUB2: main's prompt is alerted by its Notification", async () => {
    const read = { ...pre.payload, tool_name: "Read", tool_use_id: "toolu_read" };
    const readPost = { ...read, hook_event_name: "PostToolUse", tool_response: {} };
    const hooks: Array<[number, Payload]> = [
      [0, read],
      [0, pre.payload],
      [400, request.payload],
      [900, readPost],
      [6_600, notification.payload],
    ];
    const h = await run({ hooks, screen: DLG(800, 200_000), until: 180_000, phase: 1_000 });
    report("V2-control no SUB2", h);
    expect(story(h).some((s) => s.startsWith("blocked:main@"))).toBe(true);
  });

  it("V0-resend — S2 dead=true plus a hypothetical second Notification at 50 s", async () => {
    const hooks: Array<[number, Payload]> = [
      [0, pre.payload], [0, request.payload], [300, request.payload],
      [3_000, subPre(SUB2)], [3_000, subClaim(SUB2)], [45_000, subPre(SUB2, "toolu_bg2")],
      [6_400, notification.payload], [21_000, post], [26_200, notification.payload],
      [50_000, notification.payload],
    ];
    const h = await run({ hooks, screen: DLG(400, 200_000), until: 180_000, phase: 1_000 });
    report("V0-resend", h);
    expect(true).toBe(true);
  });

  it("S2 manual — main seen before SUB2's claim; main's claim gone after A's post", async () => {
    const h = harness();
    h.at(0); h.hook(pre.payload); h.hook(request.payload);
    h.at(300); h.hook(request.payload);
    h.at(1_300); h.seen(1_000);
    say(`[F3R] S2m at 1.3 s: main state=${h.agent()?.state} dialogSince=${h.agent()?.dialogSince} dialogSeenAt=${h.agent()?.dialogSeenAt}`);
    h.at(3_000); h.hook(subPre(SUB2)); h.hook(subClaim(SUB2));
    for (const at of [6_000, 11_000, 16_000]) { h.at(at + 300); h.seen(at); }
    say(`[F3R] S2m at 16.3 s: main=${h.agent()?.state} SUB2=${h.agent(SESSION, SUB2)?.state} SUB2.dialogSince=${h.agent(SESSION, SUB2)?.dialogSince} SUB2.dialogHeldAt=${h.agent(SESSION, SUB2)?.dialogHeldAt}`);
    h.at(21_000); h.hook(post);
    say(`[F3R] S2m after A's post at 21 s: main state=${h.agent()?.state} dialogSince=${h.agent()?.dialogSince}`);
    h.at(21_300); h.seen(21_000);
    say(`[F3R] S2m at 21.3 s sighting: main=${h.agent()?.state} SUB2=${h.agent(SESSION, SUB2)?.state} SUB2.stateSince=${h.agent(SESSION, SUB2)?.stateSince}`);
    h.at(26_200); const r = h.hook(notification.payload);
    say(`[F3R] S2m Notification at 26.2 s: event went to ${r.becameBlocked?.agentId ?? "(no new block)"}; main=${h.agent()?.state} SUB2=${h.agent(SESSION, SUB2)?.state}`);
    expect(true).toBe(true);
  });
});
