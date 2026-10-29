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

describe("the fixture is a capture, not a construction", () => {
  it("records where it came from", () => {
    expect(capture._capture.provider).toBe("claude");
    expect(capture._capture.cliVersion).toBe("2.1.312 (Claude Code)");
    expect(capture._capture.capturedAt).toBe("2026-10-28");
  });

  it("is one dialog: PreToolUse, PermissionRequest, then the Notification, in one session", () => {
    expect(capture.sequence.map((s) => s.payload.hook_event_name)).toEqual([
      "PreToolUse",
      "PermissionRequest",
      "Notification",
    ]);
    expect(new Set(capture.sequence.map((s) => s.payload.session_id)).size).toBe(1);
    const offsets = capture.sequence.map((s) => s.afterMs);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  it("shows the Notification astir listened to comes seconds after the dialog was claimed", () => {
    // The whole bug: a 5 s dwell measured from the Notification put the alert
    // ~11 s after the prompt.
    expect(request.afterMs).toBeLessThan(2_000);
    expect(notification.afterMs - request.afterMs).toBeGreaterThan(CAPABILITIES.claude.blockDwellMs);
  });

  it("shows a PermissionRequest names no call and no agent, and carries what was captured", () => {
    expect(Object.keys(request.payload).sort()).toEqual([
      "cwd",
      "effort",
      "hook_event_name",
      "permission_mode",
      "permission_suggestions",
      "prompt_id",
      "scratchpad_dir",
      "session_id",
      "tool_input",
      "tool_name",
      "transcript_path",
    ]);
    expect(request.payload).not.toHaveProperty("notification_type");
    expect(request.payload.permission_mode).toBe("default");
  });

  it("does not claim a PermissionRequest is a dialog", () => {
    // It is not, for a background agent or a headless session (#86 review).
    const text = JSON.stringify(capture._capture);
    expect(text).not.toContain("fires as the dialog opens");
    expect(text).toContain("permission prompt");
  });

  it("keeps no command text, description or suggested path", () => {
    const text = JSON.stringify(capture.sequence);
    expect(text).not.toContain("/home/dev");
    for (const step of capture.sequence) {
      const input = step.payload.tool_input as Record<string, unknown> | undefined;
      if (input !== undefined) expect(Object.values(input)).toEqual(["<redacted>", "<redacted>"]);
    }
    // A list of objects with the captured keys, every value a marker.
    const suggestions = request.payload.permission_suggestions as Array<Record<string, unknown>>;
    expect(suggestions.map((x) => Object.keys(x).sort())).toEqual([["destination", "directories", "type"]]);
    const leaves = (v: unknown): unknown[] =>
      Array.isArray(v)
        ? v.flatMap(leaves)
        : typeof v === "object" && v !== null
          ? Object.values(v).flatMap(leaves)
          : [v];
    expect(new Set(leaves(suggestions))).toEqual(new Set(["<redacted>"]));
  });
});

describe("PermissionRequest is a claim that a dialog may be open", () => {
  it("normalizes to a `permission_request` notification for the session's main agent", () => {
    const { event } = normalizeClaudeHook(request.payload, deps);
    expect(event).toMatchObject({
      provider: "claude",
      kind: "notification",
      notificationKind: "permission_request",
      sessionId: SESSION,
      agentId: SESSION,
      tool: null,
      paths: [],
    });
    expect(validateEvent(event).ok).toBe(true);
  });

  it("is a subagent's when it names one, as every other Claude event is", () => {
    const { event } = normalizeClaudeHook({ ...request.payload, agent_id: SUB }, deps);
    expect(event?.agentId).toBe(SUB);
    expect(event?.sessionId).toBe(SESSION);
  });

  it("is a claim for AskUserQuestion too — measured to fire it, and a human must answer", () => {
    const { event } = normalizeClaudeHook({ ...request.payload, tool_name: "AskUserQuestion" }, deps);
    expect(event?.notificationKind).toBe("permission_request");
  });

  it("is registered in hooks.json exactly like the other capture hooks", () => {
    const manifest = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8")) as {
      hooks: Record<string, unknown>;
    };
    expect(manifest.hooks.PermissionRequest).toBeDefined();
    // Same url, timeout, token header and allowedEnvVars — a missing
    // allowedEnvVars would send an empty token and 401 every request.
    expect(manifest.hooks.PermissionRequest).toEqual(manifest.hooks.PreToolUse);
  });

  it("blocks nothing by itself: the agent is still running the tool it asked for", () => {
    const h = harness();
    h.at(pre.afterMs);
    h.hook(pre.payload);
    h.at(request.afterMs);
    const r = h.hook(request.payload);
    expect(r.becameBlocked).toBeUndefined();
    expect(h.agent()).toMatchObject({
      state: "tool-running",
      tool: "Bash",
      blockedReason: null,
      dialogSince: request.afterMs,
    });
    expect(h.registry.blockedCount()).toBe(0);
  });

  it("a background agent's ask that Claude denies itself never blocks and never alerts", async () => {
    // Claude runs PermissionRequest hooks for an ask that cannot show a
    // dialog (`shouldAvoidPermissionPrompts`), then denies it. Blocking on the
    // claim alerted at 5 s whenever the agent's next event was further off.
    const h = harness();
    h.at(0);
    h.hook({ ...pre.payload, agent_id: SUB });
    h.hook({ ...request.payload, agent_id: SUB });
    // The session is busy, the parent waiting on its agent: no dialog, ever.
    h.at(2_300);
    h.poll("busy", 2_000);
    h.at(5_000);
    await h.loop.pulse();
    h.at(6_000);
    h.hook({ ...pre.payload, agent_id: SUB, tool_use_id: "toolu_next" });
    await h.loop.pulse();
    expect(h.sent).toEqual([]);
    expect(h.agent(SESSION, SUB)).toMatchObject({ state: "tool-running", dialogSince: null });
  });

  it("an unseen claim in a session that stays busy never alerts, however long", async () => {
    const h = harness();
    h.at(0);
    h.hook({ ...pre.payload, agent_id: SUB });
    h.hook({ ...request.payload, agent_id: SUB });
    await h.pollFor("busy", 2_000, 10 * 60_000);
    expect(h.sent).toEqual([]);
    expect(h.registry.blockedCount()).toBe(0);
  });
});

describe("a claimed dialog blocks once it is seen, dated from the claim", () => {
  it("the Notification sees it: blocked since the PermissionRequest, and the wait banked as blocked", () => {
    const h = harness();
    h.at(pre.afterMs);
    h.hook(pre.payload);
    h.at(request.afterMs);
    h.hook(request.payload);

    h.at(notification.afterMs);
    const r = h.hook(notification.payload);
    expect(r.becameBlocked).toEqual({ sessionId: SESSION, agentId: SESSION, kind: "permission_prompt" });
    expect(h.agent()).toMatchObject({
      state: "blocked",
      blockedReason: "permission_prompt",
      stateSince: request.afterMs,
      // The claim the block came from, kept for as long as the block lasts.
      dialogSince: request.afterMs,
      tool: null,
      // MOD-05 — working only until the dialog was claimed.
      activeMs: request.afterMs - pre.afterMs,
    });
  });

  it("the listing sees it: blocked since the claim, and the Notification later changes nothing", () => {
    const h = harness();
    h.at(pre.afterMs);
    h.hook(pre.payload);
    h.at(request.afterMs);
    h.hook(request.payload);

    h.at(request.afterMs + 1_300);
    h.seen(request.afterMs + 1_000);
    expect(h.agent()).toMatchObject({
      state: "blocked",
      blockedReason: "permission_prompt",
      stateSince: request.afterMs,
      dialogSince: request.afterMs,
      dialogSeenAt: request.afterMs + 1_000,
      tool: null,
      toolPath: null,
      activeMs: request.afterMs - pre.afterMs,
    });
    expect(h.registry.blockedCount()).toBe(1);

    h.at(notification.afterMs);
    const again = h.hook(notification.payload);
    expect(again.becameBlocked, "not a second interruption").toBeUndefined();
    expect(h.agent()?.stateSince, "blocked since the dialog was claimed").toBe(request.afterMs);
  });

  it("a poll begun before the claim cannot see its dialog, however late it lands", () => {
    const h = harness();
    h.at(10_000);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(12_000);
    h.seen(9_999);
    expect(h.agent()?.state).toBe("tool-running");
    h.seen(10_000);
    expect(h.agent()).toMatchObject({ state: "blocked", stateSince: 10_000 });
  });

  it("`waiting` for anything but a permission dialog sees nothing", () => {
    // `"input needed"` is also what an MCP elicitation queued behind a dialog
    // reads, whatever is on top; the others are not a tool's dialog at all.
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    for (const waitingFor of [
      "input needed",
      "dialog open",
      "worker request",
      "sandbox request",
      undefined,
    ]) {
      h.at(2_300);
      h.poll("waiting", 2_000, { waitingFor });
      expect(h.agent()?.state, String(waitingFor)).toBe("tool-running");
    }
    expect(h.agent()?.dialogSince).toBe(0);
    expect(h.agent()?.dialogSeenAt).toBeNull();
  });

  it("a Notification with no claim blocks from when it arrived, as it always did", () => {
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.at(7_000);
    const r = h.hook(notification.payload);
    expect(r.becameBlocked).toBeDefined();
    expect(h.agent()?.stateSince).toBe(7_000);
  });

  it("a claim the agent moved on from is not what a later Notification dates from", () => {
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(2_000);
    h.hook(post);
    expect(h.agent()).toMatchObject({ state: "thinking", dialogSince: null });
    h.at(9_000);
    h.hook(notification.payload);
    expect(h.agent()).toMatchObject({ state: "blocked", stateSince: 9_000 });
  });

  it("a claim for an agent already blocked leaves its block, and its date, alone", () => {
    // A second ask while the first dialog is open (parallel tool calls). The
    // claim is the agent's newest, and its sighting is of the earlier dialog.
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(300);
    h.seen(0);
    h.at(3_000);
    h.hook(request.payload);
    expect(h.agent()).toMatchObject({
      state: "blocked",
      stateSince: 0,
      dialogSince: 3_000,
      dialogSeenAt: null,
    });
  });

  it("a block dated from its claim never reaches back past a state the agent has been in since", () => {
    // The agent decayed to idle while its dialog sat unseen (a session whose
    // listing reads `input needed` is not busy); MOD-05 banked that. Only
    // inside the claim's window, so with a decay quicker than the default.
    const h = harness({ idleAfterMs: 3_000 });
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(1_300);
    h.poll("waiting", 1_000, { waitingFor: "input needed" });
    h.at(4_000);
    h.registry.tick();
    expect(h.agent()).toMatchObject({ state: "idle", stateSince: 4_000, activeMs: 4_000 });
    h.at(6_400);
    h.hook(notification.payload);
    expect(h.agent()).toMatchObject({ state: "blocked", stateSince: 4_000, activeMs: 4_000 });
    h.at(8_000);
    h.hook(post);
    expect(h.agent()?.blockedMs).toBe(4_000);
  });

  it("a listing that finds the session idle drops the claim — begun a second after it, not sooner", () => {
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(1_300);
    h.poll("idle", 999);
    expect(h.agent()?.dialogSince, "may describe the session before the dialog was up").toBe(0);
    h.poll("idle", 1_000);
    expect(h.agent()?.dialogSince).toBeNull();
    // So a Notification for some later dialog is not dated from it.
    h.at(9_000);
    h.hook(notification.payload);
    expect(h.agent()?.stateSince).toBe(9_000);
  });
});

describe("PSH-16 — Claude's dwell counts from the claim", () => {
  it("seen by a poll a second in: no alert at 4.9 s, an alert at 5 s — before the Notification fired", async () => {
    expect(CAPABILITIES.claude.blockDwellMs).toBe(5_000);
    const h = harness();
    h.at(pre.afterMs);
    h.hook(pre.payload);
    h.at(request.afterMs);
    h.hook(request.payload);
    h.at(request.afterMs + 1_300);
    h.seen(request.afterMs + 1_000);

    h.at(request.afterMs + 4_900);
    await h.loop.pulse();
    expect(h.alerts()).toHaveLength(0);

    h.at(request.afterMs + 5_000);
    await h.loop.pulse();
    expect(h.alerts()).toHaveLength(1);
    expect(h.alerts()[0]?.reason).toBe("permission_prompt");
    expect(request.afterMs + 5_000).toBeLessThan(notification.afterMs);

    // The Notification is the same block, not a new one.
    h.at(notification.afterMs);
    h.hook(notification.payload);
    await h.loop.pulse();
    expect(h.alerts()).toHaveLength(1);
    expect(h.agent()?.announcedAt).toBe(request.afterMs + 5_000);
  });

  it("unseen until its Notification (no listing, or AskUserQuestion's `input needed`): alerts as it arrives", async () => {
    const h = harness();
    h.at(pre.afterMs);
    h.hook(pre.payload);
    h.at(request.afterMs);
    h.hook({ ...request.payload, tool_name: "AskUserQuestion" });
    h.at(request.afterMs + 5_300);
    h.poll("waiting", request.afterMs + 5_000, { waitingFor: "input needed" });
    await h.loop.pulse();
    expect(h.alerts()).toHaveLength(0);

    h.at(notification.afterMs);
    h.hook(notification.payload);
    await h.loop.pulse();
    // Not five seconds after the Notification, as before #86.
    expect(h.alerts()).toHaveLength(1);
    expect(h.agent()?.announcedAt).toBe(notification.afterMs);
  });
});

describe("the listing ends a block no hook will", () => {
  /** The dialog is claimed at t = 0 and seen by a poll begun then. */
  function seenAtZero() {
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(300);
    h.seen(0);
    expect(h.agent()?.state).toBe("blocked");
    return h;
  }

  it("Esc: idle — the agent hands the floor back and the alert is resolved", async () => {
    // Esc at the dialog fires no hook at all. Without the listing the agent
    // stayed blocked, and reminding, until the session next did something.
    const h = seenAtZero();
    h.at(2_300);
    h.seen(2_000);
    expect(h.agent()?.state).toBe("blocked");

    h.at(5_000);
    await h.loop.pulse();
    expect(h.alerts()).toHaveLength(1);
    expect(h.agent()?.announcedAt).toBe(5_000);

    // Esc at ~6 s; the next poll begins at 7 s and lands at 7.3 s.
    h.at(7_300);
    h.poll("idle", 7_000);
    expect(h.agent()).toMatchObject({
      state: "waiting",
      blockedReason: null,
      announcedAt: null,
      // MOD-05 — the wait is banked through transition(), up to now.
      blockedMs: 7_300,
    });
    expect(h.registry.blockedCount()).toBe(0);

    await h.loop.pulse();
    expect(h.kinds()).toEqual(["blocked", "resolved"]);

    // And it stays resolved: no reminder for a prompt that is gone.
    h.at(5 * 60_000);
    await h.loop.pulse();
    expect(h.kinds()).toEqual(["blocked", "resolved"]);
  });

  it("`shell` — Claude's idle with a background shell running — ends it like idle", () => {
    // Claude's session file says `shell`; `--json` folds it into `busy` today,
    // so this is the word, should it ever arrive.
    const h = seenAtZero();
    h.at(3_300);
    h.poll("shell", 3_000);
    expect(h.agent()).toMatchObject({ state: "waiting", blockedReason: null });
  });

  it("an idle from a poll begun inside the block's first second does not end it", () => {
    // Dated from the claim, so a block seen by its Notification is held to
    // the same second from the dialog as one seen by the listing.
    const h = harness();
    h.at(10_000);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(16_400);
    h.hook(notification.payload);
    expect(h.agent()?.stateSince).toBe(10_000);

    h.at(17_000);
    h.poll("idle", 9_000);
    expect(h.agent()?.state).toBe("blocked");
    h.poll("idle", 10_999);
    expect(h.agent()?.state).toBe("blocked");
    h.poll("idle", 11_000);
    expect(h.agent()?.state).toBe("waiting");
  });

  it("approved, then a long tool: seen, then busy — tool-running, and no false alert", async () => {
    // Approving fires nothing until the tool finishes, so a ten-minute build
    // after a two-second approval read as ten minutes of being ignored.
    const h = seenAtZero();
    // Approved at ~2 s; the next poll begins at 4 s.
    h.at(4_300);
    h.poll("busy", 4_000);
    expect(h.agent()).toMatchObject({ state: "tool-running", blockedReason: null, blockedMs: 4_300 });

    await h.pollFor("busy", 9_000, 10 * 60_000);
    expect(h.agent()?.state).toBe("tool-running");
    expect(h.sent).toEqual([]);

    // The tool's own PostToolUse closes it as usual.
    h.hook(post);
    expect(h.agent()?.state).toBe("thinking");
  });

  it("an announced block answered with a long tool behind it is resolved once the listing sees it working", async () => {
    const h = seenAtZero();
    h.at(5_000);
    await h.loop.pulse();
    h.at(7_300);
    h.poll("busy", 7_000);
    expect(h.agent()?.state).toBe("tool-running");
    await h.loop.pulse();
    expect(h.kinds()).toEqual(["blocked", "resolved"]);
  });

  it("approved before any poll saw the dialog, a long tool raises no alert at all", async () => {
    // Formerly a known limitation: the claim blocked, the 5 s dwell fired, and
    // only a busy 10 s in resolved it. Nothing ever saw this dialog, so it
    // never blocked — as before #86, when the Notification never came.
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    // Approved at ~2 s. The tool runs for ten minutes.
    await h.pollFor("busy", 4_000, 10 * 60_000);
    expect(h.sent).toEqual([]);
    expect(h.agent()?.state).toBe("tool-running");
  });

  it("a block seen by the Notification and then by the listing is answered by a later busy", () => {
    const h = harness();
    h.at(pre.afterMs);
    h.hook(pre.payload);
    h.at(request.afterMs);
    h.hook(request.payload);
    h.at(notification.afterMs);
    h.hook(notification.payload);
    h.at(notification.afterMs + 600);
    h.seen(notification.afterMs + 300);
    expect(h.agent()?.dialogSeenAt).toBe(notification.afterMs + 300);
    h.at(notification.afterMs + 5_600);
    h.poll("busy", notification.afterMs + 5_300);
    expect(h.agent()?.state).toBe("tool-running");
  });

  it("busy with no sighting never ends a block — AskUserQuestion read busy while its question was open", () => {
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook({ ...request.payload, tool_name: "AskUserQuestion" });
    h.at(6_400);
    h.hook(notification.payload);
    expect(h.agent()?.state).toBe("blocked");
    for (const at of [7_000, 12_000, 60_000]) {
      h.at(at + 300);
      h.poll("busy", at);
      expect(h.agent()?.state, `busy begun at ${at}`).toBe("blocked");
    }
  });

  it("a waiting the listing showed for an EARLIER dialog does not make a later busy an answer", () => {
    const h = seenAtZero();
    h.at(2_300);
    h.seen(2_000);
    // That dialog is answered and its tool finishes, the ordinary way.
    h.at(3_000);
    h.hook(post);
    expect(h.agent()?.state).toBe("thinking");

    // A second dialog is claimed, and seen by its Notification.
    h.at(4_000);
    h.hook(pre.payload);
    h.hook(request.payload);
    expect(h.agent()?.dialogSeenAt, "forgotten when the block ended").toBeNull();
    h.at(10_400);
    h.hook(notification.payload);
    // A poll begun before the claim lands after it, about the first dialog.
    h.seen(3_500);
    // Then the listing trails the hook and says `busy`.
    h.at(10_600);
    h.poll("busy", 10_500);
    expect(h.agent()?.state).toBe("blocked");
  });

  it("so does a new block that came with no claim", () => {
    // A Notification alone: a session started before PermissionRequest was
    // registered sends no claim. A `busy` that trails it may be about it.
    const h = seenAtZero();
    h.at(2_300);
    h.seen(2_000);
    h.at(3_000);
    h.hook(post);
    h.at(9_000);
    h.hook(notification.payload);
    expect(h.agent()).toMatchObject({
      state: "blocked",
      stateSince: 9_000,
      dialogSince: null,
      dialogSeenAt: null,
    });
    h.at(10_300);
    h.poll("busy", 10_000);
    expect(h.agent()?.state).toBe("blocked");
  });

  it("another agent's claim leaves this agent's sighting: a busy after it is still this dialog's answer", () => {
    // Formerly a new claim forgot every agent's sighting (#86 review): then an
    // approved command ran on as an unanswered prompt, reminding for as long
    // as it ran. A `busy` means nothing is on screen — another agent's dialog
    // would read `waiting` as surely as this one.
    const h = seenAtZero();
    h.at(2_300);
    h.seen(2_000);
    h.at(3_000);
    h.hook(subPre(SUB));
    h.hook(subClaim(SUB));
    expect(h.agent(SESSION, SUB)).toMatchObject({ state: "tool-running", dialogSince: 3_000 });
    expect(h.agent()?.dialogSeenAt).toBe(2_000);

    h.at(4_300);
    h.poll("busy", 4_000);
    expect(h.agent()?.state).toBe("tool-running");

    // A sighting inside the subagent's window sees its dialog, dated from its
    // own claim, and `busy` after it answers that.
    h.at(9_300);
    h.seen(9_000);
    expect(h.agent(SESSION, SUB)).toMatchObject({ state: "blocked", stateSince: 3_000 });
    expect(h.registry.blockedCount()).toBe(1);
    h.at(14_300);
    h.poll("busy", 14_000);
    expect(h.registry.blockedCount()).toBe(0);
  });

  it("a sighting begun as the block began counts; a busy begun at that same instant is no answer", () => {
    const h = seenAtZero();
    expect(h.agent()?.dialogSeenAt).toBe(0);
    expect(h.agent()?.stateSince).toBe(0);
    h.at(5_300);
    h.poll("busy", 0);
    expect(h.agent()?.state, "asked at the same instant as the sighting").toBe("blocked");
    h.poll("busy", 1);
    expect(h.agent()?.state).toBe("tool-running");
  });

  it("overlapping polls: the latest sighting holds, whatever order the answers land in", () => {
    // Polls overlap, and one begun earlier can land later. A busy begun
    // between two sightings says nothing about the dialog the later one saw.
    const h = seenAtZero();
    h.at(5_100);
    h.seen(5_000);
    h.at(5_200);
    h.seen(4_000);
    expect(h.agent()?.dialogSeenAt).toBe(5_000);
    h.at(5_300);
    h.poll("busy", 4_500);
    expect(h.agent()?.state).toBe("blocked");
  });

  it("a busy from a poll begun before the sighting is not an answer", () => {
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(6_000);
    h.seen(5_000);
    h.at(6_100);
    h.poll("busy", 4_000);
    expect(h.agent()?.state).toBe("blocked");
  });

  it("remembers nothing while nothing is claimed or blocked", () => {
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.at(2_300);
    h.seen(2_000);
    expect(h.agent()?.dialogSeenAt).toBeNull();
  });

  it("an incomplete listing clears only what it saw — whatever the unseen session said before", () => {
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook({ ...pre.payload, session_id: "other-session" });
    h.at(1_000);
    h.hook(request.payload);
    h.hook({ ...request.payload, session_id: "other-session" });
    h.at(7_400);
    h.hook(notification.payload);
    h.hook({ ...notification.payload, session_id: "other-session" });
    expect(h.registry.blockedCount()).toBe(2);
    // A poll begun before either dialog was up lands now: both `idle`, which
    // ends nothing, but is what each session last said.
    h.at(7_500);
    h.poll(null, 500, { rows: [listed("idle"), listed("idle", "other-session")] });
    expect(h.registry.blockedCount()).toBe(2);
    expect(h.registry.get(SESSION)?.status).toBe("idle");

    h.at(8_300);
    h.poll(null, 8_000, { complete: false, rows: [listed("idle", "other-session")] });
    expect(h.agent("other-session")?.state).toBe("waiting");
    expect(h.agent()?.state, "absent from an incomplete view is not evidence").toBe("blocked");
    expect(h.registry.get(SESSION)).toBeDefined();
  });

  it("a session the listing has never reported is untouched", () => {
    // Seen by its Notification, so discovery has never vouched for it either:
    // a complete listing without it neither settles nor prunes it.
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(6_400);
    h.hook(notification.payload);
    h.at(7_300);
    h.poll(null, 7_000, { rows: [listed("idle", "someone-else")] });
    expect(h.agent()?.state).toBe("blocked");
  });

  it("only ends a permission prompt: another agent needing input is not this session's dialog", () => {
    const h = harness();
    h.at(0);
    h.hook({ ...notification.payload, notification_type: "agent_needs_input" });
    expect(h.agent()).toMatchObject({ state: "blocked", blockedReason: "agent_needs_input" });
    h.at(3_300);
    h.poll("idle", 3_000);
    expect(h.agent()?.state).toBe("blocked");
  });

  it("KNOWN LIMITATION: Esc with a background shell or agent running reads as an approved tool", () => {
    // `--json` reports such a session `busy`, which after a sighting is what an
    // approval looks like. The block still ends and its alert is resolved; the
    // agent reads `tool-running` until its next event. If this starts failing,
    // the limitation is fixed: rename the test and update the CHANGELOG.
    const h = seenAtZero();
    h.at(7_300);
    h.poll("busy", 7_000);
    expect(h.agent()?.state).toBe("tool-running");
  });
});

describe("a session whose listing can see no dialog behaves as before #86", () => {
  // An MCP elicitation queued behind a dialog makes Claude report `waiting` /
  // `"input needed"` for as long as it waits, whatever else happens — four of
  // thirteen sessions read so on the machine this was measured on, one of
  // them while working. The listing then never says `idle` or `busy`.
  const MASKED = "input needed";

  it("Esc before the Notification: never blocked, nothing sent", async () => {
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.at(1_300);
    h.poll("waiting", 1_000, { waitingFor: MASKED });
    h.at(2_000);
    h.hook(request.payload);
    // Esc at ~3 s: no hook, and no Notification, which comes only while the
    // dialog is still up.
    await h.pollFor("waiting", 6_000, 5 * 60_000, MASKED);
    expect(h.sent).toEqual([]);
    expect(h.registry.blockedCount()).toBe(0);
  });

  it("KNOWN LIMITATION: Esc after the Notification stays blocked until the session's next event", async () => {
    // As before #86: nothing says the dialog has gone. If this starts failing,
    // the limitation is fixed: rename the test and update the CHANGELOG.
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(6_400);
    h.hook(notification.payload);
    await h.pollFor("waiting", 7_000, 60_000, MASKED);
    expect(h.agent()?.state).toBe("blocked");
    expect(h.kinds()).toEqual(["blocked"]);
    h.at(61_000);
    h.hook({ ...pre.payload, tool_use_id: "toolu_next" });
    await h.loop.pulse();
    expect(h.kinds()).toEqual(["blocked", "resolved"]);
  });
});

describe("the Notification names no agent: it is the claimed dialog's (#86 review)", () => {
  // Claude 2.1.312 builds the Notification hook input with no agent context
  // (`lf(e,Ug())`), so it never carries an agent_id and normalizes to the main
  // agent; PermissionRequest is built with one (`lf(…,s)`). The fixture's
  // Notification has none, and nothing here adds one.
  it("the fixture's Notification carries no agent_id", () => {
    expect(notification.payload).not.toHaveProperty("agent_id");
  });

  it("a subagent's dialog the listing saw: the Notification confirms it, the parent is never blocked, one alert", async () => {
    const h = harness();
    h.at(0);
    h.hook(spawn);
    h.hook(subPre(SUB));
    h.hook(subClaim(SUB));
    h.at(1_300);
    h.seen(1_000);
    expect(h.agent(SESSION, SUB)?.state).toBe("blocked");
    h.at(5_000);
    await h.loop.pulse();

    h.at(6_400);
    const r = h.hook(notification.payload);
    expect(r.becameBlocked, "the dialog it is about is already blocked").toBeUndefined();
    expect(h.agent()).toMatchObject({ state: "tool-running", tool: "Agent", blockedReason: null });
    expect(h.registry.blockedCount(), "one dialog, one block").toBe(1);

    // Approved at ~8 s; every poll after reads busy.
    await h.pollFor("busy", 11_000, 5 * 60_000);
    expect(h.sent.map((e) => `${e.kind}:${who(e)}`)).toEqual([`blocked:${SUB}`, `resolved:${SUB}`]);
    expect(h.agent(SESSION, SUB)?.state).toBe("tool-running");
    expect(h.agent()?.state).toBe("tool-running");
  });

  it("a subagent's dialog nothing saw yet: the Notification blocks the subagent, dated from its claim", () => {
    const h = harness();
    h.at(0);
    h.hook(spawn);
    h.at(1_000);
    h.hook(subPre(SUB));
    h.hook(subClaim(SUB));
    h.at(7_400);
    const r = h.hook(notification.payload);
    expect(r.becameBlocked).toEqual({ sessionId: SESSION, agentId: SUB, kind: "permission_prompt" });
    expect(h.agent(SESSION, SUB)).toMatchObject({
      state: "blocked",
      blockedReason: "permission_prompt",
      stateSince: 1_000,
    });
    expect(h.agent()).toMatchObject({ state: "tool-running", tool: "Agent", blockedReason: null });
  });

  it("several open claims: the most recent one's", () => {
    const h = harness();
    h.at(0);
    h.hook(spawn);
    h.hook(subPre(SUB));
    h.hook(subClaim(SUB));
    h.at(2_000);
    h.hook(subPre(SUB2));
    h.hook(subClaim(SUB2));
    h.at(8_400);
    expect(h.hook(notification.payload).becameBlocked?.agentId).toBe(SUB2);
    expect(h.agent(SESSION, SUB2)).toMatchObject({ state: "blocked", stateSince: 2_000 });
    expect(h.agent(SESSION, SUB)).toMatchObject({ state: "tool-running", dialogSince: 0 });
    expect(h.agent()?.state).toBe("tool-running");
    expect(h.registry.blockedCount()).toBe(1);
  });

  it("…of those old enough for it: Claude sends it once its dialog has been up 6 s (#86 verification)", () => {
    // 4.4 s after the newer claim, it can only be about the older one.
    const h = harness();
    h.at(0);
    h.hook(spawn);
    h.hook(subPre(SUB));
    h.hook(subClaim(SUB));
    h.at(2_000);
    h.hook(subPre(SUB2));
    h.hook(subClaim(SUB2));
    h.at(6_400);
    expect(h.hook(notification.payload).becameBlocked?.agentId).toBe(SUB);
    expect(h.agent(SESSION, SUB)).toMatchObject({ state: "blocked", stateSince: 0 });
    expect(h.agent(SESSION, SUB2)).toMatchObject({ state: "tool-running", dialogSince: 2_000 });
  });

  it("…and with none old enough, the main agent's, as with no claim at all (#86 verification)", () => {
    // A dialog that sends no claim (plan approval, say) while a subagent's
    // ask is a second old.
    const h = harness();
    h.at(0);
    h.hook(spawn);
    h.at(5_000);
    h.hook(subPre(SUB));
    h.hook(subClaim(SUB));
    h.at(6_000);
    expect(h.hook(notification.payload).becameBlocked?.agentId).toBe(SESSION);
    expect(h.agent(SESSION, SUB)).toMatchObject({ state: "tool-running", dialogSince: 5_000 });
  });

  it("no claim anywhere: the main agent's, as before", () => {
    const h = harness();
    h.at(0);
    h.hook(spawn);
    h.hook(subPre(SUB));
    h.at(7_000);
    expect(h.hook(notification.payload).becameBlocked?.agentId).toBe(SESSION);
    expect(h.agent(SESSION, SUB)?.state).toBe("tool-running");
  });

  it("a Notification taken for a subagent's changes nothing else about it: its identity stands", () => {
    const h = harness();
    h.at(0);
    h.hook(spawn);
    h.hook({
      session_id: SESSION,
      cwd: CWD,
      hook_event_name: "SubagentStart",
      agent_id: SUB,
      agent_type: "Explore",
    });
    h.hook(subPre(SUB));
    h.hook(subClaim(SUB));
    const before = { ...h.agent(SESSION, SUB) };
    expect(before).toMatchObject({ agentType: "Explore", parentSource: "inferred", parentId: null });
    h.at(6_400);
    h.hook(notification.payload);
    expect(h.agent(SESSION, SUB)).toMatchObject({
      state: "blocked",
      agentType: before.agentType,
      parentSource: before.parentSource,
      parentId: before.parentId,
    });
  });
});

describe("a sighting belongs to each blocked agent, not to the session (#86 review)", () => {
  it("another agent's claim after the sighting leaves it: an approved long tool is not a stuck prompt", async () => {
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(1_300);
    h.seen(1_000);
    expect(h.agent()?.state).toBe("blocked");
    // A background agent asks, and Claude denies it itself; its next turn
    // ends its claim.
    h.at(3_000);
    h.hook(subPre(SUB2));
    h.hook(subClaim(SUB2));
    h.at(3_500);
    h.hook(subPre(SUB2, "toolu_bg2"));
    // The main agent is approved at 4 s, and its command runs ten minutes.
    await h.pollFor("busy", 6_000, 10 * 60_000);
    expect(h.agent()?.state).toBe("tool-running");
    expect(h.sent).toEqual([]);
  });

  it("two queued prompts answered inside one poll interval: no reminders for either", async () => {
    const h = harness();
    h.at(0);
    h.hook(spawn);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(1_300);
    h.seen(1_000);
    // A parallel subagent's prompt queues behind the main agent's.
    h.at(3_000);
    h.hook(subPre(SUB));
    h.hook(subClaim(SUB));
    // Main approved at 4 s, the subagent at 5 s, whose short command ends.
    h.at(5_500);
    h.hook({ ...post, agent_id: SUB, tool_use_id: `toolu_${SUB}` });
    await h.pollFor("busy", 6_000, 10 * 60_000);
    expect(h.agent()?.state).toBe("tool-running");
    expect(h.agent(SESSION, SUB)?.state).toBe("thinking");
    expect(h.sent).toEqual([]);
  });

  it("the blocked agent's own new claim is a dialog nobody has seen: a busy needs a sighting after it", () => {
    // Parallel tool calls: a second ask while the first dialog is open.
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(1_300);
    h.seen(1_000);
    h.at(3_000);
    h.hook(request.payload);
    expect(h.agent()).toMatchObject({ state: "blocked", stateSince: 0, dialogSeenAt: null });
    h.at(4_300);
    h.poll("busy", 4_000);
    expect(h.agent()?.state, "the second dialog may not be up yet").toBe("blocked");
    h.at(6_300);
    h.seen(6_000);
    h.at(11_300);
    h.poll("busy", 11_000);
    expect(h.agent()?.state).toBe("tool-running");
  });
});

describe(`a claim lasts ${CLAIM_WINDOW_MS / 1000} s, and a sighting is the newest claim's (#86 review)`, () => {
  it("the window covers the first poll that can see a dialog and the Notification", () => {
    expect(CLAIM_WINDOW_MS).toBe(10_000);
    // The Notification: ~6.4 s after the claim here, ~6.2 s in #86's table.
    expect(notification.afterMs - request.afterMs).toBeLessThan(CLAIM_WINDOW_MS);
    // A poll begins every 5 s; the first one begun after the claim may come
    // before the dialog is up (~0.4 s in), and the next is still inside.
    expect(5_000 + 1_000).toBeLessThan(CLAIM_WINDOW_MS);
  });

  it("a quickly approved subagent's claim is not revived by a sibling's dialog 40 s later", async () => {
    const h = harness();
    h.at(0);
    h.hook(spawn);
    h.at(100);
    h.hook(subPre(SUB));
    h.hook(subClaim(SUB));
    // Approved at ~1.5 s, before any poll saw it. Its command runs on.
    await h.pollFor("busy", 2_000, 37_000);
    expect(h.agent(SESSION, SUB)).toMatchObject({ state: "tool-running", dialogSince: null });

    h.at(40_000);
    h.hook(subPre(SUB2));
    h.hook(subClaim(SUB2));
    h.at(42_300);
    h.seen(42_000);
    expect(h.agent(SESSION, SUB)?.state).toBe("tool-running");
    expect(h.agent(SESSION, SUB2)).toMatchObject({ state: "blocked", stateSince: 40_000 });
    h.at(42_400);
    await h.loop.pulse();
    expect(h.alerts(), "no alert skips the dwell").toHaveLength(0);
    h.at(45_000);
    await h.loop.pulse();
    expect(h.alerts().map(who)).toEqual([SUB2]);

    h.at(60_000);
    h.hook({ ...post, agent_id: SUB, tool_use_id: `toolu_${SUB}` });
    expect(h.agent(SESSION, SUB)?.blockedMs, "its running time is not banked as blocked").toBe(0);
  });

  it("inside the window: two sightings still block only the newest claim", async () => {
    const h = harness();
    h.at(0);
    h.hook(spawn);
    h.hook(subPre(SUB));
    h.hook(subClaim(SUB)); // approved at ~1 s, unseen
    h.at(2_000);
    h.hook(subPre(SUB2));
    h.hook(subClaim(SUB2));
    h.at(3_300);
    h.seen(3_000);
    h.at(8_300);
    h.seen(8_000);
    expect(h.agent(SESSION, SUB)?.state).toBe("tool-running");
    expect(h.agent(SESSION, SUB2)).toMatchObject({ state: "blocked", stateSince: 2_000 });
    for (const at of [7_000, 9_000]) {
      h.at(at);
      await h.loop.pulse();
    }
    expect(h.alerts().map(who)).toEqual([SUB2]);
  });

  it("a background agent's denied ask does not take the main agent's dialog", async () => {
    const h = harness();
    h.at(0);
    h.hook(subPre(SUB2));
    h.hook(subClaim(SUB2)); // Claude denies it itself
    h.at(1_000);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(3_300);
    h.seen(3_000);
    expect(h.agent(SESSION, SUB2)?.state).toBe("tool-running");
    expect(h.agent()).toMatchObject({ state: "blocked", stateSince: 1_000 });
    h.at(6_000);
    await h.loop.pulse();
    h.at(8_000);
    h.hook(subPre(SUB2, "toolu_bg2"));
    h.at(8_100);
    await h.loop.pulse();
    expect(h.sent.map((e) => `${e.kind}:${who(e)}`)).toEqual(["blocked:main"]);
  });

  it("a claim is dropped at the window's end, and a sighting begun then blocks nothing", () => {
    const inside = harness();
    inside.at(0);
    inside.hook(pre.payload);
    inside.hook(request.payload);
    inside.at(CLAIM_WINDOW_MS + 300);
    inside.seen(CLAIM_WINDOW_MS - 1);
    expect(inside.agent()).toMatchObject({ state: "blocked", stateSince: 0 });

    const after = harness();
    after.at(0);
    after.hook(pre.payload);
    after.hook(request.payload);
    after.at(CLAIM_WINDOW_MS + 300);
    after.seen(CLAIM_WINDOW_MS);
    expect(after.agent()).toMatchObject({ state: "tool-running", dialogSince: null });
  });

  it("a Notification after the window is dated from its arrival, not from a claim that lapsed", () => {
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(CLAIM_WINDOW_MS);
    h.hook(notification.payload);
    expect(h.agent()).toMatchObject({ state: "blocked", stateSince: CLAIM_WINDOW_MS });
  });

  it("an older claim passed over for a newer one is seen once the newer one's block is gone", async () => {
    // A background agent's ask that Claude denies itself, made while the main
    // agent's dialog is up and unseen, is taken for the dialog: it is the
    // newer claim. The main agent's claim is held by that sighting rather than
    // left to lapse; the background agent's next event ends its block, and the
    // next sighting finds the main agent's. Late by as long as the background
    // agent took, never lost — and earlier still if the Notification comes.
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(1_000);
    h.hook(subPre(SUB2));
    h.hook(subClaim(SUB2));
    h.at(2_300);
    h.seen(2_000);
    expect(h.agent(SESSION, SUB2)?.state).toBe("blocked");
    expect(h.agent()?.state).toBe("tool-running");
    h.at(3_000);
    h.hook(subPre(SUB2, "toolu_bg2"));
    h.at(7_300);
    h.seen(7_000);
    expect(h.agent()).toMatchObject({ state: "blocked", stateSince: 0 });
    await h.loop.pulse();
    expect(h.sent.map((e) => `${e.kind}:${who(e)}`)).toEqual(["blocked:main"]);
  });
});

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

describe("a dialog on screen is never lost to a newer claim (#86 verification)", () => {
  // A claim with no dialog behind it — a background ask Claude denies itself
  // (resume, fork, dontAsk/plan) — made after the main agent's real claim and
  // before anything saw it. A sighting takes the newest claim, so it took the
  // background agent's; the Notification, which names no agent, took it too;
  // the main agent's claim then lapsed, and its prompt sat on screen with no
  // block and no alert.

  it("the Notification of the older dialog is the older claim's: a claim younger than the wait it reports is not it", async () => {
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload); // the main agent's real dialog, up until 59 s
    h.at(300);
    h.poll("busy", 0); // begun before the dialog was up
    h.at(1_000);
    await h.loop.pulse();
    h.at(3_000);
    h.hook(subPre(SUB2));
    h.hook(subClaim(SUB2)); // Claude denies this ask itself: no dialog
    h.at(5_300);
    h.seen(5_000);
    h.at(6_000);
    await h.loop.pulse();
    h.at(6_400);
    // Claude sends it once the dialog has been up 6 s: 3.4 s after the
    // background agent's claim, it cannot be about that one.
    expect(h.hook(notification.payload).becameBlocked?.agentId).toBe(SESSION);
    expect(h.agent()).toMatchObject({ state: "blocked", stateSince: 0 });
    h.at(7_000);
    h.hook(subPre(SUB2, "toolu_bg2")); // its next turn
    await h.loop.pulse();
    await h.pollFor("waiting", 10_000, 55_000, DIALOG);
    expect(h.agent()).toMatchObject({ state: "blocked", stateSince: 0 });
    expect(h.sent.map((e) => `${e.kind}:${who(e)}`)).toEqual(["blocked:main"]);
  });

  it("the Notification takes back the block a sighting gave a younger claim: that was the older dialog too", async () => {
    // It says which dialog has been up these 6 s, and a claim made since is
    // not that one. So the background agent is running the tool it asked
    // for, as if never blocked, and is never alerted however late it moves on.
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
    expect(h.agent(SESSION, SUB2)?.state).toBe("blocked");
    h.at(6_400);
    h.hook(notification.payload);
    expect(h.agent(SESSION, SUB2)).toMatchObject({
      state: "tool-running",
      stateSince: 3_000,
      blockedReason: null,
      dialogSince: 3_000,
    });
    await h.pollFor("waiting", 7_000, 12_000, DIALOG);
    h.at(15_000);
    h.hook(subPre(SUB2, "toolu_bg2"));
    await h.pollFor("waiting", 17_000, 55_000, DIALOG);
    expect(h.sent.map((e) => `${e.kind}:${who(e)}`)).toEqual(["blocked:main"]);
    expect(h.agent(SESSION, SUB2)?.blockedMs, "never blocked").toBe(0);
  });

  it("a block taken back keeps its claim open for the agent's own prompt, seen or not", () => {
    // Here it was a real prompt, queued behind the main agent's. The listing
    // goes blind (an elicitation queued too), so only its own Notification,
    // 6 s after it comes up at 9 s, can see it — 12 s after its claim.
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(300);
    h.poll("busy", 0);
    h.at(3_000);
    h.hook(subPre(SUB));
    h.hook(subClaim(SUB));
    h.at(5_300);
    h.seen(5_000);
    h.at(6_400);
    h.hook(notification.payload);
    expect(h.agent(SESSION, SUB)?.state).toBe("tool-running");
    h.at(7_300);
    h.poll("waiting", 7_000, { waitingFor: "input needed" });
    h.at(9_000);
    h.hook(post);
    h.at(15_000);
    expect(h.hook(notification.payload).becameBlocked?.agentId).toBe(SUB);
    expect(h.agent(SESSION, SUB)).toMatchObject({ state: "blocked", stateSince: 3_000 });
  });

  it("with no Notification, a claim passed over for a newer one is held while a dialog stays on screen", async () => {
    // Nothing to tell the two apart until the newer block ends. The older
    // claim does not lapse in the meantime: the next sighting is its.
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
    expect(h.agent(SESSION, SUB2)?.state).toBe("blocked");
    await h.pollFor("waiting", 10_000, 15_000, DIALOG);
    expect(h.agent()).toMatchObject({ state: "tool-running", dialogSince: 0 });
    h.at(20_000);
    h.hook(subPre(SUB2, "toolu_bg2")); // 17 s after its claim
    await h.pollFor("waiting", 20_000, 30_000, DIALOG);
    expect(h.agent()).toMatchObject({ state: "blocked", stateSince: 0 });
    // KNOWN LIMITATION, as the CHANGELOG says: the background agent is taken
    // for the prompt until its next event.
    expect(story(h)).toEqual([`blocked:${SUB2}@11`, "blocked:main@21", `resolved:${SUB2}@21`]);
  });

  it("polls that land out of order hold a claim from the latest of them", () => {
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(3_000);
    h.hook(subPre(SUB2));
    h.hook(subClaim(SUB2));
    h.at(5_300);
    h.seen(5_000); // the background agent's claim takes it
    h.at(10_300);
    h.seen(10_000);
    h.at(10_500);
    h.seen(8_000); // begun earlier, landed later
    h.at(16_000);
    h.hook(subPre(SUB2, "toolu_bg2"));
    // Held from 10 s, so a sighting begun at 19.9 s is still the main agent's.
    h.at(20_200);
    h.seen(19_900);
    expect(h.agent()).toMatchObject({ state: "blocked", stateSince: 0 });
  });

  it("swept: whenever the denied ask comes and goes, the main agent's open dialog alerts and stays blocked", async () => {
    // The verification's sweep: 48 of these 120 runs never alerted the main
    // agent, and 3 sent nothing at all.
    const lost: string[] = [];
    for (const bgAt of [500, 1_500, 3_000, 5_000]) {
      for (const bgDelay of [2_000, 4_000, 6_000, 8_000, 12_000, 20_000]) {
        for (const phase of [0, 1_000, 2_000, 3_000, 4_000]) {
          const h = await run({
            hooks: [
              [0, pre.payload],
              [0, request.payload],
              [bgAt, subPre(SUB2)],
              [bgAt, subClaim(SUB2)],
              [6_400, notification.payload],
              [bgAt + bgDelay, subPre(SUB2, "toolu_bg2")],
            ],
            screen: (at) => (at >= 400 && at < 59_000 ? ["waiting", DIALOG] : ["busy"]),
            until: 58_000,
            phase,
          });
          const main = story(h).filter((s) => s.includes(":main@"));
          if (
            main[0]?.startsWith("blocked") !== true ||
            main.length !== 1 ||
            h.agent()?.state !== "blocked"
          ) {
            lost.push(`bgAt=${bgAt} bgDelay=${bgDelay} phase=${phase} ${JSON.stringify(story(h))}`);
          }
          // A claim made 1.4 s or more after the main agent's is too young for
          // the Notification at 6.4 s, which takes back any block it was given.
          // One made sooner can still take the Notification (CHANGELOG).
          if (bgAt >= 1_500 && story(h).some((s) => s.includes(SUB2))) {
            lost.push(`bgAt=${bgAt} bgDelay=${bgDelay} phase=${phase} alerted the background agent`);
          }
        }
      }
    }
    expect(lost).toEqual([]);
  });
});

