/**
 * #80 — `announcedAt`: the moment the notify loop decided a block was real
 * enough to interrupt someone about.
 *
 * Every in-terminal surface (`astir status --line`, the tmux segment, the
 * astir-tui footer) needs to show the blocks the user has been TOLD about, and
 * only those. Counting every `blocked` agent would flash a warning for the
 * permission Claude's classifier answers itself in a few hundred milliseconds —
 * PSH-16's false alarm, moved from the desktop into the terminal. Re-deriving
 * the dwell in each surface (CAP-02's per-provider numbers) would let them
 * disagree with the notifier. So the loop, which already makes that decision,
 * records it on the agent, and every surface reads the one answer.
 *
 * It marks the DECISION, not a successful delivery. Whether any path could
 * actually deliver is a separate question with its own answer
 * (`/healthz.delivery.live`, #78) — conflating them would hide real blocks from
 * the terminal on exactly the machine where the terminal is the only channel.
 */

import { afterEach, describe, expect, it } from "vitest";
import { type AstirEvent, CONTRACT_VERSION, type Kind } from "../src/contract/event.js";
import { Daemon } from "../src/daemon/server.js";
import type { DiscoveredSession } from "../src/discovery/sessions.js";
import { Registry } from "../src/model/registry.js";
import { parseSnapshot } from "../src/model/snapshot.js";
import { type DeliveryTarget, Dispatcher } from "../src/notify/dispatch.js";
import type { NotifyEnvelope } from "../src/notify/envelope.js";
import { NotifyLoop } from "../src/notify/loop.js";
import { NotifyPolicy } from "../src/notify/policy.js";

let seq = 0;
function ev(kind: Kind, over: Partial<AstirEvent> = {}): AstirEvent {
  seq++;
  return {
    v: CONTRACT_VERSION,
    eventId: `ann${seq}`,
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

const DWELL = 5_000;

function harness(start = 1_000_000) {
  let t = start;
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
    dwellMs: () => DWELL,
  });
  return {
    registry,
    loop,
    sent,
    now,
    advance: (ms: number) => {
      t += ms;
    },
    block: (agentId = "s1") =>
      registry.apply(ev("notification", { agentId, notificationKind: "permission_prompt" }), "/repo"),
    work: (agentId = "s1") => registry.apply(ev("pre_tool", { agentId }), "/repo"),
    announcedAt: (agentId = "s1") => registry.get("s1")?.agents.get(agentId)?.announcedAt,
  };
}

describe("the loop records when it announced a block", () => {
  it("starts null — a new agent has been announced to no one", () => {
    const h = harness();
    h.registry.apply(ev("session_start"), "/repo");
    expect(h.announcedAt()).toBeNull();
  });

  it("stays null while the block is still proving itself", async () => {
    // The point of the field: a surface reading it inherits PSH-16's dwell
    // without knowing what the dwell is.
    const h = harness();
    h.block();
    h.advance(DWELL - 1);
    await h.loop.pulse();
    expect(h.sent).toHaveLength(0);
    expect(h.announcedAt()).toBeNull();
  });

  it("is set to the moment the first doorbell went out", async () => {
    const h = harness();
    h.block();
    h.advance(DWELL);
    await h.loop.pulse();
    expect(h.sent.map((e) => e.kind)).toEqual(["blocked"]);
    expect(h.announcedAt()).toBe(h.now());
  });

  it("does not move on a reminder", async () => {
    // "Oldest 3m" means three minutes since the user was first told, not since
    // the last nag.
    const h = harness();
    h.block();
    h.advance(DWELL);
    await h.loop.pulse();
    const first = h.announcedAt();
    h.advance(61_000);
    await h.loop.pulse();
    expect(h.sent.filter((e) => e.kind === "blocked")).toHaveLength(2);
    expect(h.announcedAt()).toBe(first);
  });

  it("is set even when no path delivered — it is the decision, not the delivery", async () => {
    let t = 0;
    const registry = new Registry({ nowMs: () => t });
    const loop = new NotifyLoop({
      registry,
      policy: new NotifyPolicy(),
      dispatcher: new Dispatcher([
        { name: "local", live: () => false, deliver: async () => ({ ok: false, reason: "dead" }) },
      ]),
      now: () => t,
      dwellMs: () => 0,
    });
    registry.apply(ev("notification", { notificationKind: "permission_prompt" }), "/repo");
    t = 10;
    await loop.pulse();
    expect(registry.get("s1")?.agents.get("s1")?.announcedAt).toBe(10);
  });

  it("is per agent", async () => {
    const h = harness();
    h.block("s1");
    h.advance(DWELL);
    await h.loop.pulse();
    h.block("sub-1");
    h.advance(1_000);
    await h.loop.pulse();
    expect(h.announcedAt("s1")).not.toBeNull();
    expect(h.announcedAt("sub-1"), "still inside its own dwell").toBeNull();
  });
});

