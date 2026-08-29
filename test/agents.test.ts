import { describe, expect, it } from "vitest";
import { DONE_LINGER_MS, humanDuration, isVisibleAgent, visibleAgents } from "../src/status/agents.js";

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
