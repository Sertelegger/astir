import { describe, expect, it } from "vitest";
import { type ClideEvent, CONTRACT_VERSION, type Kind } from "../src/contract/event.js";
import { Registry } from "../src/model/registry.js";

let seq = 0;
function ev(kind: Kind, over: Partial<ClideEvent> = {}): ClideEvent {
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
    paths: [],
    op: null,
    ok: null,
    notificationKind: null,
    ...over,
  };
}

/** A clock the test drives, so nothing here depends on wall time. */
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("session lifecycle", () => {
  it("keeps an ended session visible during the grace window, then drops it", () => {
    const c = clock();
    const r = new Registry({ nowMs: c.now, endedGraceMs: 60_000 });

    r.apply(ev("session_start"), "/repo");
    expect(r.list()).toHaveLength(1);

    r.apply(ev("session_end"), "/repo");
    c.advance(30_000);
    r.tick();
    expect(r.list(), "still answerable right after finishing").toHaveLength(1);

    c.advance(31_000);
    r.tick();
    expect(r.list(), "dropped once the grace window elapses").toHaveLength(0);
  });

  it("does not depend on discovery timing to end a session", () => {
    // The bug this replaces: whether a session was ever pruned depended on
    // whether a discovery poll happened to land during its lifetime. A short
    // session could slip between polls and linger forever, or be caught and
    // vanish — same input, different outcome.
    const c = clock();
    const r = new Registry({ nowMs: c.now, endedGraceMs: 1_000 });
    r.apply(ev("session_start"), "/repo");
    r.apply(ev("session_end"), "/repo");

    // Discovery never runs at all.
    c.advance(2_000);
    r.tick();
    expect(r.list()).toHaveLength(0);
  });

  it("a session_start during grace revives rather than resurrecting a corpse", () => {
    const c = clock();
    const r = new Registry({ nowMs: c.now, endedGraceMs: 60_000 });
    r.apply(ev("session_start"), "/repo");
    r.apply(ev("session_end"), "/repo");
    c.advance(10_000);

    r.apply(ev("session_start"), "/repo");
    c.advance(120_000);
    r.tick();
    expect(r.list(), "revived session must not be swept by the old end time").toHaveLength(1);
  });
});

describe("blocked accounting", () => {
  it("counts an agent as blocked and banks the time separately from active", () => {
    const c = clock();
    const r = new Registry({ nowMs: c.now });

    r.apply(ev("session_start"), "/repo");
    c.advance(5_000); // 5s working

    const res = r.apply(ev("notification", { notificationKind: "permission_prompt" }), "/repo");
    expect(res.becameBlocked?.kind).toBe("permission_prompt");
    expect(r.blockedCount()).toBe(1);

    c.advance(30_000); // 30s waiting on a human
    r.apply(ev("post_tool", { tool: "Bash", op: "other" }), "/repo");

    const agent = r.get("s1")?.agents.get("s1");
    expect(agent?.activeMs).toBe(5_000);
    expect(agent?.blockedMs).toBe(30_000);
    expect(r.blockedCount()).toBe(0);
  });

  it("does not re-fire becameBlocked while already blocked", () => {
    const c = clock();
    const r = new Registry({ nowMs: c.now });
    r.apply(ev("session_start"), "/repo");
    expect(
      r.apply(ev("notification", { notificationKind: "permission_prompt" }), "/r").becameBlocked,
    ).toBeTruthy();
    expect(
      r.apply(ev("notification", { notificationKind: "permission_prompt" }), "/r").becameBlocked,
    ).toBeUndefined();
  });

  it("MOD-04 — a blocked agent never decays to idle", () => {
    const c = clock();
    const r = new Registry({ nowMs: c.now, idleAfterMs: 1_000 });
    r.apply(ev("session_start"), "/repo");
    r.apply(ev("notification", { notificationKind: "agent_needs_input" }), "/repo");

    c.advance(600_000);
    r.tick();

    // "waiting on you" is the most informative state there is; letting it decay
    // to "idle" would replace it with the least informative one.
    expect(r.get("s1")?.agents.get("s1")?.state).toBe("blocked");
    expect(r.blockedCount()).toBe(1);
  });
});
