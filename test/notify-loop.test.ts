import { describe, expect, it } from "vitest";
import { type AstirEvent, CONTRACT_VERSION, type Kind } from "../src/contract/event.js";
import { Registry } from "../src/model/registry.js";
import { type DeliveryTarget, Dispatcher } from "../src/notify/dispatch.js";
import type { NotifyEnvelope } from "../src/notify/envelope.js";
import { NotifyLoop } from "../src/notify/loop.js";
import { NotifyPolicy } from "../src/notify/policy.js";

let seq = 0;
function ev(kind: Kind, over: Partial<AstirEvent> = {}): AstirEvent {
  seq++;
  return {
    v: CONTRACT_VERSION,
    eventId: `e${seq}`,
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

function harness(notifyAfterMs?: number) {
  let t = 0;
  const now = () => t;
  const sent: NotifyEnvelope[] = [];
  const target: DeliveryTarget = {
    name: "test",
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
    ...(notifyAfterMs === undefined ? {} : { notifyAfterMs }),
  });
  return {
    registry,
    loop,
    sent,
    advance: (ms: number) => {
      t += ms;
    },
    blocked: () => registry.apply(ev("notification", { notificationKind: "permission_prompt" }), "/repo"),
  };
}

describe("PSH-16 — a block must prove it is real before interrupting anyone", () => {
  it("does not alert about a permission the classifier resolved by itself", async () => {
    // The reported bug: under `defaultMode: auto` some permission events are
    // answered with nobody looking, so the agent is blocked for a few hundred
    // milliseconds and no prompt ever appears — but astir fired a notification
    // saying it needed permission.
    const h = harness(5_000);
    h.blocked();

    h.advance(300);
    await h.loop.pulse();
    // Resolved without a human: the agent goes straight back to work.
    h.registry.apply(ev("pre_tool"), "/repo");
    h.advance(10_000);
    await h.loop.pulse();

    expect(h.sent.filter((e) => e.kind === "blocked")).toHaveLength(0);
  });

  it("does alert once a block outlasts the grace period", async () => {
    // The case the whole project exists for must still fire, and promptly.
    const h = harness(5_000);
    h.blocked();

    h.advance(1_000);
    await h.loop.pulse();
    expect(h.sent).toHaveLength(0);

    h.advance(5_000);
    await h.loop.pulse();
    expect(h.sent.filter((e) => e.kind === "blocked")).toHaveLength(1);
  });

  it("delays only the first alert, never the reminders", async () => {
    // Once announced, insistence is the policy's business — a reminder must not
    // be re-gated, or the cadence PSH-02 defines would drift.
    const h = harness(5_000);
    h.blocked();
    h.advance(6_000);
    await h.loop.pulse();
    expect(h.sent).toHaveLength(1);

    h.advance(61_000);
    await h.loop.pulse();
    expect(h.sent.filter((e) => e.kind === "blocked")).toHaveLength(2);
  });

  it("still emits a resolved doorbell for a block it announced", async () => {
    // Without it a receiver only ever learns that an agent BECAME blocked, and
    // its list could never shrink.
    const h = harness(5_000);
    h.blocked();
    h.advance(6_000);
    await h.loop.pulse();

    h.registry.apply(ev("pre_tool"), "/repo");
    h.advance(1_000);
    await h.loop.pulse();

    expect(h.sent.map((e) => e.kind)).toEqual(["blocked", "resolved"]);
  });

  it("does not emit a resolved doorbell for a block it never announced", async () => {
    // Nothing was said, so there is nothing to take back — a bare `resolved`
    // would be a reply to a message the receiver never got.
    const h = harness(5_000);
    h.blocked();
    h.advance(500);
    await h.loop.pulse();

    h.registry.apply(ev("pre_tool"), "/repo");
    h.advance(10_000);
    await h.loop.pulse();

    expect(h.sent).toHaveLength(0);
  });

  it("is measured from when the block started, not from the pulse", async () => {
    // A daemon busy or asleep must not lose the elapsed time and restart the
    // clock — the user has already been waiting.
    const h = harness(5_000);
    h.blocked();
    h.advance(30_000); // no pulse ran at all during this
    await h.loop.pulse();

    expect(h.sent.filter((e) => e.kind === "blocked")).toHaveLength(1);
  });
});

describe("PSH-16 — the dwell belongs to the provider", () => {
  /**
   * "Long enough that an auto-resolved permission never reaches it" depends on
   * who auto-resolves. Claude's classifier answers in hundreds of milliseconds;
   * the one Codex request captured was answered by its reviewer after ~11.9s
   * (test/fixtures/codex/capture.json). One dwell cannot be right for both.
   */
  const codexBlocked = (h: ReturnType<typeof harness>) =>
    h.registry.apply(
      ev("notification", {
        provider: "codex",
        sessionId: "c1",
        agentId: "c1",
        notificationKind: "permission_prompt",
      }),
      "/repo",
    );

  it("never interrupts about a Codex permission its reviewer answered at ~12s", async () => {
    // The captured case, replayed: at 5s this was a false alarm.
    const h = harness(5_000);
    codexBlocked(h);
    h.advance(11_957);
    await h.loop.pulse();
    h.registry.apply(ev("pre_tool", { provider: "codex", sessionId: "c1", agentId: "c1" }), "/repo");
    h.advance(30_000);
    await h.loop.pulse();

    expect(h.sent).toEqual([]);
  });

  it("does interrupt once a Codex block outlasts 30s", async () => {
    const h = harness(5_000);
    codexBlocked(h);
    h.advance(29_999);
    await h.loop.pulse();
    expect(h.sent).toEqual([]);

    h.advance(1);
    await h.loop.pulse();
    expect(h.sent.filter((e) => e.kind === "blocked").map((e) => e.session.sessionId)).toEqual(["c1"]);
  });

  it("leaves Claude on its own dwell while a Codex block waits", async () => {
    const h = harness(5_000);
    h.blocked();
    codexBlocked(h);
    h.advance(6_000);
    await h.loop.pulse();

    expect(h.sent.filter((e) => e.kind === "blocked").map((e) => e.session.sessionId)).toEqual(["s1"]);
  });

  it("lets a caller override a provider's dwell", async () => {
    let t = 0;
    const sent: NotifyEnvelope[] = [];
    const registry = new Registry({ nowMs: () => t });
    const loop = new NotifyLoop({
      registry,
      policy: new NotifyPolicy(),
      dispatcher: new Dispatcher([
        {
          name: "test",
          deliver: async (e) => {
            sent.push(e);
            return { ok: true };
          },
        },
      ]),
      now: () => t,
      notifyAfterMsByProvider: { codex: 1_000 },
    });
    registry.apply(
      ev("notification", {
        provider: "codex",
        sessionId: "c1",
        agentId: "c1",
        notificationKind: "permission_prompt",
      }),
      "/repo",
    );
    t += 1_000;
    await loop.pulse();
    expect(sent).toHaveLength(1);
  });
});
