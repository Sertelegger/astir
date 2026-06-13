import { describe, it, expect } from "vitest";
import { computeLayout, findSubtree } from "../src/layout.js";
import type { DirDTO } from "../src/protocol.js";

const tree: DirDTO = { path: "", type: "dir", heat: 4, children: [
  { path: "src", type: "dir", heat: 4, children: [
    { path: "src/a.ts", type: "file", loc: 30, binary: false, heat: 3, reads: 0, edits: 1, agents: [] },
    { path: "src/b.ts", type: "file", loc: 10, binary: false, heat: 1, reads: 1, edits: 0, agents: [] },
  ] },
] };

describe("layout", () => {
  it("findSubtree returns the focused node or null", () => {
    expect(findSubtree(tree, "src")?.path).toBe("src");
    expect(findSubtree(tree, "nope")).toBeNull();
    expect(findSubtree(tree, "")?.path).toBe("");
  });
  it("treemap positions leaves within the box; bigger LOC → bigger area", () => {
    const nodes = computeLayout(tree, "", "treemap", { width: 100, height: 100 });
    const a = nodes.find((n) => n.path === "src/a.ts")!;
    const b = nodes.find((n) => n.path === "src/b.ts")!;
    const area = (n: typeof a) => (n.x1 - n.x0) * (n.y1 - n.y0);
    expect(a.x0).toBeGreaterThanOrEqual(0);
    expect(a.x1).toBeLessThanOrEqual(100);
    expect(area(a)).toBeGreaterThan(area(b));
  });
  it("sunburst assigns angular spans; bigger LOC → wider angle", () => {
    const nodes = computeLayout(tree, "", "sunburst", { width: 200, height: 200 });
    const a = nodes.find((n) => n.path === "src/a.ts")!;
    const b = nodes.find((n) => n.path === "src/b.ts")!;
    expect((a.x1 - a.x0)).toBeGreaterThan(b.x1 - b.x0);
    expect(a.y1).toBeGreaterThan(a.y0);
  });
  it("focus scopes the layout to the subtree", () => {
    const nodes = computeLayout(tree, "src", "treemap", { width: 100, height: 100 });
    expect(nodes.some((n) => n.path === "src/a.ts")).toBe(true);
    expect(nodes.find((n) => n.path === "src")?.x0).toBe(0);
  });
});