describe("it is cleared the moment the block it describes is over", () => {
  it("clears when the agent leaves blocked, before the loop has even looked", async () => {
    const h = harness();
    h.block();
    h.advance(DWELL);
    await h.loop.pulse();
    h.work();
    // No pulse: a surface polling between the event and the next tick must not
    // still see an announced block.
    expect(h.announcedAt()).toBeNull();
  });

  it("a new block must be announced afresh", async () => {
    const h = harness();
    h.block();
    h.advance(DWELL);
    await h.loop.pulse();
    h.work();
    h.advance(1_000);
    await h.loop.pulse();

    h.block();
    h.advance(1_000);
    await h.loop.pulse();
    expect(h.announcedAt(), "inside the new block's dwell").toBeNull();
    h.advance(DWELL);
    await h.loop.pulse();
    expect(h.announcedAt()).toBe(h.now());
  });

  it("a block answered and re-blocked between two pulses is announced afresh", async () => {
    // The loop never sees the agent leave `blocked`: it is blocked at both
    // pulses. Its own memory said "announced", the registry's said "not", and
    // the loop believed itself — so the new block skipped its dwell, then sat
    // behind the OLD block's reminder backoff with no doorbell and every
    // surface showing nothing. Reproduced: 50s blocked, announcedAt null.
    const h = harness();
    h.block();
    h.advance(DWELL);
    await h.loop.pulse();
    expect(h.announcedAt()).toBe(h.now());

    h.advance(200);
    h.work();
    h.advance(200);
    h.block();
    const reblockedAt = h.now();

    h.advance(1_000);
    await h.loop.pulse();
    // The block the user was told about is over, and they are told so; the
    // one in front of them has not proved itself yet.
    expect(h.sent.map((e) => e.kind)).toEqual(["blocked", "resolved"]);
    expect(h.announcedAt(), "inside the new block's own dwell").toBeNull();

    while (h.now() < reblockedAt + DWELL) {
      h.advance(1_000);
      await h.loop.pulse();
    }
    expect(h.sent.map((e) => e.kind)).toEqual(["blocked", "resolved", "blocked"]);
    expect(h.announcedAt()).toBe(h.now());
  });

  it("leaves nothing owed when that new block ends inside its dwell", async () => {
    // Dropping the key silently would strand the old block's `resolved`: the
    // new one never announces, so nothing is owed for it, and the receiver's
    // entry for the block that WAS announced could never clear.
    const h = harness();
    h.block();
    h.advance(DWELL);
    await h.loop.pulse();

    h.advance(200);
    h.work();
    h.advance(200);
    h.block();
    h.advance(1_000);
    await h.loop.pulse();
    // The classifier answers this one by itself.
    h.advance(300);
    h.work();
    h.advance(10_000);
    await h.loop.pulse();

    expect(h.sent.map((e) => e.kind)).toEqual(["blocked", "resolved"]);
    expect(h.announcedAt()).toBeNull();
  });

  it("clears when the loop forgets an acknowledged block", async () => {
    // PSH-10: acknowledged agents leave `blockedAgents()`, the loop resolves
    // the key, and the field follows the key.
    const h = harness();
    h.block();
    h.advance(DWELL);
    await h.loop.pulse();
    h.registry.acknowledge("s1");
    await h.loop.pulse();
    expect(h.sent.map((e) => e.kind)).toEqual(["blocked", "resolved"]);
    expect(h.announcedAt()).toBeNull();
  });
});

