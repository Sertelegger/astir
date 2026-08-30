import { describe, expect, it } from "vitest";
import { type AstirEvent, CONTRACT_VERSION, type Kind } from "../src/contract/event.js";
import { Registry } from "../src/model/registry.js";

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

  it("eventually drops a session that never ends and is never discovered", () => {
    // Regression: this session is unreachable by both other prune paths. It has
    // no `session_end`, so the grace sweep never fires, and discovery has never
    // listed it, so `reconcile` refuses to touch it. It used to live forever,
    // holding a permanent entry in the menu bar that nothing could clear.
    const c = clock();
    const r = new Registry({ nowMs: c.now, undiscoveredTtlMs: 10 * 60_000 });

    r.apply(ev("session_start", { sessionId: "ghost", agentId: "ghost" }), "/repo");
    r.reconcile([]); // discovery works, and does not know this session

    c.advance(5 * 60_000);
    r.tick();
    expect(r.list(), "not yet — a new session may precede its first discovery").toHaveLength(1);

    c.advance(6 * 60_000);
    r.tick();
    expect(r.list(), "gone once it has been silent past the TTL").toHaveLength(0);
  });

  it("never sweeps undiscovered sessions when discovery itself is broken", () => {
    // With no working discovery, "never discovered" says something about this
    // machine, not about the session. Sweeping on it would delete every live
    // session on any host without `claude` on PATH.
    const c = clock();
    const r = new Registry({ nowMs: c.now, undiscoveredTtlMs: 1_000 });

    r.apply(ev("session_start"), "/repo");
    r.reconcile(null); // discovery could not run

    c.advance(60 * 60_000);
    r.tick();
    expect(r.list()).toHaveLength(1);
  });

  it("keeps a discovered session alive however long it stays silent", () => {
    // A blocked agent emits nothing while it waits. If silence alone were enough
    // to sweep it, the tool would forget the exact thing it exists to report.
    const c = clock();
    const r = new Registry({ nowMs: c.now, undiscoveredTtlMs: 1_000 });

    r.apply(ev("notification", { notificationKind: "permission_prompt" }), "/repo");
    r.reconcile([{ sessionId: "s1", cwd: "/repo", pid: 42, status: "waiting", name: "x", startedAt: null }]);

    c.advance(6 * 60 * 60_000);
    r.tick();
    expect(r.list()).toHaveLength(1);
    expect(r.blockedCount(), "and it is still reported as waiting").toBe(1);
  });
});

