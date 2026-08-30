import { describe, expect, it } from "vitest";
import {
  agentDetail,
  DONE_LINGER_MS,
  describeAgent,
  ellipsise,
  humanDuration,
  isVisibleAgent,
  visibleAgents,
} from "../src/status/agents.js";

const agent = (state: string, inStateMs: number) => ({ state, inStateMs });

describe("which agents are worth a row", () => {
  it("keeps a finished agent briefly, so it is still there when you look back", () => {
    expect(isVisibleAgent(agent("done", 5_000))).toBe(true);
  });

  it("retires a finished agent once it is old news", () => {
    // The bug this exists to prevent: a daemon left running for days rendered
    // every subagent that had ever finished, burying the ones still working.
    expect(isVisibleAgent(agent("done", DONE_LINGER_MS + 1))).toBe(false);
  });

  it("NEVER retires an error, however old", () => {
    // A failure is the terminal state you may not have seen yet. Ageing it out
    // would make the surface hide the thing it exists to report.
    expect(isVisibleAgent(agent("error", 30 * 24 * 60 * 60_000))).toBe(true);
  });

  it("keeps everything still in flight regardless of how long it has been", () => {
    for (const state of ["thinking", "tool-running", "blocked", "waiting", "idle"]) {
      expect(isVisibleAgent(agent(state, 99 * 60 * 60_000)), state).toBe(true);
    }
  });

  it("filters a mixed list down to what is current", () => {
    const all = [
      agent("thinking", 1_000),
      agent("done", 10_000),
      agent("done", 10 * 60_000),
      agent("error", 10 * 60_000),
    ];
    expect(visibleAgents(all)).toHaveLength(3);
  });
});

describe("durations a person can read", () => {
  it.each([
    [0, "0s"],
    [4_400, "4s"],
    [59_000, "59s"],
    [61_000, "1m 1s"],
    [3_600_000, "1h 0m"],
    [3_660_000, "1h 1m"],
    [86_400_000, "1d 0h"],
    [232_129_000, "2d 16h"],
  ])("renders %ims as %s", (ms, expected) => {
    expect(humanDuration(ms)).toBe(expected);
  });

  it("does not print a raw second count for multi-day spans", () => {
    // What the view actually showed: `232129s`. Technically a duration, and a
    // number nobody converts in their head.
    expect(humanDuration(232_129_000)).not.toMatch(/^\d{5,}s$/);
  });

  it("says nothing rather than something wrong for a nonsense input", () => {
    expect(humanDuration(Number.NaN)).toBe("—");
    expect(humanDuration(-5)).toBe("—");
  });
});

/* ── what an agent is doing ──────────────────────────────────────────────── */

const labelled = (over: Record<string, unknown> = {}) =>
  ({
    agentType: null,
    description: null,
    tool: null,
    toolPath: null,
    ...over,
  }) as Parameters<typeof describeAgent>[0];

describe("saying what an agent is doing", () => {
  it("separates the standing brief from the current action", () => {
    // Two different questions. An agent three minutes into a task wants the
    // first; a burst of tool calls wants the second. Folding them into one
    // string forces every renderer to pick, and the pick is wrong half the time.
    const label = describeAgent(
      labelled({
        agentType: "Explore",
        description: "Find where heat is computed",
        tool: "Grep",
        toolPath: "src/model/map.ts",
      }),
    );
    expect(label).toEqual({
      who: "Explore",
      task: "Find where heat is computed",
      doing: "Grep src/model/map.ts",
    });
  });

  it("calls the main agent `main` and gives it no invented task", () => {
    // Sidecars are per subagent, so the main agent has no brief. That is a real
    // absence, and a surface must be able to render it as one.
    expect(describeAgent(labelled({ tool: "Edit", toolPath: "a.ts" }))).toEqual({
      who: "main",
      task: null,
      doing: "Edit a.ts",
    });
  });

  it("names a pathless tool without inventing a path", () => {
    expect(describeAgent(labelled({ tool: "Bash" })).doing).toBe("Bash");
  });

  it("says nothing at all between tools", () => {
    // Rather than showing the last tool, which beside a `thinking` chip would
    // read as a claim about the present.
    expect(describeAgent(labelled({ agentType: "Plan" })).doing).toBeNull();
  });

  it("prefers the present over the standing brief on a one-line surface", () => {
    const busy = labelled({ description: "Audit the CI", tool: "Read", toolPath: "ci.yml" });
    expect(agentDetail(busy)).toBe("Read ci.yml");
    expect(agentDetail(labelled({ description: "Audit the CI" }))).toBe("Audit the CI");
    expect(agentDetail(labelled())).toBeNull();
  });
});

describe("shortening for a fixed-width surface", () => {
  it("leaves a short string alone", () => {
    expect(ellipsise("Edit a.ts", 40)).toBe("Edit a.ts");
  });

  it("marks that it cut something", () => {
    const cut = ellipsise("x".repeat(80), 20);
    expect(cut).toHaveLength(20);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("does not produce something longer than asked for", () => {
    for (const n of [1, 2, 3, 10]) expect(ellipsise("abcdefghij", n).length).toBeLessThanOrEqual(10);
  });
});
