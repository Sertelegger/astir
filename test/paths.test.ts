import { describe, expect, it } from "vitest";
import { absolutePathOf } from "../src/status/paths.js";

describe("VIEW-05 — the path a click hands you", () => {
  it("joins the session's cwd to the repo-relative path", () => {
    expect(absolutePathOf("/home/dev/repos/astir", "src/status/map.ts")).toBe(
      "/home/dev/repos/astir/src/status/map.ts",
    );
  });

  it("does not double the separator when cwd already ends in one", () => {
    expect(absolutePathOf("/repo/", "a.ts")).toBe("/repo/a.ts");
  });

  it("uses the SESSION's separator, not the browser's", () => {
    // The map may be opened from any machine. A Windows session viewed from a
    // Mac must still yield a Windows path, and the reverse — otherwise the
    // pasted path is wrong for exactly the machine it names.
    expect(absolutePathOf("C:\\src\\repo", "src/a.ts")).toBe("C:\\src\\repo\\src\\a.ts");
    expect(absolutePathOf("\\\\server\\share", "a.ts")).toBe("\\\\server\\share\\a.ts");
  });

  it("treats a POSIX cwd as POSIX even where a drive letter could be guessed at", () => {
    // `/c/src` under Git Bash is a POSIX path and must stay one.
    expect(absolutePathOf("/c/src/repo", "a.ts")).toBe("/c/src/repo/a.ts");
  });

  it("returns the relative path unchanged when there is no cwd to join", () => {
    // A session whose cwd never arrived. A bare relative path is a worse
    // answer than an absolute one but a much better answer than "/a.ts",
    // which names a file at the filesystem root that does not exist.
    expect(absolutePathOf("", "src/a.ts")).toBe("src/a.ts");
  });
});
