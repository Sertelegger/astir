// @vitest-environment happy-dom
/**
 * VIEW-11 — the replay, and the two decisions that are the whole design.
 *
 * Both are the same mistake in different clothes: letting something that should
 * be fixed vary with the step. Geometry that varies makes the map boil; a
 * denominator that varies makes a file appear to cool when totals only ever
 * increase. v1 shipped the second one at the heat layer and it is the reason
 * this project exists.
 */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Progression } from "../src/model/map.js";
import { TimelapsePanel } from "../view/src/TimelapsePanel.js";
import { cumulative } from "../view/src/useProgression.js";

afterEach(cleanup);

const prog = (steps: Array<Record<string, number>>, spanMs = 120_000): Progression => ({
  spanMs,
  samples: steps.length,
  steps: steps.map((delta, i) => ({ agoMs: spanMs - i * 30_000, delta })),
});

const show = (p: Progression) =>
  render(<TimelapsePanel state={{ status: "ready", progression: p }} onRefresh={vi.fn()} host={null} />);

/**
 * Move the slider, for real.
 *
 * `dispatchEvent(new Event("change"))` does NOT drive a controlled React input:
 * React listens through its own synthetic system and reads the value via a
 * native setter. Two tests here passed against mutations because of exactly
 * that — the slider never moved, so both ends of the comparison read the final
 * step and agreed for the wrong reason.
 */
function scrubTo(view: ReturnType<typeof render>, step: number): void {
  const slider = view.container.querySelector("input[type=range]") as HTMLInputElement;
  fireEvent.change(slider, { target: { value: String(step) } });
}

/** The fill of one file's tile at whatever step is showing. */
function fillOf(view: ReturnType<typeof render>, path: string): string | null {
  const rects = [...view.container.querySelectorAll("rect")];
  const titles = [...view.container.querySelectorAll("title")];
  const i = titles.findIndex((t) => (t.textContent ?? "").startsWith(`${path} `));
  return i === -1 ? null : (rects[i]?.getAttribute("fill") ?? null);
}

describe("the deltas are summed back into cumulative totals", () => {
  it("accumulates rather than replacing", () => {
    // The client half of the delta trade. If this were wrong the replay would
    // show each interval in isolation instead of the session building up.
    const p = prog([{ "a.ts": 2 }, { "b.ts": 1 }, { "a.ts": 3 }]);
    expect(cumulative(p)).toEqual([
      { "a.ts": 2 },
      { "a.ts": 2, "b.ts": 1 },
      { "a.ts": 5, "b.ts": 1 },
    ]);
  });

  it("never lets a total decrease", () => {
    // Totals are cumulative touches; a drop would mean work un-happened.
    const frames = cumulative(prog([{ "a.ts": 1 }, { "b.ts": 9 }, { "c.ts": 4 }]));
    for (let i = 1; i < frames.length; i++) {
      for (const [path, n] of Object.entries(frames[i - 1] ?? {})) {
        expect(frames[i]?.[path] ?? 0).toBeGreaterThanOrEqual(n);
      }
    }
  });
});

describe("the geometry is fixed for the whole replay", () => {
  it("draws every file from the first step, including ones not yet touched", () => {
    // Laying out each step from its own totals would make tiles appear and
    // resize as the slider moves — animating the container rather than the
    // data, against VIEW-10's whole doctrine.
    const view = show(prog([{ "early.ts": 5 }, { "late.ts": 5 }]));
    // Scrub to the FIRST step, where `late.ts` has not been touched yet. At the
    // last step everything is touched, so a panel that omitted untouched files
    // would look identical there — which is how the first version of this test
    // passed against a mutation that omitted them.
    scrubTo(view, 0);
    expect(view.container.querySelector(".timelapse-read")?.textContent).toContain("step 1 of 2");
    expect(view.container.querySelectorAll("rect").length).toBe(2);
    // And the untouched one is drawn as an empty frame, not filled.
    expect(fillOf(view, "late.ts")).toBe("transparent");
  });

  it("keeps identical tile geometry at every step", () => {
    // The assertion the design turns on: scrub, and nothing moves.
    const p = prog([{ "a.ts": 1 }, { "b.ts": 20 }, { "c.ts": 3 }]);
    const view = show(p);
    const geometryOf = () =>
      [...view.container.querySelectorAll("rect")].map((r) =>
        ["x", "y", "width", "height"].map((a) => r.getAttribute(a)).join(","),
      );

    const atEnd = geometryOf();
    scrubTo(view, 0);
    // Proof the scrub actually happened, or this compares a thing to itself.
    expect(view.container.querySelector(".timelapse-read")?.textContent).toContain("step 1 of 3");
    expect(geometryOf()).toEqual(atEnd);
  });
});

describe("a file that stopped being touched must not appear to cool", () => {
  it("keeps a tile's colour constant while others catch up", () => {
    // Normalising each step against its OWN max is v1's heat bug one layer up:
    // `a.ts` is untouched after step 1, so its colour must not change when
    // `b.ts` overtakes it. Totals only ever increase; nothing cooled.
    const view = show(prog([{ "a.ts": 10 }, { "b.ts": 40 }]));

    scrubTo(view, 0);
    expect(view.container.querySelector(".timelapse-read")?.textContent).toContain("step 1 of 2");
    const early = fillOf(view, "a.ts");
    expect(early).not.toBeNull();

    scrubTo(view, 1);
    expect(view.container.querySelector(".timelapse-read")?.textContent).toContain("step 2 of 2");
    // Against a per-step denominator `a.ts` would read 10/10 here and 10/40
    // there — bright, then dimmer, for work that never un-happened.
    expect(fillOf(view, "a.ts")).toBe(early);
  });
});

describe("it says what it cannot show", () => {
  it("names the machine rather than showing an empty replay", () => {
    // A remote session's progression lives with the daemon watching it. An
    // empty timelapse would say the session did nothing.
    const view = render(
      <TimelapsePanel state={{ status: "elsewhere" }} onRefresh={vi.fn()} host="megabrain-dev" />,
    );
    expect(view.container.textContent).toContain("megabrain-dev");
    expect(view.container.querySelector("input[type=range]")).toBeNull();
  });

  it("says a young session has nothing sampled yet, rather than looking broken", () => {
    const view = show(prog([]));
    expect(view.container.textContent).toContain("Nothing sampled yet");
  });

  it("carries the numbers a slider cannot convey (VIEW-07)", () => {
    // Position, elapsed and coverage in text, so the replay is readable without
    // interpreting colour or dragging anything.
    const view = show(prog([{ "a.ts": 1 }, { "b.ts": 1 }]));
    const read = view.container.querySelector(".timelapse-read")?.textContent ?? "";
    expect(read).toContain("step 2 of 2");
    expect(read).toContain("files touched");
  });
});