describe("a sighting while a seen block stands is that block's dialog (#86 verification)", () => {
  it("a background ask Claude denies itself while the main agent's seen prompt is up is never blocked", async () => {
    for (const bgNext of [4_000, 9_000, 20_000]) {
      const h = await run({
        hooks: [
          [0, pre.payload],
          [0, request.payload],
          [3_000, subPre(SUB2)],
          [3_000, subClaim(SUB2)],
          [6_400, notification.payload],
          [bgNext, subPre(SUB2, "toolu_bg2")],
          [60_000, post],
        ],
        screen: (at) => (at >= 400 && at < 59_000 ? ["waiting", DIALOG] : ["busy"]),
        until: 70_000,
        phase: 1_000,
      });
      expect(story(h), `next event at ${bgNext}`).toEqual(["blocked:main@5", "resolved:main@60"]);
    }
  });

  it("a real prompt queued behind it is seen once the first block ends", async () => {
    // The main agent's prompt is answered at 20 s and its command is short;
    // the subagent's, queued since 3 s, is on screen from then.
    const h = await run({
      hooks: [
        [0, pre.payload],
        [0, request.payload],
        [3_000, subPre(SUB)],
        [3_000, subClaim(SUB)],
        [6_400, notification.payload],
        [21_000, post],
      ],
      screen: (at) => (at >= 400 && at < 40_000 ? ["waiting", DIALOG] : ["busy"]),
      until: 30_000,
      phase: 1_000,
    });
    expect(h.agent(SESSION, SUB)).toMatchObject({ state: "blocked", stateSince: 3_000 });
    expect(story(h)).toEqual(["blocked:main@5", "resolved:main@21", `blocked:${SUB}@22`]);
  });

  it("…or by its own Notification, while the first agent's approved command still runs", async () => {
    // The main agent's Notification came at 6.4 s; the subagent's comes once
    // its dialog has been up 6 s.
    const h = await run({
      hooks: [
        [0, pre.payload],
        [0, request.payload],
        [3_000, subPre(SUB)],
        [3_000, subClaim(SUB)],
        [6_400, notification.payload],
        [26_400, notification.payload],
      ],
      screen: (at) => (at >= 400 && at < 40_000 ? ["waiting", DIALOG] : ["busy"]),
      until: 50_000,
      phase: 1_000,
    });
    expect(story(h)).toEqual([
      "blocked:main@5",
      `blocked:${SUB}@27`,
      "resolved:main@42",
      `resolved:${SUB}@42`,
    ]);
  });
});