describe("PSH-10 — dismissal", () => {
  it("clears the badge without pretending the agent is unblocked", () => {
    const c = clock();
    const r = new Registry({ nowMs: c.now });
    r.apply(ev("notification", { notificationKind: "permission_prompt" }), "/repo");
    expect(r.blockedCount()).toBe(1);

    expect(r.acknowledge()).toBe(1);
    expect(r.blockedCount(), "no longer demanding attention").toBe(0);
    expect(r.blockedAgents(), "and no longer re-notified").toHaveLength(0);

    const agent = r.get("s1")?.agents.get("s1");
    expect(agent?.state, "but the truth is unchanged").toBe("blocked");
  });

  it("a fresh block after a dismissal alerts again", () => {
    const c = clock();
    const r = new Registry({ nowMs: c.now });
    r.apply(ev("notification", { notificationKind: "permission_prompt" }), "/repo");
    r.acknowledge();

    // The human answered, work resumed, and it blocked on something new.
    c.advance(1_000);
    r.apply(ev("post_tool"), "/repo");
    c.advance(1_000);
    r.apply(ev("notification", { notificationKind: "permission_prompt" }), "/repo");

    expect(r.blockedCount(), "a new question is a new interruption").toBe(1);
  });

  it("dismisses one session without silencing the others", () => {
    const c = clock();
    const r = new Registry({ nowMs: c.now });
    r.apply(ev("notification", { notificationKind: "permission_prompt" }), "/a");
    r.apply(
      ev("notification", { sessionId: "s2", agentId: "s2", notificationKind: "agent_needs_input" }),
      "/b",
    );
    expect(r.blockedCount()).toBe(2);

    expect(r.acknowledge("s1")).toBe(1);
    expect(r.blockedCount()).toBe(1);
    expect(r.blockedAgents()[0]?.sessionId).toBe("s2");
  });

  it("forget removes the record outright", () => {
    const c = clock();
    const r = new Registry({ nowMs: c.now });
    r.apply(ev("session_start"), "/repo");
    expect(r.forget("s1")).toBe(true);
    expect(r.list()).toHaveLength(0);
    expect(r.forget("s1"), "and says so when there was nothing to remove").toBe(false);
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

describe("a session that starts speaking", () => {
  const discovered = (status: string | null = "idle") => [
    { sessionId: "s1", cwd: "/repo", pid: 1, status, name: "n", startedAt: null },
  ];

  it("leaves the silent list the moment an event arrives, not at the next poll", () => {
    // `silentSessions` is a snapshot taken at each discovery poll. Between polls
    // a session that had just started speaking sat in BOTH lists, so the menu
    // bar showed the same repo twice — once live, once "not connected".
    const r = new Registry({ nowMs: clock().now });
    r.reconcile(discovered());
    expect(r.silent().map((d) => d.sessionId)).toEqual(["s1"]);

    r.apply(ev("session_start"), "/repo");

    expect(r.silent()).toEqual([]);
    expect(r.list().map((x) => x.sessionId)).toEqual(["s1"]);
  });

  it("does not disturb the other silent sessions", () => {
    const r = new Registry({ nowMs: clock().now });
    r.reconcile([
      ...discovered(),
      { sessionId: "s2", cwd: "/other", pid: 2, status: "idle", name: "o", startedAt: null },
    ]);
    r.apply(ev("session_start"), "/repo");
    expect(r.silent().map((d) => d.sessionId)).toEqual(["s2"]);
  });
});

describe("idling an agent that is actually working", () => {
  const discovered = (status: string | null) => [
    { sessionId: "s1", cwd: "/repo", pid: 1, status, name: "n", startedAt: null },
  ];
  const stateOf = (r: Registry) => r.get("s1")?.agents.get("s1")?.state;

  it("does not call a long tool call idle while the provider says busy", () => {
    // THE regression. `lastActivityMs` only moves when an event arrives, and
    // between PreToolUse and PostToolUse there are none — so every build, test
    // run and subagent longer than the timeout was reported as idle, with a
    // default of ten seconds.
    const c = clock();
    const r = new Registry({ nowMs: c.now });
    r.apply(ev("pre_tool"), "/repo");
    r.reconcile(discovered("busy"));

    c.advance(10 * 60_000);
    r.tick();

    expect(stateOf(r)).toBe("tool-running");
  });

  it("treats `running` as busy too", () => {
    const c = clock();
    const r = new Registry({ nowMs: c.now });
    r.apply(ev("pre_tool"), "/repo");
    r.reconcile(discovered("running"));

    c.advance(10 * 60_000);
    r.tick();

    expect(stateOf(r)).toBe("tool-running");
  });

  it("converges to idle once the provider agrees it is not busy", () => {
    // Both sources agree: the hooks went quiet AND discovery reports idle, which
    // most likely means a PostToolUse was lost.
    const c = clock();
    const r = new Registry({ nowMs: c.now, idleAfterMs: 30_000 });
    r.apply(ev("pre_tool"), "/repo");
    r.reconcile(discovered("idle"));

    c.advance(31_000);
    r.tick();

    expect(stateOf(r)).toBe("idle");
  });

  it("waits far longer when the provider says nothing at all", () => {
    // No corroboration either way, so do not override what the hooks last said
    // quickly: a machine without `claude` on PATH must not have every build
    // declared idle.
    const c = clock();
    const r = new Registry({ nowMs: c.now, idleAfterMs: 30_000, stalledAfterMs: 15 * 60_000 });
    r.apply(ev("pre_tool"), "/repo");
    r.reconcile(discovered(null));

    c.advance(60_000);
    r.tick();
    expect(stateOf(r)).toBe("tool-running");

    c.advance(15 * 60_000);
    r.tick();
    expect(stateOf(r)).toBe("idle");
  });

  it("never lets a timer quietly clear a blocked agent", () => {
    // Blocked is exempt for a different reason: it is the one state the whole
    // project exists to surface.
    const c = clock();
    const r = new Registry({ nowMs: c.now });
    r.apply(ev("notification", { notificationKind: "permission_prompt" }), "/repo");
    r.reconcile(discovered("idle"));

    c.advance(60 * 60_000);
    r.tick();

    expect(r.blockedCount()).toBe(1);
  });
});

describe("time spent working this turn (G4)", () => {
  const turnOf = (r: Registry) => r.get("s1")?.agents.get("s1")?.turnMs ?? 0;

  it("does not count the human's thinking time as the agent's working time", () => {
    // Regression: time was banked as active for everything that was not terminal
    // or idle, which included `waiting` — the state an agent sits in after Stop
    // while the human decides what to type. Minutes of that were recorded as
    // agent working time, inflating the one number G4 exists to keep honest.
    const c = clock();
    const r = new Registry({ nowMs: c.now });
    r.apply(ev("session_start"), "/repo");
    c.advance(1_000);
    r.apply(ev("stop"), "/repo");
    c.advance(5 * 60_000); // the human is reading
    r.apply(ev("pre_tool"), "/repo");

    expect(r.get("s1")?.agents.get("s1")?.activeMs).toBe(1_000);
  });

  it("accumulates across a thinking/tool-use cycle", () => {
    // The number the user wants: how long since they handed over, not how much
    // work the session has done in total.
    const c = clock();
    const r = new Registry({ nowMs: c.now });
    r.apply(ev("session_start"), "/repo");
    c.advance(2_000);
    r.apply(ev("pre_tool"), "/repo");
    c.advance(5_000);
    r.apply(ev("post_tool"), "/repo");
    c.advance(3_000);
    r.apply(ev("pre_tool"), "/repo");

    expect(turnOf(r)).toBe(10_000);
  });

  it("EXCLUDES time the agent spent blocked on the human", () => {
    // This is the answer to "is it just wall clock?" — no. Wall clock here is
    // 65s; 60 of them were spent waiting on a person, and time waiting on you is
    // not time spent doing something.
    const c = clock();
    const r = new Registry({ nowMs: c.now });
    r.apply(ev("session_start"), "/repo");
    c.advance(3_000);
    r.apply(ev("notification", { notificationKind: "permission_prompt" }), "/repo");
    c.advance(60_000);
    r.apply(ev("pre_tool"), "/repo");
    c.advance(2_000);
    r.apply(ev("post_tool"), "/repo");

    expect(turnOf(r)).toBe(5_000);
  });

  it("does not end the turn just because the agent asked a question", () => {
    // A permission prompt is mid-turn: the turn resumes on approval, so the
    // total must carry across it rather than restarting.
    const c = clock();
    const r = new Registry({ nowMs: c.now });
    r.apply(ev("session_start"), "/repo");
    c.advance(4_000);
    r.apply(ev("notification", { notificationKind: "permission_prompt" }), "/repo");
    c.advance(1_000);
    r.apply(ev("pre_tool"), "/repo");
    c.advance(1_000);
    r.apply(ev("post_tool"), "/repo");

    expect(turnOf(r)).toBe(5_000);
  });

  it("resets when the agent hands the floor back", () => {
    const c = clock();
    const r = new Registry({ nowMs: c.now });
    r.apply(ev("session_start"), "/repo");
    c.advance(9_000);
    r.apply(ev("stop"), "/repo");

    expect(turnOf(r)).toBe(0);
  });

  it("starts from zero on the next turn, not from the last one", () => {
    const c = clock();
    const r = new Registry({ nowMs: c.now });
    r.apply(ev("session_start"), "/repo");
    c.advance(9_000);
    r.apply(ev("stop"), "/repo");
    c.advance(30_000); // the human is reading
    r.apply(ev("pre_tool"), "/repo");
    c.advance(2_000);
    r.apply(ev("post_tool"), "/repo");

    expect(turnOf(r)).toBe(2_000);
  });

  it("leaves the session total alone, which answers a different question", () => {
    const c = clock();
    const r = new Registry({ nowMs: c.now });
    r.apply(ev("session_start"), "/repo");
    c.advance(5_000);
    r.apply(ev("stop"), "/repo");
    c.advance(1_000);
    r.apply(ev("pre_tool"), "/repo");
    c.advance(4_000);
    r.apply(ev("post_tool"), "/repo");

    const a = r.get("s1")?.agents.get("s1");
    expect(a?.turnMs).toBe(4_000);
    expect(a?.activeMs).toBe(9_000);
  });
});

describe("the repo map grows from events (MOD-01/MOD-02)", () => {
  const withPaths = (paths: string[]) => ev("post_tool", { paths });

  it("records the paths an event carries", () => {
    // The adapter already normalises and repo-scopes these (CAP-04); the
    // registry was discarding them entirely.
    const r = new Registry({ nowMs: clock().now });
    r.apply(withPaths(["src/a.ts", "src/b.ts"]), "/repo");

    const map = r.get("s1")?.map;
    expect(map?.size).toBe(2);
    expect(
      map
        ?.list()
        .map((l) => l.path)
        .sort(),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("does not double-count heat when an event is redelivered", () => {
    // MOD-06. A tunnel retry or a sender with two transports must not make a
    // file look twice as hot as it is.
    const r = new Registry({ nowMs: clock().now });
    const once = withPaths(["src/a.ts"]);
    r.apply(once, "/repo");
    r.apply(once, "/repo");

    expect(r.get("s1")?.map.totals()[0]).toEqual({ path: "src/a.ts", total: 1 });
  });

  it("ignores paths on a stale event", () => {
    // MOD-06: a stale event must not rewrite state, and heat is state.
    const r = new Registry({ nowMs: clock().now });
    r.apply(ev("post_tool", { ts: 5_000, paths: ["fresh.ts"] }), "/repo");
    r.apply(ev("post_tool", { ts: 1_000, paths: ["stale.ts"] }), "/repo");

    expect(
      r
        .get("s1")
        ?.map.list()
        .map((l) => l.path),
    ).toEqual(["fresh.ts"]);
  });

  it("keeps each session's map to itself", () => {
    const r = new Registry({ nowMs: clock().now });
    r.apply(withPaths(["a.ts"]), "/repo-one");
    r.apply(ev("post_tool", { sessionId: "s2", agentId: "s2", paths: ["b.ts"] }), "/repo-two");

    expect(
      r
        .get("s1")
        ?.map.list()
        .map((l) => l.path),
    ).toEqual(["a.ts"]);
    expect(
      r
        .get("s2")
        ?.map.list()
        .map((l) => l.path),
    ).toEqual(["b.ts"]);
  });

  it("leaves the map empty for events that carry no paths", () => {
    const r = new Registry({ nowMs: clock().now });
    r.apply(ev("notification", { notificationKind: "permission_prompt" }), "/repo");
    expect(r.get("s1")?.map.size).toBe(0);
  });
});

describe("what an agent is doing", () => {
  it("keeps the tool and path only while the tool is running", () => {
    const r = new Registry({ nowMs: clock().now });
    r.apply(ev("session_start"), "/repo");
    r.apply(ev("pre_tool", { tool: "Edit", paths: ["src/a.ts"] }), "/repo");

    const agent = () => r.get("s1")?.agents.get("s1");
    expect(agent()?.tool).toBe("Edit");
    expect(agent()?.toolPath).toBe("src/a.ts");

    r.apply(ev("post_tool", { tool: "Edit", paths: ["src/a.ts"] }), "/repo");
    expect(agent()?.tool, "a finished tool is not what it is doing now").toBeNull();
    expect(agent()?.toolPath).toBeNull();
  });

  it("stops claiming to edit while blocked on a permission prompt", () => {
    // Mid-Edit, the human is asked to approve. The agent is waiting on a
    // person, not editing, and the rail must not say otherwise.
    const r = new Registry({ nowMs: clock().now });
    r.apply(ev("session_start"), "/repo");
    r.apply(ev("pre_tool", { tool: "Edit", paths: ["src/a.ts"] }), "/repo");
    r.apply(ev("notification", { notificationKind: "permission_prompt" }), "/repo");

    const agent = r.get("s1")?.agents.get("s1");
    expect(agent?.state).toBe("blocked");
    expect(agent?.tool).toBeNull();
  });

  it("NEVER retains a tool argument, only the name and a path", () => {
    // NG1. Paths are carved out because the map is grown from them; a Bash
    // command line is not a path and must not reach memory or the screen.
    const r = new Registry({ nowMs: clock().now });
    r.apply(ev("session_start"), "/repo");
    r.apply(ev("pre_tool", { tool: "Bash", paths: [] }), "/repo");

    const agent = r.get("s1")?.agents.get("s1");
    expect(agent?.tool).toBe("Bash");
    expect(agent?.toolPath).toBeNull();
    expect(JSON.stringify(agent)).not.toMatch(/rm -rf|command/i);
  });

  it("remembers a subagent's brief for as long as it lives", () => {
    // Standing, not transient: it is what the agent was SENT to do, so a tool
    // finishing must not erase it.
    const r = new Registry({ nowMs: clock().now });
    r.apply(ev("session_start"), "/repo");
    r.apply(
      ev("subagent_start", { agentId: "sub", agentType: "Explore", description: "Find the leak" }),
      "/repo",
    );
    r.apply(ev("pre_tool", { agentId: "sub", tool: "Grep", paths: ["src/a.ts"] }), "/repo");
    r.apply(ev("post_tool", { agentId: "sub", tool: "Grep", paths: ["src/a.ts"] }), "/repo");

    const sub = r.get("s1")?.agents.get("sub");
    expect(sub?.description).toBe("Find the leak");
    expect(sub?.tool).toBeNull();
  });

  it("accepts a brief that arrives after the agent already exists", () => {
    // Out-of-order delivery: the same reason `agentType` is upserted.
    const r = new Registry({ nowMs: clock().now });
    r.apply(ev("session_start"), "/repo");
    r.apply(ev("pre_tool", { agentId: "sub", tool: "Read", paths: ["a.ts"] }), "/repo");
    r.apply(ev("subagent_start", { agentId: "sub", description: "Late brief" }), "/repo");

    expect(r.get("s1")?.agents.get("sub")?.description).toBe("Late brief");
  });

  it("leaves the main agent without a brief rather than inventing one", () => {
    const r = new Registry({ nowMs: clock().now });
    r.apply(ev("session_start"), "/repo");
    expect(r.get("s1")?.agents.get("s1")?.description).toBeNull();
  });
});
