// web/test/color.test.ts
import { describe, it, expect } from "vitest";
import { normalizeHeat, heatColor, IDLE_COLOR } from "../src/color.js";

describe("heat color", () => {
  it("normalizeHeat divides by max, 0 when max is 0", () => {
    expect(normalizeHeat(3, 6)).toBeCloseTo(0.5, 6);
    expect(normalizeHeat(5, 0)).toBe(0);
    expect(normalizeHeat(0, 6)).toBe(0);
  });
  it("heatColor: idle at 0, interpolates warm→hot", () => {
    expect(heatColor(0)).toBe(IDLE_COLOR);
    expect(heatColor(1)).toBe("rgb(255, 90, 40)");
    expect(heatColor(0.5)).toBe("rgb(255, 135, 65)");
  });
  it("heatColor clamps out-of-range input", () => {
    expect(heatColor(-1)).toBe(IDLE_COLOR);
    expect(heatColor(2)).toBe("rgb(255, 90, 40)");
  });
});
