import { describe, expect, it } from "vitest";
import { type DecayParams, type FileFrame, shades } from "../src/status/frames.js";
import { layout, type Rect, type Sized } from "../src/status/layout.js";

const AREA: Rect = { x: 0, y: 0, w: 800, h: 600 };
const f = (path: string, total = 1): Sized => ({ path, total });

const area = (r: Rect) => r.w * r.h;
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;

describe("the map is total — nothing is quietly dropped", () => {
  it("gives every file exactly one tile", () => {
    // VIEW-06 in geometric form. A file with no tile is a file the map says was
    // never touched.
    const files = Array.from({ length: 250 }, (_, i) => f(`src/dir${i % 12}/f${i}.ts`, 1 + (i % 7)));
    const { tiles } = layout(files, AREA);

    expect(tiles).toHaveLength(250);
    expect(new Set(tiles.map((t) => t.path)).size).toBe(250);
  });

  it("keeps a file with zero touches", () => {
    const { tiles } = layout([f("a.ts", 0), f("b.ts", 5)], AREA);
    expect(tiles.map((t) => t.path).sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("still returns every tile when the area is degenerate", () => {
    // A panel collapsed to nothing, or measured before layout. Returning fewer
    // tiles here would make the map lie the moment a window is dragged narrow.
    const { tiles } = layout([f("a.ts"), f("b.ts")], { x: 0, y: 0, w: 0, h: 400 });
    expect(tiles).toHaveLength(2);
    expect(tiles.every((t) => Number.isFinite(t.x) && Number.isFinite(t.w))).toBe(true);
  });

  it("survives paths that are not really paths", () => {
    const { tiles } = layout([f(""), f("/"), f("a//b.ts"), f("ok.ts")], AREA);
    expect(tiles.map((t) => t.path).sort()).toEqual(["a//b.ts", "ok.ts"]);
  });
});

describe("tiles do not overlap and stay inside their area", () => {
  it("packs a flat set without collisions", () => {
    const files = Array.from({ length: 40 }, (_, i) => f(`f${i}.ts`, 1 + (i % 9)));
    const { tiles } = layout(files, AREA);

    for (let i = 0; i < tiles.length; i++) {
      for (let j = i + 1; j < tiles.length; j++) {
        expect(overlaps(tiles[i] as Rect, tiles[j] as Rect), `${i} vs ${j}`).toBe(false);
      }
    }
  });

  it("stays within the area it was given", () => {
    const files = Array.from({ length: 60 }, (_, i) => f(`src/a/b/f${i}.ts`, 1 + (i % 5)));
    for (const t of layout(files, AREA).tiles) {
      expect(t.x).toBeGreaterThanOrEqual(AREA.x - 1e-6);
      expect(t.y).toBeGreaterThanOrEqual(AREA.y - 1e-6);
      expect(t.x + t.w).toBeLessThanOrEqual(AREA.x + AREA.w + 1e-6);
      expect(t.y + t.h).toBeLessThanOrEqual(AREA.y + AREA.h + 1e-6);
    }
  });

  it("fills the area rather than leaving most of it blank", () => {
    // Squarify can silently degenerate into placing everything in one strip.
    const files = Array.from({ length: 30 }, (_, i) => f(`f${i}.ts`, 1 + (i % 4)));
    const covered = layout(files, AREA).tiles.reduce((s, t) => s + area(t), 0);
    expect(covered).toBeGreaterThan(area(AREA) * 0.98);
  });
});

describe("VIEW-10 — geometry cannot depend on the mode", () => {
  it("gives equal totals equal tiles, whatever their heat", () => {
    // `layout` sees paths and totals; heat is not a parameter, and the
    // signature is the real guard. This pins the observable consequence,
    // because the compiler only refuses a *new* parameter — nothing stops
    // someone folding heat into the tile weight through the `Sized` it already
    // gets. Then the map reflows every time it cools, which is the failure
    // VIEW-10/SC11 exists to prevent.
    const decay: DecayParams = { halfLifeMs: 60_000, referenceHeat: 2, idleFloor: 0.05 };
    // The same totals reached two ways, per the distinction FileFrame.heat
    // documents: twenty touches in a minute carries far more heat than twenty
    // spread across an hour. Totals are equal, so the tiles must be equal.
    const bursty: FileFrame[] = [
      { path: "early.ts", total: 20, heat: 9, ageMs: 0 },
      { path: "late.ts", total: 1, heat: 1, ageMs: 0 },
    ];
    const spread: FileFrame[] = [
      { path: "early.ts", total: 20, heat: 1.2, ageMs: 0 },
      { path: "late.ts", total: 1, heat: 0.9, ageMs: 0 },
    ];

    // If the shading did not actually move, the geometry check below would
    // pass for the wrong reason.
    const intensities = (fs: FileFrame[]) => shades(fs, "live", 0, decay).map((s) => s.intensity);
    expect(intensities(spread)).not.toEqual(intensities(bursty));

    expect(layout(spread, AREA).tiles).toEqual(layout(bursty, AREA).tiles);
  });

  it("is stable when nothing has been touched since the last frame", () => {
    const files = [f("a/x.ts", 3), f("a/y.ts", 8), f("b/z.ts", 1)];
    expect(layout(files, AREA).tiles).toEqual(layout(files, AREA).tiles);
  });

  it("does not reshuffle equal-weight files between frames", () => {
    // Ties broken by weight alone would depend on insertion order, and the map
    // would twitch every time an unrelated file was touched.
    const a = [f("m.ts", 4), f("n.ts", 4), f("o.ts", 4)];
    const b = [f("o.ts", 4), f("m.ts", 4), f("n.ts", 4)];
    const paths = (fs: Sized[]) => layout(fs, AREA).tiles.map((t) => `${t.path}@${t.x},${t.y}`);
    expect(paths(a)).toEqual(paths(b));
  });
});

describe("area encodes work, but compressed", () => {
  it("ranks a heavily touched file above a lightly touched one", () => {
    const { tiles } = layout([f("hot.ts", 64), f("cold.ts", 1)], AREA);
    const hot = tiles.find((t) => t.path === "hot.ts") as Rect;
    const cold = tiles.find((t) => t.path === "cold.ts") as Rect;
    expect(area(hot)).toBeGreaterThan(area(cold));
  });

  it("does NOT let one file swallow the map, which linear area would", () => {
    // 64:1 in touches is 8:1 in area, not 64:1 — so `cold.ts` is still a tile
    // someone can see and click rather than a one-pixel sliver.
    const { tiles } = layout([f("hot.ts", 64), f("cold.ts", 1)], AREA);
    const hot = tiles.find((t) => t.path === "hot.ts") as Rect;
    const cold = tiles.find((t) => t.path === "cold.ts") as Rect;
    expect(area(hot) / area(cold)).toBeCloseTo(8, 0);
  });

  it("avoids slivers — the failure that makes a treemap unusable", () => {
    const files = Array.from({ length: 50 }, (_, i) => f(`f${i}.ts`, 1 + (i % 6)));
    const ratios = layout(files, AREA).tiles.map((t) => Math.max(t.w / t.h, t.h / t.w));
    const median = ratios.sort((a, b) => a - b)[Math.floor(ratios.length / 2)] as number;
    expect(median).toBeLessThan(3);
  });
});

describe("directories are frames, not noise", () => {
  it("groups files under their directory", () => {
    const { groups } = layout([f("src/a.ts"), f("src/b.ts"), f("test/c.ts")], AREA);
    expect(groups.map((g) => g.prefix).sort()).toEqual(["src", "test"]);
  });

  it("collapses a chain that adds no information", () => {
    // `src → status → …` where each level has one child is three nested boxes
    // saying one thing. The joined label says it once.
    const { groups } = layout([f("src/status/a.ts"), f("src/status/b.ts")], AREA);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("src/status");
    expect(groups[0]?.prefix).toBe("src/status");
  });

  it("does not collapse a lone file into its directory", () => {
    // A directory holding exactly one file is real structure; folding the file
    // away would lose the tile entirely.
    const { tiles, groups } = layout([f("src/only.ts"), f("other.ts")], AREA);
    expect(tiles.map((t) => t.path).sort()).toEqual(["other.ts", "src/only.ts"]);
    expect(groups.map((g) => g.prefix)).toEqual(["src"]);
  });

  it("keeps a directory's files inside that directory's frame", () => {
    const { tiles, groups } = layout(
      [f("src/a.ts", 3), f("src/b.ts", 2), f("test/c.ts", 5), f("test/d.ts", 1)],
      AREA,
    );
    for (const g of groups) {
      for (const t of tiles.filter((t) => t.path.startsWith(`${g.prefix}/`))) {
        expect(t.x, t.path).toBeGreaterThanOrEqual(g.x - 1e-6);
        expect(t.x + t.w, t.path).toBeLessThanOrEqual(g.x + g.w + 1e-6);
        expect(t.y, t.path).toBeGreaterThanOrEqual(g.y - 1e-6);
        expect(t.y + t.h, t.path).toBeLessThanOrEqual(g.y + g.h + 1e-6);
      }
    }
  });

  it("is empty for an empty session rather than throwing", () => {
    expect(layout([], AREA)).toEqual({ tiles: [], groups: [] });
  });
});
