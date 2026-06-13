import { describe, it, expect } from "vitest";
import { renderTree, renderRail } from "../src/render.js";
import type { DirDTO, AgentRecordDTO } from "../src/protocol.js";

const tree: DirDTO = { path: "", type: "dir", heat: 3, children: [
  { path: "src", type: "dir", heat: 3, children: [
    { path: "src/hot.ts", type: "file", loc: 5, binary: false, heat: 3, reads: 0, edits: 2, agents: [] },
    { path: "src/cold.ts", type: "file", loc: 5, binary: false, heat: 0, reads: 0, edits: 0, agents: [] },
  ] },
] };

describe("renderTree", () => {
  it("indents by depth, shows file names + heat bars; hot file has more blocks than cold (mono)", () => {
    const out = renderTree(tree, 3, "mono");
    expect(out).toContain("src");
    expect(out).toContain("hot.ts");
    expect(out).toContain("cold.ts");
    const hotLine = out.split("\n").find((l) => l.includes("hot.ts"))!;
    const coldLine = out.split("\n").find((l) => l.includes("cold.ts"))!;
    const bars = (s: string) => (s.match(/#/g) ?? []).length;
    expect(bars(hotLine)).toBeGreaterThan(bars(coldLine));
  });
  it("rolls dir heat into the dir row", () => {
    const out = renderTree(tree, 3, "mono");
    const srcLine = out.split("\n").find((l) => l.includes("src") && !l.includes(".ts"))!;
    expect(srcLine).toMatch(/#/); // src dir shows rolled heat
  });
});

describe("renderRail", () => {
  it("nests agents by parentId and shows state + Now", () => {
    const agents: AgentRecordDTO[] = [
      { id: "s1", provider: "claude", name: "main", agentType: null, parentId: null, parentInferred: false, state: "thinking", now: "Planning", nowSource: "reasoning", color: "#60a5fa", currentFiles: [] },
      { id: "a", provider: "claude", name: "Explore", agentType: "Explore", parentId: "s1", parentInferred: false, state: "tool-running", now: "Searching", nowSource: "template", color: "#e879f9", currentFiles: [] },
    ];
    const out = renderRail(agents);
    expect(out).toContain("main");
    expect(out).toContain("Explore");
    expect(out).toContain("Searching");
    expect(out).toContain("thinking");
    const lines = out.split("\n");
    const childLine = lines.find((l) => l.includes("Explore"))!;
    expect(childLine.startsWith(" ")).toBe(true); // child indented
  });
});
