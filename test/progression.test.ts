/**
 * VIEW-11's data, in the shape it crosses a wire.
 *
 * The ring has been written on a timer since MOD-08 shipped and read by
 * nothing — `frames()` had zero non-test callers, so it was memory cost with
 * no consumer. These tests pin the two decisions that make it sendable:
 * deltas rather than cumulative totals, and ages rather than a clock this
 * process alone can interpret.
 */

import { describe, expect, it } from "vitest";
import { RepoMap } from "../src/model/map.js";

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("the progression is sent as deltas", () => {
  it("carries what changed in each interval, not the running total", () => {
    // `frames()` prefix-sums every interval back into full cumulative totals,
    // so a 1000-file / 60-sample session re-inflates to ~60k entries — the
    // exact cost storing deltas exists to avoid, paid on the wire.
    const c = clock();
    const map = new RepoMap({ nowMs: c.now });

    map.touch(["a.ts"]);
    c.advance(30_000);
    map.sample();
    map.touch(["b.ts"]);
    c.advance(30_000);
    map.sample();

    const p = map.progression();
    expect(p.steps.map((s) => Object.keys(s.delta))).toEqual([["a.ts"], ["b.ts"]]);
    // The second step must NOT repeat a.ts — that is the whole difference.
    expect(p.steps[1]?.delta["a.ts"]).toBeUndefined();
  });

  it("sums back to the same totals frames() reports", () => {
    // Deltas are only cheaper if they are lossless. Prefix-summing the steps
    // must reproduce exactly what the cumulative view says.
    const c = clock();
    const map = new RepoMap({ nowMs: c.now });
    for (const batch of [["a.ts", "a.ts", "b.ts"], ["b.ts"], ["c.ts", "a.ts"]]) {
      map.touch(batch);
      c.advance(30_000);
      map.sample();
    }

    const summed: Record<string, number> = {};
    for (const step of map.progression().steps) {
      for (const [path, n] of Object.entries(step.delta)) summed[path] = (summed[path] ?? 0) + n;
    }
    const last = map.frames().at(-1);
    expect(summed).toEqual(last?.totals);
  });

  it("is ordered oldest first, so replaying it replays the session", () => {
    const c = clock();
    const map = new RepoMap({ nowMs: c.now });
    for (const p of ["first.ts", "second.ts", "third.ts"]) {
      map.touch([p]);
      c.advance(30_000);
      map.sample();
    }
    expect(map.progression().steps.flatMap((s) => Object.keys(s.delta))).toEqual([
      "first.ts",
      "second.ts",
      "third.ts",
    ]);
  });
});

describe("the progression is sent as ages", () => {
  it("reports how long ago each interval sealed, never when", () => {
    // `Sample.at` is `performance.now()`-relative: meaningful only inside this
    // process, and uninterpretable in a browser. An age is a duration, and both
    // ends agree how long a second is. Same doctrine as `FileFrame.ageMs`.
    const c = clock();
    const map = new RepoMap({ nowMs: c.now });
    map.touch(["a.ts"]);
    c.advance(30_000);
    map.sample();
    c.advance(60_000);

    const p = map.progression();
    expect(p.steps[0]?.agoMs).toBe(60_000);
    // And nothing process-relative leaked alongside it.
    expect(JSON.stringify(p)).not.toContain('"at"');
  });

  it("ages advance as time passes, without the ring changing", () => {
    const c = clock();
    const map = new RepoMap({ nowMs: c.now });
    map.touch(["a.ts"]);
    c.advance(30_000);
    map.sample();

    const first = map.progression().steps[0]?.agoMs ?? 0;
    c.advance(10_000);
    expect(map.progression().steps[0]?.agoMs).toBe(first + 10_000);
  });

  it("spans oldest sample to now, so a time axis needs no reconstruction", () => {
    const c = clock();
    const map = new RepoMap({ nowMs: c.now });
    map.touch(["a.ts"]);
    c.advance(30_000);
    map.sample();
    c.advance(30_000);
    map.sample();
    c.advance(15_000);

    // Oldest sealed at +30s, now is +75s.
    expect(map.progression().spanMs).toBe(45_000);
  });

  it("reports an empty progression rather than failing on a session that has done nothing", () => {
    const map = new RepoMap({ nowMs: clock().now });
    expect(map.progression()).toEqual({ spanMs: 0, samples: 0, steps: [] });
  });

  it("reports the same sample count /state already publishes", () => {
    // Two views of one number; if they disagree, one of the surfaces is lying
    // about whether the progression is advancing.
    const c = clock();
    const map = new RepoMap({ nowMs: c.now });
    for (let i = 0; i < 3; i++) {
      map.touch([`f${i}.ts`]);
      c.advance(30_000);
      map.sample();
    }
    expect(map.progression().samples).toBe(map.samples);
  });
});
