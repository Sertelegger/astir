import { describe, it, expect } from "vitest";
import { ReasoningStore, condense, templatePhrase, passesNowGate } from "../src/model/reasoning.js";

describe("Now gate + helpers", () => {
  it("passesNowGate enforces <=80 chars, a verb-like token, no tool-call syntax", () => {
    expect(passesNowGate("Refactoring the login error handling")).toBe(true);
    expect(passesNowGate("Edit(src/a.ts)")).toBe(false);          // tool-call syntax
    expect(passesNowGate("x".repeat(81))).toBe(false);            // too long
    expect(passesNowGate("the the the")).toBe(false);             // no verb-like token
  });
  it("condense takes the first sentence, strips markdown, caps 80 chars", () => {
    const out = condense("**Refactoring** the login flow. Then I will add tests.");
    expect(out).toBe("Refactoring the login flow");
  });
  it("templatePhrase builds a friendly phrase from tool/op/path", () => {
    expect(templatePhrase("edit", "src/auth/login.ts")).toBe("Editing login.ts");
    expect(templatePhrase("read", "README.md")).toBe("Reading README.md");
  });
});

describe("ReasoningStore", () => {
  it("keeps highest-ts text per agent; ignores stale ts", () => {
    const s = new ReasoningStore();
    s.put("agA", 5, "newer");
    s.put("agA", 3, "older");
    expect(s.get("agA")).toBe("newer");
  });
  it("stores reasoning for unknown agents but is bounded", () => {
    const s = new ReasoningStore(2);
    s.put("a", 1, "x"); s.put("b", 1, "y"); s.put("c", 1, "z");
    expect(s.size()).toBeLessThanOrEqual(2);
  });
  it("drop removes an agent's reasoning (called when agent pruned)", () => {
    const s = new ReasoningStore();
    s.put("a", 1, "x"); s.drop("a");
    expect(s.get("a")).toBeUndefined();
  });
});
