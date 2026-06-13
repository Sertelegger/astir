import { describe, it, expect } from "vitest";
import { classifyCodexTool } from "../src/classify.js";

describe("classifyCodexTool", () => {
  it("apply_patch → edit, extracts paths from patch headers", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: src/b.ts\n*** End Patch";
    expect(classifyCodexTool("apply_patch", { input: patch })).toEqual({ op: "edit", rawPaths: ["src/a.ts", "src/b.ts"] });
  });
  it("apply_patch → edit, extracts from a file_path/path/changes shape too", () => {
    expect(classifyCodexTool("apply_patch", { file_path: "src/c.ts" })).toEqual({ op: "edit", rawPaths: ["src/c.ts"] });
    expect(classifyCodexTool("apply_patch", { changes: [{ path: "src/d.ts" }] })).toEqual({ op: "edit", rawPaths: ["src/d.ts"] });
  });
  it("shell/exec_command/local_shell → other, no paths", () => {
    expect(classifyCodexTool("shell", { command: "ls" })).toEqual({ op: "other", rawPaths: [] });
    expect(classifyCodexTool("exec_command", { command: "cat x" }).op).toBe("other");
    expect(classifyCodexTool("local_shell", {}).op).toBe("other");
  });
  it("unknown/odd input → other, no throw", () => {
    expect(classifyCodexTool("frob", null)).toEqual({ op: "other", rawPaths: [] });
    expect(classifyCodexTool("apply_patch", null).rawPaths).toEqual([]);
  });
});