describe("a parent whose subagent waits on a dialog is not idle (#86 verification)", () => {
  it("the Agent tool's caller stays running while its subagent is blocked, however long", async () => {
    // The listing reads `waiting`, which is not busy, so the idle timer would
    // call the parent idle 30 s after its last event — before #86 the parent
    // was itself (wrongly) blocked, which the timer leaves alone.
    const h = harness();
    h.at(0);
    h.hook(spawn);
    h.at(100);
    h.hook(subPre(SUB));
    h.at(1_100);
    h.hook(subClaim(SUB));
    await h.pollFor("waiting", 2_000, 5_000, DIALOG);
    h.at(7_500);
    h.hook(notification.payload);
    await h.pollFor("waiting", 12_000, 90_000, DIALOG);
    expect(h.agent(SESSION, SUB)?.state).toBe("blocked");
    expect(h.agent()).toMatchObject({ state: "tool-running", tool: "Agent" });
    // And the timer still runs once nothing in the session is blocked.
    h.at(91_000);
    h.hook({ ...post, agent_id: SUB, tool_use_id: `toolu_${SUB}` });
    await h.pollFor("waiting", 95_000, 130_000, "input needed");
    expect(h.agent()?.state).toBe("idle");
  });
});

describe("a notification about another agent does not take over a permission block (#86 verification)", () => {
  for (const notificationType of ["agent_needs_input", "worker_permission_prompt"]) {
    it(`${notificationType}: the reason and the date stand, and Esc still ends it`, async () => {
      const h = harness();
      h.at(0);
      h.hook(pre.payload);
      h.hook(request.payload);
      h.at(1_300);
      h.seen(1_000);
      h.at(5_000);
      await h.loop.pulse();
      h.at(5_500);
      const r = h.hook({
        ...notification.payload,
        notification_type: notificationType,
        message: "<redacted>",
      });
      expect(r.becameBlocked).toBeUndefined();
      expect(h.agent()).toMatchObject({
        state: "blocked",
        blockedReason: "permission_prompt",
        stateSince: 0,
      });
      await h.pollFor("idle", 6_000, 5 * 60_000);
      expect(h.sent.map((e) => `${e.kind}:${e.reason}`)).toEqual([
        "blocked:permission_prompt",
        "resolved:resolved",
      ]);
      expect(h.agent()?.state).toBe("waiting");
    });
  }
});

