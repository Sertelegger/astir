import { describe, expect, it } from "vitest";
import {
  type Arrangement,
  allHidden,
  defaultArrangement,
  move,
  PANELS,
  type PanelId,
  panelsIn,
  reconcile,
  regionOf,
  reorder,
  setHidden,
  weightOf,
} from "../src/status/panels.js";

const ids = (a: Arrangement): PanelId[] => [...a.main, ...a.side, ...a.hidden];
const everyPanel = PANELS.map((p) => p.id);

/** Every known panel, exactly once, wherever it is. */
function assertTotal(a: Arrangement): void {
  expect([...ids(a)].sort()).toEqual([...everyPanel].sort());
  expect(new Set(ids(a)).size).toBe(everyPanel.length);
}

describe("VIEW-01 — no panel is privileged", () => {
  it("lets EVERY panel occupy EVERY region", () => {
    // The claim the requirement actually makes. Before this, the map was
    // `<main>` and could not be anywhere else — even a UI with drag handles
    // would have kept it structurally special.
    for (const id of everyPanel) {
      for (const region of ["main", "side"] as const) {
        const a = move(defaultArrangement(), id, region);
        expect(regionOf(a, id), `${id} in ${region}`).toBe(region);
        assertTotal(a);
      }
    }
  });

  it("lets every panel be hidden, including the map", () => {
    for (const id of everyPanel) {
      expect(regionOf(setHidden(defaultArrangement(), id, true), id), id).toBe("hidden");
    }
  });

  it("lets the map leave `main` entirely, emptying it", () => {
    // The sharpest version: if the layout still worked only because the map was
    // in main, this is where it would show.
    const a = move(defaultArrangement(), "map", "side");
    expect(panelsIn(a, "main")).toEqual([]);
    expect(panelsIn(a, "side")).toContain("map");
    assertTotal(a);
  });

  it("sizes a region from what is IN it, not from which panel it is", () => {
    // Move the heavy panel across and the weight follows it. A layout that
    // hard-coded "main is bigger" would not.
    const base = defaultArrangement();
    const flipped = move(base, "map", "side");
    const mapWeight = weightOf(base, "main");

    expect(mapWeight).toBeGreaterThan(0);
    // The weight went WITH the panel: main is now empty and side gained exactly
    // what main lost. A layout hard-coding "main is the big one" fails here.
    expect(weightOf(flipped, "main")).toBe(0);
    expect(weightOf(flipped, "side")).toBe(weightOf(base, "side") + mapWeight);
  });

  it("allows hiding everything, rather than protecting an arbitrary last panel", () => {
    // Refusing the last hide would make whichever panel happened to be last
    // privileged — exactly what the requirement forbids. The view renders an
    // empty state instead.
    let a = defaultArrangement();
    for (const id of everyPanel) a = setHidden(a, id, true);
    expect(allHidden(a)).toBe(true);
    assertTotal(a);
  });
});

