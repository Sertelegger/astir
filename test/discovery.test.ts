import { describe, expect, it } from "vitest";
import { type AstirEvent, CONTRACT_VERSION } from "../src/contract/event.js";
import { type DiscoveredSession, parseAgentsJson } from "../src/discovery/sessions.js";
import { Registry } from "../src/model/registry.js";

/** Shape recorded from a real `claude agents --json` invocation. */
const REAL_OUTPUT = JSON.stringify([
  {
    pid: 14609,
    cwd: "/Users/sascha/Projects/astir",
    kind: "interactive",
    startedAt: 1786757507222,
    sessionId: "11e4b108-e67d-48e8-bc1a-e1342255a7d2",
    name: "astir-ac",
    status: "busy",
  },
  {
    cwd: "/Users/sascha/other",
    kind: "interactive",
    startedAt: 1786822952403,
    sessionId: "75f03a25-a79b-415c-804f-bec21947dd76",
    name: "other-c2",
    state: "working",
  },
]);

function ev(over: Partial<AstirEvent> = {}): AstirEvent {
  return {
    v: CONTRACT_VERSION,
    eventId: `e${Math.random()}`,
    provider: "claude",
    sessionId: "s1",
    ts: 1_786_900_000,
    kind: "session_start",
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

describe("parseAgentsJson", () => {
  it("parses real output, taking `status` or `state` whichever is present", () => {
    const out = parseAgentsJson(REAL_OUTPUT);
    expect(out).toHaveLength(2);
    expect(out?.[0]).toMatchObject({ sessionId: "11e4b108-e67d-48e8-bc1a-e1342255a7d2", status: "busy" });
    expect(out?.[1]).toMatchObject({ status: "working", pid: null });
  });

  it("returns null — not [] — when output is unusable", () => {
    // The distinction matters: [] means "no sessions" and triggers pruning,
    // null means "could not tell" and must not.
    expect(parseAgentsJson("not json")).toBeNull();
    expect(parseAgentsJson('{"not":"an array"}')).toBeNull();
  });

  it("skips entries with no session id rather than failing the batch", () => {
    expect(parseAgentsJson('[{"cwd":"/x"},{"sessionId":"ok","cwd":"/y"}]')).toHaveLength(1);
  });
});

describe("Registry.reconcile", () => {
  const disc = (id: string, over: Partial<DiscoveredSession> = {}): DiscoveredSession => ({
    sessionId: id,
    cwd: `/repo/${id}`,
    pid: 1,
    startedAt: null,
    status: "busy",
    name: id,
    ...over,
  });

  it("enriches a known session with discovery metadata", () => {
    const r = new Registry({ nowMs: () => 0 });
    r.apply(ev({ sessionId: "s1", agentId: "s1" }), "/orig");
    r.reconcile([disc("s1", { cwd: "/repo/real", name: "my-session", status: "busy" })]);

    const s = r.get("s1");
    expect(s?.name).toBe("my-session");
    expect(s?.status).toBe("busy");
    expect(s?.cwd).toBe("/repo/real");
  });

  it("does NOT prune a session discovery has never seen — that is the bootstrap race", () => {
    // A session fires its opening events before it appears in `claude agents`.
    // Pruning on absence alone would drop exactly those, which is how v1 lost
    // every session_start.
    const r = new Registry({ nowMs: () => 0 });
    r.apply(ev({ sessionId: "brand-new", agentId: "brand-new" }), "/repo");
    const res = r.reconcile([]);
    expect(res.pruned).toBe(0);
    expect(r.get("brand-new")).toBeDefined();
  });

  it("prunes only once discovery has vouched for a session and then dropped it", () => {
    const r = new Registry({ nowMs: () => 0 });
    r.apply(ev({ sessionId: "s1", agentId: "s1" }), "/repo");

    r.reconcile([disc("s1")]); // discovery confirms it exists
    expect(r.get("s1")).toBeDefined();

    const res = r.reconcile([]); // now it's gone
    expect(res.pruned).toBe(1);
    expect(r.get("s1")).toBeUndefined();
  });

  it("prunes nothing when discovery could not run", () => {
    const r = new Registry({ nowMs: () => 0 });
    r.apply(ev({ sessionId: "s1", agentId: "s1" }), "/repo");
    r.reconcile([disc("s1")]);

    // A missing `claude` binary must not read as "every session ended".
    const res = r.reconcile(null);
    expect(res.pruned).toBe(0);
    expect(r.get("s1")).toBeDefined();
  });

  it("ignores sessions the provider knows about but that have sent us nothing", () => {
    const r = new Registry({ nowMs: () => 0 });
    const res = r.reconcile([disc("never-seen")]);
    expect(res.enriched).toBe(0);
    expect(r.list()).toHaveLength(0);
  });
});