describe("what the mutation run found no test for (#86 verification)", () => {
  it("Esc ends a seen block and takes its claim: some other dialog seen 2 s later blocks nothing", async () => {
    // Plan approval, a cross-session message, browser setup: all read
    // `"permission prompt"`, and none sends a claim.
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(1_300);
    h.seen(1_000);
    h.at(6_300);
    h.poll("idle", 6_000);
    expect(h.agent()).toMatchObject({ state: "waiting", dialogSince: null });
    h.at(8_300);
    h.seen(8_000);
    h.at(8_400);
    await h.loop.pulse();
    expect(h.agent()).toMatchObject({ state: "waiting", stateSince: 6_300 });
    expect(h.sent).toEqual([]);
  });

  it("a blocked agent's new claim: a sighting from a poll begun before it is not that dialog's", () => {
    const h = harness();
    h.at(0);
    h.hook(notification.payload); // blocked, with no claim
    h.at(2_000);
    h.hook(request.payload); // a second dialog, nobody has seen
    h.at(2_300);
    h.seen(1_000);
    expect(h.agent()?.dialogSeenAt).toBeNull();
    h.at(6_300);
    h.poll("busy", 6_000);
    expect(h.agent()?.state, "the second dialog may not be up yet").toBe("blocked");
  });

  it("a Notification after another agent's claim lapsed, with no poll since, is the main agent's", () => {
    // Discovery down: nothing but the window retires the subagent's claim.
    const h = harness();
    h.at(0);
    h.hook(spawn);
    h.hook(subPre(SUB));
    h.hook(subClaim(SUB));
    h.at(CLAIM_WINDOW_MS);
    expect(h.hook(notification.payload).becameBlocked?.agentId).toBe(SESSION);
    expect(h.agent()).toMatchObject({ state: "blocked", stateSince: CLAIM_WINDOW_MS });
    expect(h.agent(SESSION, SUB)?.state).toBe("tool-running");
  });

  it("a blocking notification of another kind on a claimed agent blocks from when it came, and drops the claim", () => {
    const h = harness();
    h.at(0);
    h.hook(spawn);
    h.hook(subPre(SUB));
    h.hook(subClaim(SUB));
    h.at(1_000);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(1_500);
    h.hook({ ...notification.payload, notification_type: "agent_needs_input", message: "<redacted>" });
    expect(h.agent()).toMatchObject({
      state: "blocked",
      blockedReason: "agent_needs_input",
      stateSince: 1_500,
      dialogSince: null,
    });
    // So the permission Notification that follows is the subagent's dialog,
    // not taken for the main agent's dropped claim.
    h.at(7_400);
    expect(h.hook(notification.payload).becameBlocked?.agentId).toBe(SUB);
  });
});

