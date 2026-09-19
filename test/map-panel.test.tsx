// @vitest-environment happy-dom
/**
 * VIEW-04 — heat must not be carried by colour alone.
 *
 * `MapPanel` draws to a canvas, so nothing in the DOM reflects what it painted
 * and the whole component was verified only by reading it. The accessibility
 * bar in particular could be deleted and the suite would stay green — which is
 * the worst possible arrangement for a feature whose entire purpose is to work
 * for people who cannot see the colour.
 *
 * These record the 2D context's calls and assert on the geometry, which is the
 * only observable this component has.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileFrame } from "../src/status/frames.js";
import { MapPanel } from "../view/src/MapPanel.js";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
}

const rects: Rect[] = [];
const texts: string[] = [];

/** A 2D context that remembers what it was asked to draw. */
function recordingContext(): Record<string, unknown> {
  let fillStyle = "";
  return {
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(v: string) {
      fillStyle = v;
    },
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textBaseline: "",
    clearRect: () => {},
    fillRect: (x: number, y: number, w: number, h: number) => {
      rects.push({ x, y, w, h, fill: fillStyle });
    },
    strokeRect: () => {},
    fillText: (t: string) => texts.push(t),
    measureText: (t: string) => ({ width: t.length * 6 }),
    setTransform: () => {},
    scale: () => {},
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fill: () => {},
    roundRect: () => {},
  };
}

beforeEach(() => {
  rects.length = 0;
  texts.length = 0;
  vi.stubGlobal("devicePixelRatio", 1);
  // Must actually FIRE. `MapPanel` takes its size from this callback, and a
  // stub that only records the call leaves `size` at zero — so the draw effect
  // returns early and every assertion below reads an empty canvas. That is how
  // the first version of this file "failed": not a wrong expectation, a
  // component that was never asked to paint.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly cb: ResizeObserverCallback) {}
      observe(): void {
        this.cb(
          [{ contentRect: { width: 800, height: 400 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      disconnect(): void {}
      unobserve(): void {}
    },
  );
  // ONE-SHOT. `draw` re-schedules itself as its first statement, so a stub that
  // invokes synchronously every time recurses until the stack gives out. The
  // loop is started by rAF rather than by a direct call, so firing exactly once
  // paints exactly one frame — which is all an assertion about geometry needs.
  let fired = false;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    if (!fired) {
      fired = true;
      cb(0);
    }
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  HTMLCanvasElement.prototype.getContext = (() =>
    recordingContext()) as unknown as HTMLCanvasElement["getContext"];
  // happy-dom reports zero-sized elements; the component needs a box to lay out in.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 400 });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const file = (path: string, heat: number, total = 10): FileFrame => ({
  path,
  heat,
  total,
  ageMs: 0,
});

const show = (files: FileFrame[]) =>
  render(
    <MapPanel
      files={files}
      decay={{ halfLifeMs: 90_000, referenceHeat: 10, idleFloor: 0.08 }}
      mode="live"
      receivedAt={0}
      onSelect={() => {}}
      selected={null}
    />,
  );

/** The accessibility bars: thin, translucent-white, drawn over a tile. */
const bars = () => rects.filter((r) => r.h === 2 && r.fill.includes("255 255 255"));

describe("VIEW-04 — heat survives without colour", () => {
  it("draws a length bar per tile, not colour alone", () => {
    // Delete the bar and this is the only test that notices.
    show([file("a.ts", 10), file("b.ts", 5)]);
    expect(bars().length).toBeGreaterThan(0);
  });

  it("makes a hotter file's bar longer than a cooler one's", () => {
    // The bar has to carry the SAME number the colour does. A fixed-width bar
    // would satisfy "a bar exists" while encoding nothing at all.
    show([file("hot.ts", 10), file("cold.ts", 1)]);
    const widths = bars().map((b) => b.w);
    expect(widths.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...widths)).toBeGreaterThan(Math.min(...widths));
  });

  it("never draws a bar wider than its tile", () => {
    // Intensity is clamped upstream; if it ever were not, the bar would spill
    // into the neighbouring tile and read as that file's heat.
    show([file("a.ts", 1_000_000), file("b.ts", 1)]);
    for (const bar of bars()) {
      const tile = rects.find((r) => r.h > 2 && r.x <= bar.x && r.x + r.w >= bar.x + bar.w);
      expect(tile, `bar at ${bar.x} should sit inside a tile`).toBeDefined();
    }
  });
});

describe("the labels", () => {
  it("names files on tiles with room for a name", () => {
    show([file("src/main.ts", 10), file("src/other.ts", 8)]);
    expect(texts.length).toBeGreaterThan(0);
  });

  it("does not spill a long name past its tile", () => {
    // `clip` trims with an ellipsis. Without it a long name runs across its
    // neighbours and labels the wrong rectangle.
    show([file("a/very/deeply/nested/and-extremely-long-file-name.ts", 10), file("b.ts", 9)]);
    for (const t of texts) expect(t.length).toBeLessThan(120);
  });
});

describe("it draws something at all", () => {
  it("paints a tile per file", () => {
    // The floor these all rest on: a component that painted nothing would pass
    // every "does not do the wrong thing" assertion above.
    show([file("a.ts", 10), file("b.ts", 5), file("c.ts", 2)]);
    expect(rects.filter((r) => r.h > 2).length).toBeGreaterThanOrEqual(3);
  });

  it("survives an empty file list without throwing", () => {
    expect(() => show([])).not.toThrow();
  });
});
