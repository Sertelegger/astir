import { describe, it, expect } from "vitest";
import { reduce, emptyState } from "../src/store.js";
import { renderTree, renderRail } from "../src/render.js";
import type { Frame, SnapshotDTO } from "../src/protocol.js";

describe("tui integration: snapshot → render", () => {
  it("renders a full view from a snapshot frame", () => {
    const snap: SnapshotDTO = { provider: "claude", sessionId: "s1", state: "live",
      tree: { path: "", type: "dir", heat: 3, children: [{ path: "src/a.ts", type: "file", loc: 5, binary: false, heat: 3, reads: 0, edits: 1, agents: [] }] },
      agents: [{ id: "s1", provider: "claude", name: "main", agentType: null, parentId: null, parentInferred: false, state: "thinking", now: "Editing a.ts", nowSource: "template", color: "#60a5fa", currentFiles: ["src/a.ts"] }] };
    const f: Frame<SnapshotDTO> = { type: "snapshot", sessionId: "s1", ts: 1, payload: snap };
    const s = reduce(emptyState(), f);
    const tree = renderTree(s.tree!, s.maxLeafHeat, "mono");
    const rail = renderRail(s.agents);
    expect(tree).toContain("a.ts");
    expect(rail).toContain("main");
    expect(rail).toContain("Editing a.ts");
  });
});