describe("markAnnounced is narrow", () => {
  it("ignores an agent that is not blocked", () => {
    const h = harness();
    h.registry.apply(ev("session_start"), "/repo");
    // A time after the state began, so only the state can be what refuses it.
    h.advance(1);
    h.registry.markAnnounced("s1", "s1", h.now());
    expect(h.announcedAt()).toBeNull();
  });

  it("ignores a session or agent it does not know", () => {
    const h = harness();
    h.registry.markAnnounced("nope", "nope", h.now());
    h.block();
    h.registry.markAnnounced("s1", "nope", h.now());
    expect(h.registry.list()).toHaveLength(1);
    expect(h.announcedAt()).toBeNull();
  });

  it("keeps the first time if called again", () => {
    const h = harness();
    h.block();
    const first = h.now() + 5;
    h.registry.markAnnounced("s1", "s1", first);
    h.registry.markAnnounced("s1", "s1", first + 4);
    expect(h.announcedAt()).toBe(first);
  });

  it("ignores a time from before the block it would mark began", () => {
    // A stale clock vouching for a block that did not yet exist.
    const h = harness();
    h.block();
    const before = h.now();
    h.advance(1_000);
    h.work();
    h.advance(1_000);
    h.block();
    h.registry.markAnnounced("s1", "s1", before);
    expect(h.announcedAt()).toBeNull();
    // The instant the block began is not before it: a zero dwell marks there.
    h.registry.markAnnounced("s1", "s1", h.now());
    expect(h.announcedAt()).toBe(h.now());
  });
});

describe("the mark and the doorbell agree", () => {
  it("is set before the doorbell goes out, so /state never lags it", async () => {
    // A surface polling while a slow path holds the delivery must already see
    // the block as announced — the user's desktop is about to say so.
    let t = 1_000_000;
    const registry = new Registry({ nowMs: () => t });
    const seen: Array<number | null | undefined> = [];
    const loop = new NotifyLoop({
      registry,
      policy: new NotifyPolicy(),
      dispatcher: new Dispatcher([
        {
          name: "test",
          live: () => true,
          deliver: async () => {
            seen.push(registry.get("s1")?.agents.get("s1")?.announcedAt);
            return { ok: true };
          },
        },
      ]),
      now: () => t,
      dwellMs: () => DWELL,
    });
    registry.apply(ev("notification", { notificationKind: "permission_prompt" }), "/repo");
    t += DWELL;
    await loop.pulse();
    expect(seen).toEqual([t]);
  });

  it("does not stamp a sibling's new block with a pulse that predates it", async () => {
    // Every blocked agent is read once, at the start of the pulse, and each
    // doorbell is awaited in turn. While a slow path holds a1's, a2 is
    // answered and blocks again. Reproduced: a2 marked 3.1s before its block
    // began, so a block of age zero read as announced.
    let t = 1_000_000;
    const registry = new Registry({ nowMs: () => t });
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const loop = new NotifyLoop({
      registry,
      policy: new NotifyPolicy(),
      dispatcher: new Dispatcher([
        {
          name: "slow",
          live: () => true,
          deliver: async (e) => {
            if (e.kind === "blocked" && e.session.agentId === "a1") await held;
            return { ok: true };
          },
        },
      ]),
      now: () => t,
      dwellMs: () => DWELL,
    });
    const block = (agentId: string) =>
      registry.apply(ev("notification", { agentId, notificationKind: "permission_prompt" }), "/repo");
    const at = (agentId: string) => registry.get("s1")?.agents.get(agentId);
    block("a1");
    block("a2");
    t += DWELL;
    const pulseNow = t;

    const pulse = loop.pulse();
    // a1's doorbell is in flight. a2 is answered, works, and blocks again.
    t += 1_000;
    registry.apply(ev("pre_tool", { agentId: "a2" }), "/repo");
    t += 2_100;
    block("a2");
    const reblockedAt = t;
    release();
    await pulse;

    expect(at("a1")?.announcedAt).toBe(pulseNow);
    expect(at("a2")?.stateSince).toBe(reblockedAt);
    expect(at("a2")?.announcedAt, "a new block is not announced by an older pulse").toBeNull();

    // And it is announced once it has proved itself, like any other.
    t = reblockedAt + DWELL;
    await loop.pulse();
    expect(at("a2")?.announcedAt).toBe(t);
  });
});

