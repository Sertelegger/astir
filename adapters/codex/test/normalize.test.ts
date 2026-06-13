import { describe, it, expect } from "vitest";
import { normalizeCodexHook } from "../src/normalize.js";

const common = { session_id: "s1", cwd: "/repo", transcript_path: "/r.jsonl" };

describe("normalizeCodexHook", () => {
  it("PostToolUse apply_patch → post_tool, edit, repo-relative paths, provider codex", () => {
    const e = normalizeCodexHook({ ...common, hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: { input: "*** Update File: /repo/src/a.ts\n" } }, 5)!;
    expect(e.kind).toBe("post_tool"); expect(e.op).toBe("edit");
    expect(e.paths).toEqual(["src/a.ts"]); expect(e.provider).toBe("codex"); expect(e.agentId).toBe("s1");
  });
  it("Stop → stop (NOT session_end); there is no session_end mapping for Codex", () => {
    expect(normalizeCodexHook({ ...common, hook_event_name: "Stop" }, 1)!.kind).toBe("stop");
    expect(normalizeCodexHook({ ...common, hook_event_name: "SessionEnd" }, 1)).toBeNull(); // Codex has none → unmapped
  });
  it("SessionStart/SubagentStart/SubagentStop/PreToolUse map through; subagent agentId", () => {
    expect(normalizeCodexHook({ ...common, hook_event_name: "SessionStart" }, 1)!.kind).toBe("session_start");
    const sub = normalizeCodexHook({ ...common, hook_event_name: "PreToolUse", tool_name: "shell", tool_input: { command: "ls" }, agent_id: "agA", agent_type: "worker" }, 1)!;
    expect(sub.kind).toBe("pre_tool"); expect(sub.agentId).toBe("agA"); expect(sub.op).toBe("other");
    expect(normalizeCodexHook({ ...common, hook_event_name: "SubagentStart", agent_id: "agA", agent_type: "worker" }, 1)!.kind).toBe("subagent_start");
    expect(normalizeCodexHook({ ...common, hook_event_name: "SubagentStop", agent_id: "agA" }, 1)!.kind).toBe("subagent_stop");
  });
  it("unmapped (PreCompact) / missing session_id → null", () => {
    expect(normalizeCodexHook({ ...common, hook_event_name: "PreCompact" }, 1)).toBeNull();
    expect(normalizeCodexHook({ hook_event_name: "Stop" }, 1)).toBeNull();
  });
});