describe("/healthz counts every block, whatever began it (#86 verification)", () => {
  const TOKEN = "t".repeat(48);
  const open: Daemon[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((d) => d.close()));
  });

  it("a block the listing made is counted once, and the Notification after it adds none", async () => {
    let t = 0;
    const registry = new Registry({ nowMs: () => t });
    const d = new Daemon({ token: TOKEN, registry });
    open.push(d);
    const port = await d.listen(0);
    const send = (payload: Payload) =>
      fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    const blocked = async () =>
      ((await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as { counters: { blocked: number } })
        .counters.blocked;
    await send(pre.payload);
    await send(request.payload);
    expect(await blocked()).toBe(0);
    t = 1_300;
    registry.reconcile([listed("waiting", SESSION, DIALOG)], { provider: "claude", observedAt: 1_000 });
    expect(registry.blockedCount()).toBe(1);
    expect(await blocked()).toBe(1);
    t = 6_400;
    await send(notification.payload);
    expect(await blocked()).toBe(1);
  });
});

describe("the listing's screen is astir's word, not the provider's (CAP-02, #86 verification)", () => {
  it("discovery says what is on screen; the registry reads that and nothing else", () => {
    // A provider's own words for its statuses mean nothing to the registry.
    const row = (status: string, screen?: SessionScreen): DiscoveredSession => ({
      sessionId: SESSION,
      cwd: CWD,
      pid: 4242,
      status,
      name: "repo",
      startedAt: null,
      ...(screen === undefined ? {} : { screen }),
    });
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(1_300);
    h.poll(null, 1_000, { rows: [row("on hold", "permission-dialog")] });
    expect(h.agent()).toMatchObject({ state: "blocked", stateSince: 0 });
    h.at(3_300);
    h.poll(null, 3_000, { rows: [row("idle")] });
    expect(h.agent()?.state, "Claude's `idle`, untranslated, is no evidence").toBe("blocked");
    h.at(5_300);
    h.poll(null, 5_000, { rows: [row("whatever", "at-prompt")] });
    expect(h.agent()?.state).toBe("waiting");
  });

  it("Claude's listing is translated where it is read", () => {
    const rows = parseAgentsJson(
      JSON.stringify([
        { sessionId: "a", cwd: "/r", pid: 1, status: "waiting", waitingFor: "permission prompt" },
        { sessionId: "b", cwd: "/r", pid: 2, status: "waiting", waitingFor: "input needed" },
        { sessionId: "c", cwd: "/r", pid: 3, status: "waiting" },
        { sessionId: "d", cwd: "/r", pid: 4, status: "idle" },
        { sessionId: "e", cwd: "/r", pid: 5, status: "shell" },
        { sessionId: "f", cwd: "/r", pid: 6, status: "busy" },
        { sessionId: "g", cwd: "/r", pid: 7 },
        { sessionId: "h", cwd: "/r", pid: 8, status: "waiting", waitingFor: 7 },
      ]),
    );
    expect(rows?.map((r) => r.screen)).toEqual([
      "permission-dialog",
      "other-dialog",
      "other-dialog",
      "at-prompt",
      "at-prompt",
      "working",
      undefined,
      "other-dialog",
    ]);
  });
});

