import { describe, it, expect } from "vitest";
import { classifyTool } from "../src/classify.js";

describe("classifyTool", () => {
  it("Read → read with file_path", () => {
    expect(classifyTool("Read", { file_path: "/repo/src/a.ts" })).toEqual({ op: "read", rawPaths: ["/repo/src/a.ts"] });
  });
  it("Edit/Write/MultiEdit → edit/write", () => {
    expect(classifyTool("Edit", { file_path: "/r/a.ts" }).op).toBe("edit");
    expect(classifyTool("Write", { file_path: "/r/a.ts" }).op).toBe("write");
    expect(classifyTool("MultiEdit", { file_path: "/r/a.ts" }).op).toBe("edit");
    expect(classifyTool("NotebookEdit", { notebook_path: "/r/n.ipynb" })).toEqual({ op: "edit", rawPaths: ["/r/n.ipynb"] });
  });
  it("Bash/Task/Grep/unknown → other with no paths", () => {
    expect(classifyTool("Bash", { command: "ls" })).toEqual({ op: "other", rawPaths: [] });
    expect(classifyTool("Task", { subagent_type: "Explore" })).toEqual({ op: "other", rawPaths: [] });
    expect(classifyTool("Grep", { pattern: "x" }).op).toBe("other");
    expect(classifyTool("Frobnicate", {}).op).toBe("other");
  });
  it("handles missing/odd tool_input gracefully", () => {
    expect(classifyTool("Read", null).rawPaths).toEqual([]);
    expect(classifyTool("Read", { file_path: 42 }).rawPaths).toEqual([]);
  });
});
