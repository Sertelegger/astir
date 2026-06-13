import { describe, it, expect } from "vitest";
import { tailStep } from "../src/tailer.js";

describe("tailStep", () => {
  it("posts reasoning for the main agent from new reasoning lines (latest wins)", async () => {
    const posted: Array<{ agentId: string; text: string }> = [];
    const post = async (agentId: string, _ts: number, text: string) => { posted.push({ agentId, text }); };
    const lines = [
      JSON.stringify({ type: "response_item", item: { type: "reasoning", text: "Planning the patch" } }),
      JSON.stringify({ type: "event_msg", msg: { type: "agent_message", message: "Applying the edit" } }),
    ];
    await tailStep(lines, "s1", 100, post);
    expect(posted.at(-1)).toEqual({ agentId: "s1", text: "Applying the edit" });
  });
  it("posts nothing when there is no reasoning in the lines", async () => {
    const posted: unknown[] = [];
    await tailStep([JSON.stringify({ type: "response_item", item: { type: "function_call" } })], "s1", 1, async () => { posted.push(1); });
    expect(posted).toHaveLength(0);
  });
});
