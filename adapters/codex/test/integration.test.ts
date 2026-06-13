import { describe, it, expect } from "vitest";
import { runHook } from "../src/hook-entry.js";

/** Build a fake deps that collects posted events and never fails. */
function makeDeps() {
  const posted: any[] = [];
  return {
    posted,
    deps: {
      now: () => 1781200000,
      resolve: () => ({ port: 51000, token: "tok" }),
      postEvent: async (_r: any, e: any) => { posted.push(e); },
      ensureRelay: async () => {},
    },
  };
}

const base = { session_id: "sess1", cwd: "/repo", transcript_path: "/r.jsonl" };

describe("Codex adapter integration: hook sequence → events", () => {
  it("processes a full session sequence → kinds, provider codex, no session_end", async () => {
    const { posted, deps } = makeDeps();

    const payloads = [
      { ...base, hook_event_name: "SessionStart" },
      { ...base, hook_event_name: "PreToolUse", tool_name: "shell", tool_input: { command: "ls" } },
      { ...base, hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: { input: "*** Update File: /repo/x.ts\n" } },
      { ...base, hook_event_name: "SubagentStart", agent_id: "agA", agent_type: "worker" },
      { ...base, hook_event_name: "SubagentStop", agent_id: "agA" },
      { ...base, hook_event_name: "Stop" },
    ];

    for (const p of payloads) {
      await runHook(JSON.stringify(p), deps as any);
    }

    const kinds = posted.map((e: any) => e.kind);
    expect(kinds).toEqual(["session_start", "pre_tool", "post_tool", "subagent_start", "subagent_stop", "stop"]);

    // All events have provider: codex
    for (const e of posted) {
      expect(e.provider).toBe("codex");
    }

    // apply_patch PostToolUse event has paths: ["x.ts"] (repo-relative)
    const applyPatchEvent = posted.find((e: any) => e.kind === "post_tool");
    expect(applyPatchEvent.paths).toEqual(["x.ts"]);

    // No session_end events
    expect(posted.some((e: any) => e.kind === "session_end")).toBe(false);
  });
});
