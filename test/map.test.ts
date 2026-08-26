import { describe, expect, it } from "vitest";
import { RepoMap } from "../src/model/map.js";

/** A clock the test drives, so nothing here depends on wall time. */
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const MIN = 60_000;

describe("MOD-01 — heat decays against an ABSOLUTE floor", () => {
  it("cools to idle after a few half-lives of inactivity", () => {
    // THE defect this model exists to prevent. The previous version normalised
    // against the current maximum, which is invariant under uniform decay — so
    // the hottest file stayed exactly as hot forever and the map never cooled.
    const c = clock();
    const map = new RepoMap({ nowMs: c.now, halfLifeMs: 5 * MIN });
    map.touch(["src/a.ts"]);

    expect(map.list()[0]?.idle).toBe(false);

    c.advance(60 * MIN);
    const leaf = map.list()[0];
    expect(leaf?.idle).toBe(true);
    expect(leaf?.intensity).toBeLessThan(0.01);
  });

  it("cools even when it is the ONLY file, which is the invariance case", () => {
    // With one leaf, `heat / currentMax` is exactly 1.0 forever. Only an
    // absolute reference in the denominator can bring it down.
    const c = clock();
    const map = new RepoMap({ nowMs: c.now, halfLifeMs: 5 * MIN, referenceHeat: 2 });
    map.touch(["only.ts"]);

    const before = map.list()[0]?.intensity ?? 0;
    c.advance(30 * MIN);
    const after = map.list()[0]?.intensity ?? 0;

    expect(after).toBeLessThan(before);
    expect(after).toBeLessThan(0.05);
  });

  it("cools even when EVERY file decays uniformly", () => {
    // The general form of the same trap: uniform decay preserves every ratio.
    const c = clock();
    const map = new RepoMap({ nowMs: c.now, halfLifeMs: 5 * MIN });
    map.touch(["a.ts", "b.ts", "c.ts"]);

    c.advance(45 * MIN);
    for (const leaf of map.list()) expect(leaf.idle).toBe(true);
  });

  it("keeps a genuinely hot file saturated while it is being worked on", () => {
    const c = clock();
    const map = new RepoMap({ nowMs: c.now, halfLifeMs: 5 * MIN, referenceHeat: 2 });
    for (let i = 0; i < 10; i++) {
      map.touch(["hot.ts"]);
      c.advance(2_000);
    }
    expect(map.list()[0]?.intensity).toBeCloseTo(1, 5);
  });

  it("ranks a recently touched file above a stale one", () => {
    const c = clock();
    const map = new RepoMap({ nowMs: c.now, halfLifeMs: 5 * MIN });
    map.touch(["old.ts"]);
    c.advance(20 * MIN);
    map.touch(["new.ts"]);

    expect(map.list().map((l) => l.path)).toEqual(["new.ts", "old.ts"]);
  });

  it("decays existing heat before adding, so spaced touches do not sum", () => {
    const c = clock();
    const spaced = new RepoMap({ nowMs: c.now, halfLifeMs: 5 * MIN });
    spaced.touch(["f.ts"]);
    c.advance(5 * MIN);
    spaced.touch(["f.ts"]);

    const c2 = clock();
    const together = new RepoMap({ nowMs: c2.now, halfLifeMs: 5 * MIN });
    together.touch(["f.ts"]);
    together.touch(["f.ts"]);

    expect(spaced.list()[0]?.heat).toBeLessThan(together.list()[0]?.heat ?? 0);
  });
});

describe("clock jumps cannot corrupt the map", () => {
  it("a backwards clock does not raise heat", () => {
    // NTP correction or a sleeping laptop. Negative elapsed must clamp to zero
    // rather than run the decay in reverse and resurrect a cold file.
    let t = 10 * MIN;
    const map = new RepoMap({ nowMs: () => t, halfLifeMs: 5 * MIN });
    map.touch(["f.ts"]);
    const before = map.list()[0]?.heat ?? 0;

    t = 0; // clock steps backwards
    expect(map.list()[0]?.heat).toBeLessThanOrEqual(before);
  });

  it("an enormous jump decays by a bounded amount, not to nothing", () => {
    const c = clock();
    const map = new RepoMap({ nowMs: c.now, halfLifeMs: 5 * MIN, maxElapsedMs: 60 * MIN });
    map.touch(["f.ts"]);

    c.advance(30 * 24 * 60 * MIN); // a month asleep
    const heat = map.list()[0]?.heat ?? -1;
    expect(heat).toBeGreaterThan(0);
    expect(Number.isFinite(heat)).toBe(true);
  });
});

describe("MOD-08 — totals never decay", () => {
  it("keeps a cumulative total that only grows", () => {
    const c = clock();
    const map = new RepoMap({ nowMs: c.now, halfLifeMs: 5 * MIN });
    map.touch(["f.ts"]);
    map.touch(["f.ts"]);
    c.advance(10 * 60 * MIN);
    map.touch(["f.ts"]);

    expect(map.totals()[0]).toEqual({ path: "f.ts", total: 3 });
  });

  it("reads cold live and hot cumulatively — the SC11 case", () => {
    // A file edited heavily early and untouched since. This is the whole reason
    // both numbers are kept rather than one being derived from the other.
    const c = clock();
    const map = new RepoMap({ nowMs: c.now, halfLifeMs: 5 * MIN });
    for (let i = 0; i < 20; i++) map.touch(["early.ts"]);
    c.advance(60 * MIN);
    map.touch(["late.ts"]);

    expect(map.list()[0]?.path).toBe("late.ts"); // live: the recent one leads
    expect(map.totals()[0]?.path).toBe("early.ts"); // session: the heavy one leads
  });
});

