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



const fmt = (h: ReturnType<typeof harness>) =>
  JSON.stringify(h.sent.map((e) => `${e.kind}:${e.session.agentId === SESSION ? "main" : "sub"}@${e.ts}`));
const snap = (h: ReturnType<typeof harness>, id = SESSION) => {
  const a = h.agent(SESSION, id);
  return { state: a?.state, reason: a?.blockedReason, stateSince: a?.stateSince, dialogSince: a?.dialogSince, dialogHeldAt: a?.dialogHeldAt, blockedMs: a?.blockedMs, activeMs: a?.activeMs };
};

describe("vr3-rx verify", () => {
  it("RX: a block a Notification made with no claim is retracted once its agent re-claims", async () => {
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(notification.payload);
    console.log("RX @0 main", JSON.stringify(snap(h)), "blocksBegun", h.registry.blocksBegun());
    h.at(1_000); await h.loop.pulse();
    h.at(3_000);
    h.hook({ ...pre.payload, agent_id: SUB, tool_use_id: "toolu_s" });
    h.hook({ ...request.payload, agent_id: SUB });
    h.at(5_000); await h.loop.pulse();
    h.at(10_000);
    h.hook(request.payload);
    console.log("RX @10 main", JSON.stringify(snap(h)), "blocksBegun", h.registry.blocksBegun());
    h.at(11_000); await h.loop.pulse();
    h.at(12_000);
    h.hook(notification.payload);
    console.log("RX @12 main", JSON.stringify(snap(h)), "| sub", JSON.stringify(snap(h, SUB)));
    h.at(13_000); await h.loop.pulse();
    console.log("RX sent", fmt(h));
    // no reconcile was ever called: no sighting anywhere in this sequence
  });

  it("RX2: canonical claim+Notification block (fixture path), parallel re-claim, retracted by sub's Notification", async () => {
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(6_400);
    h.hook(notification.payload);
    console.log("RX2 @6.4 main", JSON.stringify(snap(h)), "blocksBegun", h.registry.blocksBegun());
    h.at(7_000);
    await h.loop.pulse();
    h.hook({ ...pre.payload, agent_id: SUB, tool_use_id: "toolu_s" });
    h.hook({ ...request.payload, agent_id: SUB });
    h.at(13_000);
    h.hook(request.payload); // parallel second ask, as test line ~453 models
    console.log("RX2 @13 main", JSON.stringify(snap(h)));
    h.at(14_000);
    h.hook(notification.payload);
    console.log("RX2 @14 main", JSON.stringify(snap(h)), "| sub", JSON.stringify(snap(h, SUB)));
    h.at(15_000); await h.loop.pulse();
    console.log("RX2 sent", fmt(h));
  });

  it("RX3: a Notification blocks a YOUNG claim (no other old claim yet), later retracted", async () => {
    const h = harness();
    h.at(0);
    h.hook({ ...pre.payload, agent_id: SUB, tool_use_id: "toolu_s" });
    h.hook({ ...request.payload, agent_id: SUB });
    h.hook(pre.payload);
    h.at(3_000);
    h.hook(request.payload); // main claims at 3 s
    h.at(4_000);
    h.hook(notification.payload); // no claim >= 5 s old exists: stays on main, blocks main's 1 s-old claim
    console.log("RX3 @4 main", JSON.stringify(snap(h)), "| sub", JSON.stringify(snap(h, SUB)));
    h.at(5_500);
    h.hook(notification.payload);
    console.log("RX3 @5.5 main", JSON.stringify(snap(h)), "| sub", JSON.stringify(snap(h, SUB)));
  });
});
