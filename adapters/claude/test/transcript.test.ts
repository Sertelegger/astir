import { describe, it, expect } from "vitest";
import { extractReasoning } from "../src/transcript.js";

describe("extractReasoning", () => {
  it("returns the assistant text/thinking from a transcript JSONL line", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [
      { type: "thinking", text: "Let me refactor the login flow" },
      { type: "text", text: "Refactoring login" },
    ] } });
    expect(extractReasoning(line)).toBe("Refactoring login"); // prefer the latest text block
  });
  it("falls back to a thinking block when there is no text block", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", text: "Considering options" }] } });
    expect(extractReasoning(line)).toBe("Considering options");
  });
  it("returns null for non-assistant / toolresult / malformed lines", () => {
    expect(extractReasoning(JSON.stringify({ type: "user", message: {} }))).toBeNull();
    expect(extractReasoning(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit" }] } }))).toBeNull();
    expect(extractReasoning("not json")).toBeNull();
  });
});
