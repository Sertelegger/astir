import { describe, it, expect, beforeEach } from "vitest";
import { renderHeatmap, type HeatmapCallbacks } from "../src/render-heatmap.js";
import { computeLayout } from "../src/layout.js";
import type { DirDTO, AgentRecordDTO } from "../src/protocol.js";
import { IDLE_COLOR } from "../src/color.js";

const tree: DirDTO = { path: "", type: "dir", heat: 3, children: [
  { path: "src", type: "dir", heat: 3, children: [
    { path: "src/hot.ts", type: "file", loc: 20, binary: false, heat: 3, reads: 0, edits: 2, agents: ["sub-A"], pulse: true },
    { path: "src/cold.ts", type: "file", loc: 20, binary: false, heat: 0, reads: 0, edits: 0, agents: [] },
  ] },
] };
const agents: AgentRecordDTO[] = [{ id: "sub-A", provider: "claude", name: "A", agentType: "Explore", parentId: "s1", parentInferred: false, state: "tool-running", now: "x", nowSource: "template", color: "#e879f9", currentFiles: ["src/hot.ts"] }];

let svg: SVGSVGElement;
beforeEach(() => { svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); });
const ctx = { maxLeafHeat: 3, agents, shape: "treemap" as const, size: { width: 100, height: 100 } };

describe("renderHeatmap (treemap)", () => {
  it("hot leaf colored, cold leaf idle", () => {
    renderHeatmap(svg, computeLayout(tree, "", "treemap", ctx.size), ctx, {} as HeatmapCallbacks);
    expect((svg.querySelector('[data-path="src/hot.ts"]') as SVGElement).getAttribute("fill")).toBe("rgb(255, 90, 40)");
    expect((svg.querySelector('[data-path="src/cold.ts"]') as SVGElement).getAttribute("fill")).toBe(IDLE_COLOR);
  });
  it("rings a leaf in its agent's color + marks pulse", () => {
    renderHeatmap(svg, computeLayout(tree, "", "treemap", ctx.size), ctx, {} as HeatmapCallbacks);
    const hot = svg.querySelector('[data-path="src/hot.ts"]') as SVGElement;
    expect(hot.getAttribute("stroke")).toBe("#e879f9");
    expect(hot.getAttribute("data-pulse")).toBe("true");
  });
  it("ring uses the leaf's most-recently-touching agent (agents[0]) — REQ-032", () => {
    const twoAgents: AgentRecordDTO[] = [
      { id: "subA", provider: "claude", name: "A", agentType: null, parentId: "s1", parentInferred: false, state: "tool-running", now: "x", nowSource: "template", color: "#aaaaaa", currentFiles: ["src/shared.ts"] },
      { id: "subB", provider: "claude", name: "B", agentType: null, parentId: "s1", parentInferred: false, state: "tool-running", now: "x", nowSource: "template", color: "#bbbbbb", currentFiles: ["src/shared.ts"] },
    ];
    const treeFor = (order: string[]): DirDTO => ({ path: "", type: "dir", heat: 3, children: [
      { path: "src", type: "dir", heat: 3, children: [
        { path: "src/shared.ts", type: "file", loc: 20, binary: false, heat: 3, reads: 0, edits: 2, agents: order },
      ] },
    ] });
    const strokeFor = (order: string[]): string | null => {
      const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const t = treeFor(order);
      renderHeatmap(s, computeLayout(t, "", "treemap", ctx.size), { ...ctx, agents: twoAgents }, {} as HeatmapCallbacks);
      return (s.querySelector('[data-path="src/shared.ts"]') as SVGElement).getAttribute("stroke");
    };
    expect(strokeFor(["subB", "subA"])).toBe("#bbbbbb");
    expect(strokeFor(["subA", "subB"])).toBe("#aaaaaa");
  });
  it("no ring when the leaf's agents are unknown to the agent records", () => {
    const orphan: DirDTO = { path: "", type: "dir", heat: 3, children: [
      { path: "src", type: "dir", heat: 3, children: [
        { path: "src/hot.ts", type: "file", loc: 20, binary: false, heat: 3, reads: 0, edits: 2, agents: ["ghost"] },
      ] },
    ] };
    renderHeatmap(svg, computeLayout(orphan, "", "treemap", ctx.size), ctx, {} as HeatmapCallbacks);
    expect((svg.querySelector('[data-path="src/hot.ts"]') as SVGElement).getAttribute("stroke")).toBeNull();
  });
  it("click leaf → onFile, click dir → onZoom", () => {
    let opened = ""; let zoomed = "";
    renderHeatmap(svg, computeLayout(tree, "", "treemap", ctx.size), ctx, { onFile: (p) => (opened = p), onZoom: (p) => (zoomed = p) });
    (svg.querySelector('[data-path="src/hot.ts"]') as SVGElement).dispatchEvent(new Event("click"));
    (svg.querySelector('[data-path="src"]') as SVGElement).dispatchEvent(new Event("click"));
    expect(opened).toBe("src/hot.ts");
    expect(zoomed).toBe("src");
  });
});
