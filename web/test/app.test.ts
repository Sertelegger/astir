import { describe, it, expect, beforeEach } from "vitest";
import { App } from "../src/app.js";
import type { Frame, SnapshotDTO } from "../src/protocol.js";

const snap: SnapshotDTO = {
  provider: "claude", sessionId: "s1", state: "live",
  tree: { path: "", type: "dir", heat: 3, children: [
    { path: "src", type: "dir", heat: 3, children: [
      { path: "src/a.ts", type: "file", loc: 10, binary: false, heat: 3, reads: 0, edits: 1, agents: ["s1"] },
    ] },
  ] },
  agents: [{ id: "s1", provider: "claude", name: "main", agentType: null, parentId: null, parentInferred: false, state: "thinking", now: "Editing a.ts", nowSource: "template", color: "#60a5fa", currentFiles: ["src/a.ts"] }],
};
const frame: Frame<SnapshotDTO> = { type: "snapshot", sessionId: "s1", ts: 1, payload: snap };

let root: HTMLElement;
beforeEach(() => { root = document.createElement("div"); });

describe("App", () => {
  it("renders rail + heat-map from a snapshot frame", () => {
    const opened: string[] = [];
    const app = new App(root, "s1", { openFile: (p) => opened.push(p) }, { width: 200, height: 200 });
    app.onFrame(frame);
    expect(root.querySelectorAll("[data-agent]").length).toBe(1);
    const leaf = root.querySelector('[data-path="src/a.ts"]') as SVGElement;
    expect(leaf).toBeTruthy();
    leaf.dispatchEvent(new Event("click"));
    expect(opened).toEqual(["src/a.ts"]); // file click routes to host
    // whole-repo default is sunburst (path), not treemap (rect)
    expect(root.querySelector("path")).toBeTruthy();
  });
  it("toggleShape flips the rendered shape (rect → path)", () => {
    const app = new App(root, "s1", { openFile: () => {} }, { width: 200, height: 200 });
    app.onFrame(frame);
    // whole-repo default is sunburst (path); after toggle → treemap (rect)
    expect(root.querySelector("path")).toBeTruthy();
    app.toggleShape();
    expect(root.querySelector("rect")).toBeTruthy();
  });
});
