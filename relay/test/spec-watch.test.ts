import { describe, it, expect } from "vitest";
import { matchesSpec, SpecTracker, DEFAULT_SPEC_GLOBS } from "../src/relay/spec-watch.js";

describe("matchesSpec", () => {
  it("matches the default spec/plan globs, rejects source", () => {
    expect(matchesSpec("docs/x.md", DEFAULT_SPEC_GLOBS)).toBe(true);
    expect(matchesSpec("docs/superpowers/specs/y.md", DEFAULT_SPEC_GLOBS)).toBe(true);
    expect(matchesSpec("pkg/specs/z.md", DEFAULT_SPEC_GLOBS)).toBe(true);
    expect(matchesSpec("plans/p.md", DEFAULT_SPEC_GLOBS)).toBe(true);
    expect(matchesSpec("src/a.ts", DEFAULT_SPEC_GLOBS)).toBe(false);
    expect(matchesSpec("README.md", DEFAULT_SPEC_GLOBS)).toBe(false);
  });
});

describe("SpecTracker", () => {
  it("classifies created (unseen) then updated (seen)", () => {
    const t = new SpecTracker();
    expect(t.onWrite("docs/x.md")).toBe("created");
    expect(t.onWrite("docs/x.md")).toBe("updated");
  });
  it("seeded paths are 'updated' on first write", () => {
    const t = new SpecTracker();
    t.seed(["docs/x.md"]);
    expect(t.onWrite("docs/x.md")).toBe("updated");
  });
  it("onDelete → deleted and forgets the path", () => {
    const t = new SpecTracker();
    t.onWrite("docs/x.md");
    expect(t.onDelete("docs/x.md")).toBe("deleted");
    expect(t.onWrite("docs/x.md")).toBe("created"); // re-create after delete
  });
  it("debounces repeated emits within the window (per path)", () => {
    let now = 0;
    const t = new SpecTracker({ debounceMs: 300, now: () => now });
    expect(t.shouldEmit("docs/x.md")).toBe(true);   // t=0
    now = 100; expect(t.shouldEmit("docs/x.md")).toBe(false); // within window
    now = 400; expect(t.shouldEmit("docs/x.md")).toBe(true);  // window elapsed
    expect(t.shouldEmit("docs/y.md")).toBe(true);   // different path
  });
});