describe("a Notification that blocks nothing changes nothing about a block (#86 review)", () => {
  // Claude sends these into a session whatever is on screen: a mod's
  // `ui.notify` (plugin_notification), an MCP server's elicitation_complete,
  // PushNotification. They carry no agent_id, so they land on the main agent.
  for (const notificationType of [
    "plugin_notification",
    "elicitation_complete",
    "push_notification",
    "idle_prompt",
    "agent_completed",
  ]) {
    it(`${notificationType}: the reason, the date, the claim and the sighting stand, and Esc still ends it`, async () => {
      const h = harness();
      h.at(0);
      h.hook(pre.payload);
      h.hook(request.payload);
      h.at(1_300);
      h.seen(1_000);
      h.at(5_000);
      await h.loop.pulse();
      const before = { ...h.agent() };
      h.at(5_500);
      const r = h.hook({
        ...notification.payload,
        notification_type: notificationType,
        message: "<redacted>",
      });
      expect(r.becameBlocked).toBeUndefined();
      expect(h.agent()).toMatchObject({
        state: "blocked",
        blockedReason: "permission_prompt",
        stateSince: before.stateSince,
        announcedAt: before.announcedAt,
        dialogSince: before.dialogSince,
        dialogSeenAt: before.dialogSeenAt,
      });
      await h.pollFor("idle", 6_000, 5 * 60_000);
      expect(h.kinds()).toEqual(["blocked", "resolved"]);
      expect(h.agent()?.state).toBe("waiting");
    });
  }

  it("and an approval the listing sees still ends it", () => {
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(1_300);
    h.seen(1_000);
    h.at(2_000);
    h.hook({ ...notification.payload, notification_type: "plugin_notification", message: "<redacted>" });
    h.at(6_300);
    h.poll("busy", 6_000);
    expect(h.agent()?.state).toBe("tool-running");
  });
});

