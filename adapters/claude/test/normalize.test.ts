import { describe, it, expect } from "vitest";
import { normalizeClaudeHook } from "../src/normalize.js";

const baseTs = 1781200000;
const common = { session_id: "s1", cwd: "/repo", transcript_path: "/t.jsonl" };

describe("normalizeClaudeHook", () => {
  it("PostToolUse Edit → post_tool, edit op, repo-relative path, main agentId == session_id", () => {
    const e = normalizeClaudeHook({ ...common, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "/repo/src/a.ts" }, tool_output: "ok" }, baseTs)!;
    expect(e.kind).toBe("post_tool");
    expect(e.op).toBe("edit");
    expect(e.paths).toEqual(["src/a.ts"]);
    expect(e.agentId).toBe("s1");
    expect(e.provider).toBe("claude");
    expect(e.ok).toBe(true);
    expect(e.eventId).toBeTruthy();
  });
  it("subagent context: agentId == agent_id; PreToolUse → pre_tool", () => {
    const e = normalizeClaudeHook({ ...common, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/repo/x.ts" }, agent_id: "agA", agent_type: "Explore" }, baseTs)!;
    expect(e.kind).toBe("pre_tool");
    expect(e.agentId).toBe("agA");
    expect(e.agentType).toBe("Explore");
  });
  it("SubagentStart → subagent_start with agent id + type", () => {
    const e = normalizeClaudeHook({ ...common, hook_event_name: "SubagentStart", agent_id: "agB", agent_type: "Plan" }, baseTs)!;
    expect(e.kind).toBe("subagent_start");
    expect(e.agentId).toBe("agB");
    expect(e.agentType).toBe("Plan");
  });
  it("SubagentStop → subagent_stop; SessionStart/Stop/SessionEnd map through", () => {
    expect(normalizeClaudeHook({ ...common, hook_event_name: "SubagentStop", agent_id: "agB" }, baseTs)!.kind).toBe("subagent_stop");
    expect(normalizeClaudeHook({ ...common, hook_event_name: "SessionStart" }, baseTs)!.kind).toBe("session_start");
    expect(normalizeClaudeHook({ ...common, hook_event_name: "Stop" }, baseTs)!.kind).toBe("stop");
    expect(normalizeClaudeHook({ ...common, hook_event_name: "SessionEnd" }, baseTs)!.kind).toBe("session_end");
  });
  it("unknown / unmapped hook → null", () => {
    expect(normalizeClaudeHook({ ...common, hook_event_name: "PreCompact" }, baseTs)).toBeNull();
    expect(normalizeClaudeHook({ hook_event_name: "PostToolUse" }, baseTs)).toBeNull(); // missing session_id
  });
  it("a path outside cwd is still emitted (relay drops it) — relative with ..", () => {
    const e = normalizeClaudeHook({ ...common, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "/other/x.ts" } }, baseTs)!;
    expect(e.paths[0]!.startsWith("..")).toBe(true);
  });
});
