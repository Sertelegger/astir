import { describe, it, expect } from "vitest";
import { tailStep } from "../src/tailer.js";

describe("tailStep", () => {
  it("posts reasoning for the main agent from new assistant lines (latest wins)", async () => {
    const posted: Array<{ agentId: string; text: string }> = [];
    const post = async (agentId: string, _ts: number, text: string) => { posted.push({ agentId, text }); };
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Reading config" }] } }),
      JSON.stringify({ type: "user", message: {} }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Editing config" }] } }),
    ];
    await tailStep(lines, "s1", 100, post);
    expect(posted.at(-1)).toEqual({ agentId: "s1", text: "Editing config" });
  });
  it("posts nothing when there is no assistant reasoning", async () => {
    const posted: unknown[] = [];
    await tailStep([JSON.stringify({ type: "user", message: {} })], "s1", 1, async () => { posted.push(1); });
    expect(posted).toHaveLength(0);
  });
});
