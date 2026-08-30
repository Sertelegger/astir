import { describe, expect, it } from "vitest";
import { blockedTotal, overview, rankAgents, sessionLabels } from "../src/status/overview.js";
import type { StatusAgent, StatusBody, StatusSession } from "../src/status/types.js";

const agent = (over: Partial<StatusAgent> = {}): StatusAgent => ({
  id: "a1",
  state: "thinking",
  agentType: null,
  activeMs: 0,
  blockedMs: 0,
  inStateMs: 1_000,
  acknowledged: false,
  ...over,
});

const session = (over: Partial<StatusSession> = {}): StatusSession => ({
  sessionId: "s1",
  cwd: "/Users/x/Projects/astir",
  name: "astir-aa",
  status: "busy",
  pid: 1,
  agents: [agent()],
  ...over,
});

const body = (over: Partial<StatusBody> = {}): StatusBody => ({
  blockedCount: 0,
  sessions: [],
  ...over,
});

describe("VIEW-09 — whatever needs a human comes first", () => {
  it("puts the blocked session first out of three", () => {
    // The spec's own test: three sessions, one blocked agent, and that agent
    // must be what you see first. Ordered LAST in the input on purpose.
    const rows = overview(
      body({
        sessions: [
          session({ sessionId: "quiet", cwd: "/p/alpha", agents: [agent({ state: "idle" })] }),
          session({ sessionId: "busy", cwd: "/p/beta", agents: [agent({ state: "tool-running" })] }),
          session({
            sessionId: "waiting",
            cwd: "/p/gamma",
            agents: [agent({ id: "m", state: "thinking" }), agent({ id: "b", state: "blocked" })],
          }),
        ],
      }),
    );

    expect(rows[0]?.sessionId).toBe("waiting");
    expect(rows[0]?.agents[0]?.state, "and the blocked agent leads its session").toBe("blocked");
    expect(rows[0]?.blocked).toBe(1);
  });

  it("ranks a busier session above an idle one when nothing is blocked", () => {
    const rows = overview(
      body({
        sessions: [
          session({ sessionId: "idle", cwd: "/p/a", agents: [agent({ state: "idle" })] }),
          session({ sessionId: "working", cwd: "/p/b", agents: [agent({ state: "tool-running" })] }),
        ],
      }),
    );
    expect(rows.map((r) => r.sessionId)).toEqual(["working", "idle"]);
  });

  it("counts blocked agents across everything", () => {
    const rows = overview(
      body({
        sessions: [
          session({ sessionId: "one", cwd: "/p/a", agents: [agent({ state: "blocked" })] }),
          session({
            sessionId: "two",
            cwd: "/p/b",
            agents: [agent({ id: "x", state: "blocked" }), agent({ id: "y", state: "blocked" })],
          }),
        ],
      }),
    );
    expect(blockedTotal(rows)).toBe(3);
  });

  it("does not re-float an agent the human already dismissed", () => {
    // Still blocked; the human said "later". Putting it back at the top every
    // few seconds is how a surface teaches people to stop reading it.
    const rows = overview(
      body({
        sessions: [
          session({
            sessionId: "seen",
            cwd: "/p/a",
            agents: [agent({ state: "blocked", acknowledged: true })],
          }),
          session({ sessionId: "working", cwd: "/p/b", agents: [agent({ state: "tool-running" })] }),
        ],
      }),
    );
    expect(rows[0]?.sessionId).toBe("working");
    expect(rows.find((r) => r.sessionId === "seen")?.blocked).toBe(0);
  });
});