describe("only the agent's own progress ends a Claude block (#86 review)", () => {
  it("a FileChanged while the dialog is open ends nothing: it keeps reminding, and is never resolved", async () => {
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(1_300);
    h.seen(1_000);
    h.at(5_000);
    await h.loop.pulse();
    h.at(6_400);
    h.hook(notification.payload);
    h.at(7_000);
    h.hook(fileChanged);
    expect(h.agent()).toMatchObject({ state: "blocked", blockedReason: "permission_prompt", stateSince: 0 });
    await h.pollFor("waiting", 11_000, 5 * 60_000, DIALOG);
    expect(h.agent()?.state).toBe("blocked");
    expect(h.kinds()).not.toContain("resolved");
    expect(h.alerts().length, "reminders, as for any open prompt").toBeGreaterThan(1);
  });

  it("a FileChanged between the claim and the sighting keeps the claim, and its date", async () => {
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    h.hook(request.payload);
    h.at(2_000);
    h.hook(fileChanged);
    expect(h.agent()).toMatchObject({ state: "tool-running", dialogSince: 0 });
    h.at(3_300);
    h.seen(3_000);
    expect(h.agent()).toMatchObject({ state: "blocked", stateSince: 0 });
    h.at(5_000);
    await h.loop.pulse();
    expect(h.alerts()).toHaveLength(1);
  });

  /**
   * Which event kinds end a block, and a claim. Exhaustive over `Kind`: a new
   * kind fails to compile here until someone decides.
   *
   * A Claude block ends on the blocked agent's OWN progress — it ran a tool,
   * finished one, ended its turn, its session or itself, or its session
   * (re)started, which no dialog survives — or when the listing says the
   * dialog is gone. `file_changed` names no agent and says only that a file
   * changed; `subagent_start` is a new agent's first breath; a notification
   * is the session telling you something. None of them is an answer.
   */
  type AgentStateAfter = string | null;
  const ENDS: Record<Kind, AgentStateAfter> = {
    session_start: "thinking",
    pre_tool: "tool-running",
    post_tool: "thinking",
    tool_failed: "thinking",
    stop: "waiting",
    session_end: "done",
    subagent_stop: "done",
    file_changed: null,
    subagent_start: null,
    notification: null,
  };

  let seq = 0;
  const ev = (kind: Kind, notificationKind: NotificationKind | null = null): AstirEvent => ({
    v: CONTRACT_VERSION,
    eventId: `pin${++seq}`,
    provider: "claude",
    sessionId: SESSION,
    ts: 1_793_000_100 + seq,
    kind,
    agentId: SESSION,
    agentType: null,
    parentAgentId: null,
    parentSource: null,
    tool: kind === "pre_tool" || kind === "post_tool" || kind === "tool_failed" ? "Bash" : null,
    description: null,
    paths: [],
    op: null,
    ok: kind === "tool_failed" ? false : kind === "post_tool" ? true : null,
    notificationKind,
  });

  for (const kind of Object.keys(ENDS) as Kind[]) {
    const after = ENDS[kind];
    it(`${kind} ${after === null ? "ends neither a block nor a claim" : `ends a block and a claim (→ ${after})`}`, () => {
      const blocked = harness();
      blocked.at(0);
      blocked.hook(pre.payload);
      blocked.hook(request.payload);
      blocked.at(1_300);
      blocked.seen(1_000);
      blocked.at(3_000);
      const r = blocked.registry.apply(ev(kind, kind === "notification" ? "other" : null), CWD);
      expect(r.applied).toBe(true);
      expect(blocked.agent()?.state).toBe(after ?? "blocked");
      if (after === null) {
        expect(blocked.agent()).toMatchObject({
          blockedReason: "permission_prompt",
          stateSince: 0,
          dialogSince: 0,
        });
      }

      const claimed = harness();
      claimed.at(0);
      claimed.hook(pre.payload);
      claimed.hook(request.payload);
      claimed.at(3_000);
      claimed.registry.apply(ev(kind, kind === "notification" ? "other" : null), CWD);
      expect(claimed.agent()?.dialogSince ?? null).toBe(after === null ? 0 : null);
    });
  }

  for (const notificationKind of [
    "permission_prompt",
    "agent_needs_input",
    "worker_permission_prompt",
    "idle_prompt",
    "agent_completed",
    "permission_request",
    "other",
  ] satisfies NotificationKind[]) {
    it(`a ${notificationKind} notification leaves a block blocked, dated where it was`, () => {
      const h = harness();
      h.at(0);
      h.hook(pre.payload);
      h.hook(request.payload);
      h.at(1_300);
      h.seen(1_000);
      h.at(3_000);
      const r = h.registry.apply(ev("notification", notificationKind), CWD);
      expect(r.becameBlocked).toBeUndefined();
      expect(h.agent()).toMatchObject({ state: "blocked", stateSince: 0 });
    });
  }
});

