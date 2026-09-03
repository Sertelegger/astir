import { describe, expect, it } from "vitest";
import { type Cvd, contrast, css, deltaE, labelOn, luminance, ramp, simulate } from "../src/status/ramp.js";

/** Steps a person is actually asked to tell apart on a legend. */
const STEPS = 10;
const at = (i: number) => ramp(i / (STEPS - 1));

/**
 * Three times the ~2.3 ΔE just-noticeable difference.
 *
 * "Just noticeable" is the wrong bar for a glanceable monitoring surface: it
 * describes two swatches held side by side under good light by someone looking
 * for a difference, not two tiles across a map seen in peripheral vision.
 */
const MIN_SEPARATION = 7;

const VISION: Array<Cvd | "typical"> = ["typical", "protanopia", "deuteranopia", "tritanopia"];
const seen = (c: ReturnType<typeof ramp>, v: Cvd | "typical") => (v === "typical" ? c : simulate(c, v));

describe("VIEW-04 — the ramp is legible, and here is the arithmetic", () => {
  it.each(VISION)("has strictly monotonic lightness under %s", (vision) => {
    // The property that makes the ramp survive greyscale, a projector and every
    // CVD type at once. Lightness is the one channel none of them removes.
    const lums = Array.from({ length: STEPS }, (_, i) => luminance(seen(at(i), vision)));
    for (let i = 1; i < lums.length; i++) {
      expect(lums[i], `step ${i} must be lighter than ${i - 1}`).toBeGreaterThan(lums[i - 1] as number);
    }
  });

  it.each(VISION)("keeps adjacent steps apart under %s", (vision) => {
    for (let i = 1; i < STEPS; i++) {
      const gap = deltaE(seen(at(i - 1), vision), seen(at(i), vision));
      expect(gap, `steps ${i - 1}→${i}`).toBeGreaterThan(MIN_SEPARATION);
    }
  });

  it("separates the extremes far beyond any threshold argument", () => {
    for (const vision of VISION) {
      expect(deltaE(seen(at(0), vision), seen(at(STEPS - 1), vision))).toBeGreaterThan(60);
    }
  });

  it("keeps a label readable at every point, which one fixed colour cannot", () => {
    // The ramp spans nearly the whole lightness range on purpose, so white text
    // is unreadable at the top and black text at the bottom. The rule has to flip.
    for (let i = 0; i <= 100; i++) {
      const fill = ramp(i / 100);
      expect(contrast(fill, labelOn(fill)), `at t=${i / 100}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("actually flips, rather than passing by always choosing one colour", () => {
    expect(labelOn(ramp(0))).toEqual({ r: 255, g: 255, b: 255 });
    expect(labelOn(ramp(1))).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe("ramp boundaries", () => {
  it("clamps rather than extrapolating off the end of the anchors", () => {
    expect(ramp(-5)).toEqual(ramp(0));
    expect(ramp(5)).toEqual(ramp(1));
    expect(ramp(Number.NaN)).toEqual(ramp(0));
  });

  it("is continuous across an anchor boundary", () => {
    // A visible seam where two segments meet would read as a threshold in the
    // data that is not there.
    const before = ramp(0.25 - 1e-6);
    const after = ramp(0.25 + 1e-6);
    expect(deltaE(before, after)).toBeLessThan(1);
  });

  it("emits a CSS colour a browser will accept", () => {
    expect(css(ramp(0.5))).toMatch(/^rgb\(\d+ \d+ \d+\)$/);
  });
});

describe("the CVD simulation is real, not a pass-through", () => {
  it("actually changes colours that depend on the missing cone", () => {
    // If `simulate` were accidentally an identity function every check above
    // would pass while testing nothing.
    const red = { r: 220, g: 40, b: 40 };
    expect(deltaE(red, simulate(red, "protanopia"))).toBeGreaterThan(20);
    expect(deltaE(red, simulate(red, "deuteranopia"))).toBeGreaterThan(10);

    // Tritanopia needs its own swatch rather than a third line on `red`: it is
    // the blue-yellow axis, and red barely moves under it (ΔE 11.9), which is
    // presumably why this arm was missing. Blue moves by 77. Without this the
    // tritanopia column of every check above is satisfied by an identity
    // matrix, while the README and the roadmap both claim it is asserted here.
    const blue = { r: 40, g: 80, b: 220 };
    expect(deltaE(blue, simulate(blue, "tritanopia"))).toBeGreaterThan(20);
  });

  it("leaves greys almost untouched, as dichromacy does", () => {
    const grey = { r: 128, g: 128, b: 128 };
    for (const v of ["protanopia", "deuteranopia", "tritanopia"] as Cvd[]) {
      expect(deltaE(grey, simulate(grey, v)), v).toBeLessThan(3);
    }
  });
});