describe("arranging", () => {
  it("moves a panel to a position within a region", () => {
    const a = move(defaultArrangement(), "legend", "side", 0);
    expect(panelsIn(a, "side")[0]).toBe("legend");
    assertTotal(a);
  });

  it("clamps an out-of-range position instead of losing the panel", () => {
    const a = move(defaultArrangement(), "map", "side", 99);
    expect(panelsIn(a, "side").at(-1)).toBe("map");
    assertTotal(a);
  });

  it("reorders within a region", () => {
    const before = panelsIn(defaultArrangement(), "side");
    const a = reorder(defaultArrangement(), before[1] as PanelId, -1);
    expect(panelsIn(a, "side")[0]).toBe(before[1]);
    expect(panelsIn(a, "side")[1]).toBe(before[0]);
  });

  it("does nothing at the ends rather than wrapping around", () => {
    // A control that flings a panel from top to bottom because it was already
    // at the top is a control people stop trusting.
    const a = defaultArrangement();
    const first = panelsIn(a, "side")[0] as PanelId;
    const last = panelsIn(a, "side").at(-1) as PanelId;
    expect(reorder(a, first, -1)).toEqual(a);
    expect(reorder(a, last, 1)).toEqual(a);
  });

  it("cannot reorder a hidden panel", () => {
    const a = setHidden(defaultArrangement(), "legend", true);
    expect(reorder(a, "legend", -1)).toEqual(a);
  });

  it("restores a hidden panel to its default region", () => {
    const a = setHidden(defaultArrangement(), "map", true);
    expect(regionOf(setHidden(a, "map", false), "map")).toBe("main");
  });

  it("never duplicates a panel, however much it is moved", () => {
    let a = defaultArrangement();
    for (let i = 0; i < 20; i++) {
      a = move(a, "map", i % 2 === 0 ? "side" : "main", i % 3);
      a = setHidden(a, "files", i % 4 === 0);
      a = reorder(a, "legend", i % 2 === 0 ? 1 : -1);
      assertTotal(a);
    }
  });

  it("ignores a panel name it does not know", () => {
    const a = defaultArrangement();
    expect(move(a, "nope" as PanelId, "main")).toEqual(a);
    expect(setHidden(a, "nope" as PanelId, true)).toEqual(a);
  });
});

describe("a stored arrangement is a preference, not a schema", () => {
  it("adds a panel the stored value never heard of", () => {
    // The release-upgrade case, and the one that fails silently: a panel added
    // after someone saved a layout must APPEAR, not be treated as hidden.
    const old = { main: ["map"], side: ["agents"], hidden: [] };
    const a = reconcile(old);

    assertTotal(a);
    expect(regionOf(a, "files"), "a panel the stored layout omitted").not.toBe("hidden");
    expect(regionOf(a, "legend")).not.toBe("hidden");
  });

  it("respects what the stored value DID say while adding the rest", () => {
    const a = reconcile({ main: ["agents"], side: ["map"], hidden: [] });
    expect(regionOf(a, "agents")).toBe("main");
    expect(regionOf(a, "map")).toBe("side");
    assertTotal(a);
  });

  it("keeps a panel the user deliberately hid", () => {
    const a = reconcile({ main: ["map"], side: ["agents", "files"], hidden: ["legend"] });
    expect(regionOf(a, "legend")).toBe("hidden");
  });

  it("drops a name this build cannot render", () => {
    // Written by a newer release, or naming a panel since removed. Throwing
    // here would brick the view for anyone who downgraded.
    const a = reconcile({ main: ["map", "timelapse"], side: ["agents"], hidden: [] });
    expect(ids(a)).not.toContain("timelapse");
    assertTotal(a);
  });

  it("deduplicates, keeping the first position", () => {
    const a = reconcile({ main: ["map", "map"], side: ["map", "agents"], hidden: [] });
    expect(regionOf(a, "map")).toBe("main");
    assertTotal(a);
  });

  it("resolves a panel listed in two places at once", () => {
    const a = reconcile({ main: ["legend"], side: [], hidden: ["legend"] });
    expect(regionOf(a, "legend")).toBe("main");
    assertTotal(a);
  });

  it.each([null, undefined, 42, "nope", [], {}, { main: "map" }, { main: [1, 2] }])(
    "falls back to the default for %s rather than to an empty view",
    (input) => {
      expect(reconcile(input)).toEqual(defaultArrangement());
    },
  );

  it("survives a round trip through JSON", () => {
    const a = setHidden(move(defaultArrangement(), "map", "side", 1), "legend", true);
    expect(reconcile(JSON.parse(JSON.stringify(a)))).toEqual(a);
  });

  it("treats a fully-hidden layout as deliberate, not as corrupt", () => {
    // It parses to something recognisable, so it is a choice — unlike `{}`,
    // which carries no panel names at all.
    const a = reconcile({ main: [], side: [], hidden: everyPanel });
    expect(allHidden(a)).toBe(true);
    assertTotal(a);
  });
});
