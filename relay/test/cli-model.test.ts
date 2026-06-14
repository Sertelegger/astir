import { describe, it, expect } from "vitest";
import { buildClaudeArgs, buildCodexArgs, buildPrompt } from "../src/relay/cli-model.js";
import type { EgressFields } from "../src/relay/auto-summarizer.js";

const fields: EgressFields = [{ kind: "post_tool", tool: "Edit", op: "edit", basenames: ["login.ts"] }];

describe("cli-model builders", () => {
  it("buildPrompt asks for a short phrase and embeds ONLY the egress fields (no file contents)", () => {
    const p = buildPrompt(fields);
    expect(p).toContain("8 words");
    expect(p).toContain("login.ts");
    expect(p).not.toContain("src/"); // basenames only — egress already stripped paths
  });
  it("buildClaudeArgs: -p prompt, haiku, bare, text", () => {
    expect(buildClaudeArgs("PROMPT")).toEqual(["-p", "PROMPT", "--model", "haiku", "--bare", "--output-format", "text"]);
    expect(buildClaudeArgs("P", "sonnet")[3]).toBe("sonnet");
  });
  it("buildCodexArgs: exec, read-only sandbox, no approvals, model when given, prompt last", () => {
    expect(buildCodexArgs("PROMPT")).toEqual(["exec", "--sandbox", "read-only", "--ask-for-approval", "never", "PROMPT"]);
    expect(buildCodexArgs("PROMPT", "gpt-5-mini")).toEqual(["exec", "--sandbox", "read-only", "--ask-for-approval", "never", "-m", "gpt-5-mini", "PROMPT"]);
  });
});