describe("MOD-02 — grows from what was touched", () => {
  it("contains only touched paths", () => {
    const map = new RepoMap({ nowMs: clock().now });
    map.touch(["src/a.ts", "src/b.ts"]);
    expect(
      map
        .list()
        .map((l) => l.path)
        .sort(),
    ).toEqual(["src/a.ts", "src/b.ts"]);
    expect(map.size).toBe(2);
  });

  it("never truncates the map itself, only a requested view of it", () => {
    // The previous version had a node cap that silently dropped files — a map
    // that is truncated without saying so lies about where work is happening.
    const map = new RepoMap({ nowMs: clock().now });
    map.touch(Array.from({ length: 500 }, (_, i) => `f${i}.ts`));

    expect(map.size).toBe(500);
    expect(map.list()).toHaveLength(500);
    expect(map.hottest(10)).toHaveLength(10);
  });

  it("ignores empty and non-string paths rather than creating junk leaves", () => {
    const map = new RepoMap({ nowMs: clock().now });
    map.touch(["", "real.ts", undefined as unknown as string]);
    expect(map.list().map((l) => l.path)).toEqual(["real.ts"]);
  });

  it("ignores a nonsensical weight instead of poisoning heat with NaN", () => {
    const map = new RepoMap({ nowMs: clock().now });
    map.touch(["f.ts"], Number.NaN);
    map.touch(["f.ts"], -5);
    expect(map.size).toBe(0);
  });

  it("is empty before anything is touched", () => {
    const map = new RepoMap({ nowMs: clock().now });
    expect(map.list()).toEqual([]);
    expect(map.totals()).toEqual([]);
  });
});

describe("MOD-08 — a bounded, downsampled progression", () => {
  it("holds an 8-hour session below a fixed ceiling while still spanning it", () => {
    // The spec's own test. Memory must be O(1) in session length, not O(t).
    const c = clock();
    const map = new RepoMap({ nowMs: c.now, progressionSamples: 60 });
    const start = c.now();

    // 8 hours, sampled every 30s — 960 intervals through a 60-slot ring.
    for (let i = 0; i < 960; i++) {
      map.touch([`f${i % 25}.ts`]);
      c.advance(30_000);
      map.sample();
    }

    expect(map.samples).toBeLessThanOrEqual(60);
    const frames = map.frames();
    expect(frames.length).toBeLessThanOrEqual(60);
    // Still spans the whole session rather than only its tail.
    expect((frames.at(-1)?.at ?? 0) - start).toBeGreaterThanOrEqual(8 * 60 * MIN - 30_000);
    expect(frames[0]?.at).toBeLessThan(start + 8 * 60 * MIN);
  });

  it("loses no totals to compaction — merging is summation, not eviction", () => {
    // The property that makes "merged rather than dropped" true. If compaction
    // discarded a sample instead of folding it, the final frame would disagree
    // with the map's own totals.
    const c = clock();
    const map = new RepoMap({ nowMs: c.now, progressionSamples: 4 });
    for (let i = 0; i < 200; i++) {
      map.touch(["a.ts", i % 3 === 0 ? "b.ts" : "c.ts"]);
      c.advance(1_000);
      map.sample();
    }

    const last = map.frames().at(-1)?.totals ?? {};
    const truth = Object.fromEntries(map.totals().map((t) => [t.path, t.total]));
    expect(last).toEqual(truth);
  });

  it("is monotonic — a cumulative total never decreases between frames", () => {
    const c = clock();
    const map = new RepoMap({ nowMs: c.now, progressionSamples: 8 });
    for (let i = 0; i < 100; i++) {
      map.touch([`f${i % 5}.ts`]);
      c.advance(1_000);
      map.sample();
    }

    const frames = map.frames();
    for (let i = 1; i < frames.length; i++) {
      for (const [path, total] of Object.entries(frames[i]?.totals ?? {})) {
        expect(total).toBeGreaterThanOrEqual(frames[i - 1]?.totals[path] ?? 0);
      }
    }
  });

  it("records a quiet interval rather than skipping it", () => {
    // A stretch where nothing happened is a real feature of how work spread.
    const c = clock();
    const map = new RepoMap({ nowMs: c.now, progressionSamples: 10 });
    map.touch(["a.ts"]);
    c.advance(MIN);
    map.sample();
    c.advance(MIN);
    map.sample(); // nothing happened in this one

    expect(map.samples).toBe(2);
    expect(map.frames()[1]?.totals).toEqual({ "a.ts": 1 });
  });

  it("keeps the oldest interval through repeated compaction", () => {
    // Halving pairs preserves the head; evicting one would truncate the span,
    // which is the thing MOD-08 forbids.
    const c = clock();
    const map = new RepoMap({ nowMs: c.now, progressionSamples: 4 });
    map.touch(["first.ts"]);
    c.advance(1_000);
    map.sample();

    for (let i = 0; i < 50; i++) {
      map.touch(["later.ts"]);
      c.advance(1_000);
      map.sample();
    }

    // The very first file is still represented in the earliest frame.
    expect(map.frames()[0]?.totals["first.ts"]).toBe(1);
  });

  it("retains only paths and counts — no events, arguments or reasoning", () => {
    const c = clock();
    const map = new RepoMap({ nowMs: c.now });
    map.touch(["a.ts"]);
    map.sample();

    const frame = map.frames()[0];
    expect(Object.keys(frame ?? {}).sort()).toEqual(["at", "totals"]);
    expect(Object.values(frame?.totals ?? {}).every((v) => typeof v === "number")).toBe(true);
  });

  it("has no frames before the first sample", () => {
    const map = new RepoMap({ nowMs: clock().now });
    map.touch(["a.ts"]);
    expect(map.frames()).toEqual([]);
    expect(map.samples).toBe(0);
  });
});