describe("discovery carries what a waiting session is waiting for", () => {
  it("says what is on screen when `claude agents --json` says enough, and adds nothing when it does not", () => {
    const rows = parseAgentsJson(
      JSON.stringify([
        { sessionId: "a", cwd: "/r", pid: 1, status: "waiting", waitingFor: "permission prompt" },
        { sessionId: "b", cwd: "/r", pid: 2 },
      ]),
    );
    expect(rows?.[0]?.screen).toBe("permission-dialog");
    expect(rows?.[1]).not.toHaveProperty("screen");
    // Claude's own words stay in discovery.
    expect(rows?.[0]).not.toHaveProperty("waitingFor");
  });

  it("dates a poll from when it was asked, not from when it answered", async () => {
    let t = 1_000;
    const got: Array<{ observedAt?: number; provider?: string; complete?: boolean }> = [];
    const lister = async () => {
      t += 1_500; // `claude agents --json` takes its time
      return { complete: true, sessions: [listed("idle")] };
    };
    const registry = {
      reconcile: (_found: DiscoveredSession[] | null, opts?: { observedAt?: number }) => {
        got.push(opts ?? {});
        return { enriched: 0, pruned: 0 };
      },
    };
    await pollInto(lister, registry, "claude", () => t);
    expect(got).toEqual([{ observedAt: 1_000, provider: "claude", complete: true }]);
  });

  it("an idle asked for before a block began does not end it, however late it lands", async () => {
    const h = harness();
    h.at(0);
    h.hook(pre.payload);
    let landed!: () => void;
    const lister = () =>
      new Promise<{ complete: boolean; sessions: DiscoveredSession[] }>((resolve) => {
        landed = () => resolve({ complete: true, sessions: [listed("idle")] });
      });
    let now = 500;
    const pending = pollInto(lister, h.registry, "claude", () => now);
    // The dialog is claimed and seen while the poll is still out.
    h.at(1_000);
    h.hook(request.payload);
    h.at(7_400);
    h.hook(notification.payload);
    now = 9_000;
    landed();
    await pending;
    expect(h.agent()?.state).toBe("blocked");
  });
});

describe("Codex is untouched — its listing is a pid check with nothing to say", () => {
  const codex = JSON.parse(readFileSync(join(root, "test", "fixtures", "codex", "capture.json"), "utf8")) as {
    escSequence: Step[];
  };

  /** A Codex agent blocked on its PermissionRequest, which is a block at once. */
  function codexBlocked() {
    let t = 0;
    let n = 0;
    const registry = new Registry({ nowMs: () => t });
    for (const step of codex.escSequence.slice(0, 2)) {
      const r = normalizeCodexHook(step.payload, { ...deps, newId: () => `c${++n}` });
      if (r.event === null) throw new Error("expected an event");
      registry.apply(r.event, r.cwd);
    }
    const session = String(codex.escSequence[1]?.payload.session_id);
    const state = () => registry.get(session)?.agents.get(session)?.state;
    expect(state()).toBe("blocked");
    return { registry, session, state, advance: (ms: number) => (t += ms), now: () => t };
  }

  it("declares it: Claude's listing settles blocks, Codex's does not", () => {
    expect(CAPABILITIES.claude.listingClearsBlocks).toBe(true);
    expect(CAPABILITIES.codex.listingClearsBlocks).toBe(false);
  });

  it("keeps a Codex block through any status a listing could report", () => {
    const c = codexBlocked();
    const row = (status: string): DiscoveredSession => ({
      ...listed(status, c.session, status === "waiting" ? DIALOG : undefined),
      cwd: "/home/user/repo",
    });
    for (const status of ["waiting", "busy", "idle"]) {
      c.advance(5_000);
      c.registry.reconcile([row(status)], { provider: "codex", observedAt: c.now() - 300 });
      expect(c.state(), status).toBe("blocked");
    }
    expect(c.registry.get(c.session)?.agents.get(c.session)?.dialogSeenAt).toBeNull();
  });

  it("a Codex PermissionRequest is the agent's it names, whoever else is blocked", () => {
    // Codex makes no claims, so there is nothing to attribute: a subagent's
    // block does not swallow the main agent's.
    let t = 0;
    let n = 0;
    const registry = new Registry({ nowMs: () => t });
    const apply = (payload: Payload) => {
      const r = normalizeCodexHook(payload, { ...deps, newId: () => `x${++n}` });
      if (r.event === null) throw new Error("expected an event");
      return registry.apply(r.event, r.cwd);
    };
    const [codexPre, codexAsk] = codex.escSequence;
    if (codexPre === undefined || codexAsk === undefined) throw new Error("capture changed");
    const session = String(codexAsk.payload.session_id);
    apply({ ...codexPre.payload, agent_id: SUB });
    apply({ ...codexAsk.payload, agent_id: SUB });
    expect(registry.get(session)?.agents.get(SUB)?.state).toBe("blocked");
    t = 1_000;
    apply(codexPre.payload);
    expect(apply(codexAsk.payload).becameBlocked?.agentId).toBe(session);
    expect(registry.blockedCount()).toBe(2);
  });

  it("a Claude listing that happens to carry a Codex session's id does not settle it", () => {
    // A capability is a property of the listing it came from, and only the
    // provider that owns a session can speak for it.
    const c = codexBlocked();
    c.advance(5_000);
    c.registry.reconcile([{ ...listed("idle", c.session), cwd: "/home/user/repo" }], {
      provider: "claude",
      complete: false,
      observedAt: c.now() - 300,
    });
    expect(c.state()).toBe("blocked");
  });
});

describe("the daemon's reply to a PermissionRequest decides nothing", () => {
  // Claude reads an http hook's JSON body as hook output. For
  // PermissionRequest, `hookSpecificOutput.decision` would allow or deny the
  // tool on the human's behalf — the one thing astir must never do.
  const TOKEN = "t".repeat(48);
  const open: Daemon[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((d) => d.close()));
  });

  it("answers with no hookSpecificOutput and no decision, and records the claim", async () => {
    const registry = new Registry({ nowMs: () => 1_000 });
    const d = new Daemon({ token: TOKEN, registry });
    open.push(d);
    const port = await d.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(request.payload),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("hookSpecificOutput");
    expect(body).not.toHaveProperty("decision");
    // Nor anything else Claude acts on: `continue: false` stops the session.
    expect(body).toEqual({ ok: true, applied: true });
    expect(registry.get(SESSION)?.agents.get(SESSION)?.dialogSince).toBe(1_000);
    expect(registry.blockedCount(), "a claim, not a block").toBe(0);
  });
});