describe("DMN-06 — a restored block must prove itself again", () => {
  const disc: DiscoveredSession = {
    sessionId: "s1",
    cwd: "/repo",
    pid: 4242,
    status: "busy",
    name: "repo-aa",
    startedAt: 1_000,
  };

  async function announcedThenRestarted() {
    const before = harness();
    before.block();
    before.registry.reconcile([disc], { provider: "claude" });
    before.advance(DWELL);
    await before.loop.pulse();
    expect(before.announcedAt()).not.toBeNull();
    return before.registry.snapshot();
  }

  it("is not written to the snapshot", async () => {
    const snap = await announcedThenRestarted();
    expect(JSON.stringify(snap)).not.toContain("announcedAt");
  });

  it("restores as null", async () => {
    const snap = await announcedThenRestarted();
    const after = new Registry({ nowMs: () => 2_000_000 });
    after.stageRestore(snap);
    after.reconcile([disc], { provider: "claude" });
    const agent = after.get("s1")?.agents.get("s1");
    expect(agent?.state).toBe("blocked");
    expect(agent?.announcedAt).toBeNull();
  });

  it("restores as null even from a snapshot that carries one", () => {
    // A future or hand-edited writer must not be able to vouch for a block the
    // running daemon has not decided about.
    const parsed = parseSnapshot({
      v: { major: 1, minor: 0 },
      writtenAt: 1,
      sessions: [
        {
          sessionId: "s1",
          provider: "claude",
          cwd: "/repo",
          name: null,
          pid: 4242,
          startedAt: 1_000,
          agents: [{ id: "s1", state: "blocked", stateSince: 1, announcedAt: 123 }],
        },
      ],
    });
    expect(parsed).not.toBeNull();
    const r = new Registry({ nowMs: () => 2_000_000 });
    if (parsed !== null) r.stageRestore(parsed);
    r.reconcile([disc], { provider: "claude" });
    expect(r.get("s1")?.agents.get("s1")?.announcedAt).toBeNull();
  });

  it("is announced again only once the restore has outlasted the dwell", async () => {
    const snap = await announcedThenRestarted();
    let t = 2_000_000;
    const registry = new Registry({ nowMs: () => t });
    registry.stageRestore(snap);
    registry.reconcile([disc], { provider: "claude" });
    const loop = new NotifyLoop({
      registry,
      policy: new NotifyPolicy(),
      dispatcher: new Dispatcher([{ name: "test", live: () => true, deliver: async () => ({ ok: true }) }]),
      now: () => t,
      dwellMs: () => DWELL,
    });
    await loop.pulse();
    expect(registry.get("s1")?.agents.get("s1")?.announcedAt).toBeNull();
    t += DWELL;
    await loop.pulse();
    expect(registry.get("s1")?.agents.get("s1")?.announcedAt).toBe(t);
  });
});

describe("/state carries it", () => {
  let daemon: Daemon | undefined;
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  it("on every agent, with a minor version bump (VER-01: additive)", async () => {
    const h = harness();
    h.block();
    h.registry.apply(ev("session_start", { agentId: "sub-1" }), "/repo");
    h.advance(DWELL);
    await h.loop.pulse();

    const token = "t".repeat(48);
    daemon = new Daemon({ token, registry: h.registry });
    const port = await daemon.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/state`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as {
      v: { major: number; minor: number };
      sessions: Array<{ agents: Array<{ id: string; announcedAt: unknown }> }>;
    };
    expect(body.v).toEqual({ major: 2, minor: 2 });
    const agents = body.sessions[0]?.agents ?? [];
    expect(agents.find((a) => a.id === "s1")?.announcedAt).toBe(h.now());
    // Present and null, not absent: "not announced" is an answer.
    const sub = agents.find((a) => a.id === "sub-1");
    expect(sub).toBeDefined();
    expect(sub?.announcedAt).toBeNull();
  });
});
