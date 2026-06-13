import { describe, it, expect } from "vitest";
import { extractCodexReasoning } from "../src/transcript.js";

describe("extractCodexReasoning", () => {
  it("extracts text from a rollout `reasoning` item", () => {
    expect(extractCodexReasoning(JSON.stringify({ type: "response_item", item: { type: "reasoning", text: "Planning the patch" } }))).toBe("Planning the patch");
  });
  it("extracts from an `agent_message` event_msg", () => {
    expect(extractCodexReasoning(JSON.stringify({ type: "event_msg", msg: { type: "agent_message", message: "Applying the edit" } }))).toBe("Applying the edit");
  });
  it("returns null for non-reasoning / malformed lines", () => {
    expect(extractCodexReasoning(JSON.stringify({ type: "response_item", item: { type: "function_call" } }))).toBeNull();
    expect(extractCodexReasoning("not json")).toBeNull();
  });
});
