import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoTree } from "../src/model/tree.js";
import { systemClock } from "../src/model/clock.js";

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function scaffold(): string {
  dir = mkdtempSync(join(tmpdir(), "clide-tree-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "line1\nline2\nline3\n");
  writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(dir, "ignored.txt"), "secret\n");
  return dir;
}

describe("RepoTree", () => {
  it("scans files, computes LOC, and honors .gitignore", () => {
    const t = new RepoTree(scaffold(), systemClock);
    t.build();
    const leaf = t.getLeaf("src/a.ts");
    expect(leaf?.loc).toBe(3);
    expect(t.getLeaf("ignored.txt")).toBeUndefined();
  });
  it("touchFile adds heat and creates a missing node on first touch (REQ-026)", () => {
    const t = new RepoTree(scaffold(), systemClock);
    t.build();
    t.touchFile("src/new.ts", "write", 100);
    const leaf = t.getLeaf("src/new.ts");
    expect(leaf).toBeDefined();
    expect(leaf!.heat.value()).toBeGreaterThan(0);
  });
  it("drops out-of-repo paths into a counter, never a node (REQ-026)", () => {
    const t = new RepoTree(scaffold(), systemClock);
    t.build();
    t.touchFile("../escape.ts", "edit", 100);
    expect(t.droppedPaths).toBe(1);
    expect(t.getLeaf("../escape.ts")).toBeUndefined();
  });
  it("removeFile deletes the node (REQ-026)", () => {
    const t = new RepoTree(scaffold(), systemClock);
    t.build();
    t.removeFile("src/a.ts");
    expect(t.getLeaf("src/a.ts")).toBeUndefined();
  });
  it("maxLeafHeat reflects the hottest leaf (REQ-021/022 normalization basis)", () => {
    const t = new RepoTree(scaffold(), systemClock);
    t.build();
    t.touchFile("src/a.ts", "write", 100);
    expect(t.maxLeafHeat()).toBeGreaterThan(0);
  });
});
