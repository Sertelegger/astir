import { describe, it, expect } from "vitest";
import { FileHeat, HEAT_WEIGHTS } from "../src/model/heat.js";

// Fake monotonic clock: seconds we control.
function fakeClock(start = 0) {
  let t = start;
  return { monoNow: () => t, advance: (dt: number) => { t += dt; } };
}

describe("FileHeat", () => {
  it("adds weighted heat per op and counts reads/edits", () => {
    const c = fakeClock();
    const fh = new FileHeat(c);
    fh.touch("edit", 100, 5);        // wallTs, linesChanged
    fh.touch("read", 101);
    expect(fh.value()).toBeCloseTo(HEAT_WEIGHTS.edit + HEAT_WEIGHTS.read, 6);
    expect(fh.edits).toBe(1);
    expect(fh.reads).toBe(1);
    expect(fh.lastTouch).toBe(101);
  });
  it("decays by half over one half-life", () => {
    const c = fakeClock();
    const fh = new FileHeat(c, 30);  // 30s half-life
    fh.touch("write", 0);            // heat = 3
    c.advance(30);
    expect(fh.value()).toBeCloseTo(1.5, 4);
    c.advance(30);
    expect(fh.value()).toBeCloseTo(0.75, 4);
  });
  it("clamps negative dt (clock went backwards) — no growth", () => {
    const c = fakeClock(100);
    const fh = new FileHeat(c, 30);
    fh.touch("write", 0);            // heat = 3 at mono=100
    (c as any).advance(-50);         // clock jumped backward
    expect(fh.value()).toBeLessThanOrEqual(3);
    expect(fh.value()).toBeGreaterThan(0);
  });
  it("does not over-decay after a backward clock jump (lastMono only advances forward)", () => {
    const c = fakeClock(100);
    const fh = new FileHeat(c, 30);
    fh.touch("write", 0);            // heat = 3 at mono=100
    (c as any).advance(-50);         // backward to mono=50
    fh.value();                      // observe during the backward window (no growth, no baseline regression)
    (c as any).advance(60);          // forward to mono=110 — real elapsed since touch is 10s
    // Correct: decay over dt=10 → 3 * 0.5^(10/30) ≈ 2.381. Buggy (baseline regressed to 50): dt=60 → ~0.75.
    expect(fh.value()).toBeCloseTo(3 * Math.pow(0.5, 10 / 30), 3);
  });
});
