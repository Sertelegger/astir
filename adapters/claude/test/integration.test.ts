import { describe, it, expect } from "vitest";
import { runHook } from "../src/hook-entry.js";

describe("PA-claude integration (fixture payloads → fake relay)", () => {
  it("a session's hook sequence normalizes to the right event stream", async () => {
    const posted: any[] = [];
    const d = {
      now: () => 1781200000,
      resolve: () => ({ port: 1, token: "t" }),
      postEvent: async (_r: any, e: any) => { posted.push(e); },
      ensureRelay: async () => {},
    };
    const seq = [
      { session_id: "s1", cwd: "/repo", hook_event_name: "SessionStart" },
      { session_id: "s1", cwd: "/repo", hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/repo/src/a.ts" } },
      { session_id: "s1", cwd: "/repo", hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "/repo/src/a.ts" }, tool_output: "ok" },
      { session_id: "s1", cwd: "/repo", hook_event_name: "SubagentStart", agent_id: "agA", agent_type: "Explore" },
      { session_id: "s1", cwd: "/repo", hook_event_name: "SubagentStop", agent_id: "agA" },
      { session_id: "s1", cwd: "/repo", hook_event_name: "SessionEnd" },
    ];
    for (const p of seq) expect(await runHook(JSON.stringify(p), d as any)).toBe(0);
    expect(posted.map((e) => e.kind)).toEqual(["session_start", "pre_tool", "post_tool", "subagent_start", "subagent_stop", "session_end"]);
    expect(posted[2].paths).toEqual(["src/a.ts"]);
    expect(posted[3].agentId).toBe("agA");
    expect(posted.every((e) => e.provider === "claude" && e.eventId)).toBe(true);
  });
});