describe("VIEW-09 — sessions astir cannot hear are still shown", () => {
  it("lists a silent session below the live ones rather than hiding it", () => {
    // DMN-07. A view that shows only what it can hear looks calm in exactly the
    // situation where it is least entitled to.
    const rows = overview(
      body({
        sessions: [session({ sessionId: "live", cwd: "/p/a" })],
        silent: [{ sessionId: "quiet", cwd: "/p/b", name: "beta-cc" }],
      }),
    );
    expect(rows.map((r) => r.sessionId)).toEqual(["live", "quiet"]);
    expect(rows[1]?.kind).toBe("silent");
  });

  it("says it does not know a silent session's state, rather than guessing calm", () => {
    const rows = overview(body({ silent: [{ sessionId: "q", cwd: "/p/b", name: null }] }));
    expect(rows[0]?.state).toBeNull();
    expect(rows[0]?.agents).toEqual([]);
  });

  it("keeps a remote session, and marks one we have lost contact with", () => {
    const rows = overview(
      body({
        remote: [
          {
            host: "builder",
            sessionId: "r1",
            cwd: "/srv/repo",
            name: null,
            status: "busy",
            source: "push",
            lastSeen: 1,
            stale: true,
          },
        ],
      }),
    );
    expect(rows[0]?.kind).toBe("remote");
    expect(rows[0]?.host).toBe("builder");
    expect(rows[0]?.stale).toBe(true);
  });

  it("sinks a background session below everything a person is in", () => {
    // DMN-11 — real work, but nothing here waits on you.
    const rows = overview(
      body({
        sessions: [
          session({ sessionId: "plugin", cwd: "/p/a", attended: false }),
          session({ sessionId: "mine", cwd: "/p/b", agents: [agent({ state: "idle" })] }),
        ],
      }),
    );
    expect(rows.map((r) => r.sessionId)).toEqual(["mine", "plugin"]);
    expect(rows[1]?.kind).toBe("background");
  });

  it("still floats a background session that is blocked", () => {
    // Attendedness decides where it sits when nothing needs you; it does not
    // outrank an agent that does.
    const rows = overview(
      body({
        sessions: [
          session({
            sessionId: "plugin",
            cwd: "/p/a",
            attended: false,
            agents: [agent({ state: "blocked" })],
          }),
          session({ sessionId: "mine", cwd: "/p/b", agents: [agent({ state: "tool-running" })] }),
        ],
      }),
    );
    expect(rows[0]?.sessionId).toBe("plugin");
  });
});

describe("labels stay unique across every kind of session", () => {
  it("disambiguates two sessions in the same repo", () => {
    const rows = overview(
      body({
        sessions: [
          session({ sessionId: "a", cwd: "/Users/x/Projects/astir" }),
          session({ sessionId: "b", cwd: "/Users/x/Projects/astir" }),
        ],
      }),
    );
    expect(new Set(rows.map((r) => r.project)).size).toBe(2);
  });

  it("disambiguates across live and silent, not just within one list", () => {
    // Two identical rows is worse than an ambiguous label, and the silent one
    // is exactly the row a person needs to tell apart.
    const rows = overview(
      body({
        sessions: [session({ sessionId: "a", cwd: "/p/astir" })],
        silent: [{ sessionId: "b", cwd: "/p/astir", name: null }],
      }),
    );
    expect(new Set(rows.map((r) => r.project)).size).toBe(2);
  });

  it("falls back to a session id when a cwd tells you nothing", () => {
    expect(sessionLabels([{ cwd: "", sessionId: "abcdef123456" }])).toEqual(["abcdef12"]);
  });
});

describe("agents within a session", () => {
  it("orders blocked, then working, then finished", () => {
    const ranked = rankAgents([
      agent({ id: "d", state: "done", inStateMs: 1_000 }),
      agent({ id: "t", state: "thinking" }),
      agent({ id: "b", state: "blocked" }),
      agent({ id: "r", state: "tool-running" }),
    ]);
    expect(ranked.map((a) => a.id)).toEqual(["b", "r", "t", "d"]);
  });

  it("drops agents that finished long ago, like every other surface", () => {
    const ranked = rankAgents([
      agent({ id: "old", state: "done", inStateMs: 10 * 60_000 }),
      agent({ id: "now", state: "thinking" }),
    ]);
    expect(ranked.map((a) => a.id)).toEqual(["now"]);
  });

  it("keeps an error however old, because it may not have been seen", () => {
    const ranked = rankAgents([agent({ id: "e", state: "error", inStateMs: 3 * 24 * 3_600_000 })]);
    expect(ranked.map((a) => a.id)).toEqual(["e"]);
  });
});

describe("an empty world", () => {
  it("returns nothing rather than throwing", () => {
    expect(overview(body())).toEqual([]);
    expect(blockedTotal([])).toBe(0);
  });
});
