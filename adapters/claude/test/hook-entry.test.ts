import { describe, it, expect } from "vitest";
import { runHook } from "../src/hook-entry.js";

const deps = (over: Partial<Parameters<typeof runHook>[1]> = {}) => {
  const posted: any[] = [];
  return {
    posted,
    deps: {
      now: () => 1781200000,
      resolve: () => ({ port: 51000, token: "tok" }),
      postEvent: async (_r: any, e: any) => { posted.push(e); },
      ensureRelay: async () => {},
      ...over,
    },
  };
};

describe("runHook", () => {
  it("normalizes + posts a PostToolUse event", async () => {
    const { posted, deps: d } = deps();
    const code = await runHook(JSON.stringify({ session_id: "s1", cwd: "/repo", hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" }, tool_output: "ok" }), d as any);
    expect(code).toBe(0);
    expect(posted).toHaveLength(1);
    expect(posted[0].kind).toBe("post_tool");
  });
  it("SessionStart ensures the relay/tailer then posts", async () => {
    let ensured = 0;
    const { posted, deps: d } = deps({ ensureRelay: async () => { ensured++; } });
    const code = await runHook(JSON.stringify({ session_id: "s1", cwd: "/repo", hook_event_name: "SessionStart" }), d as any);
    expect(code).toBe(0); expect(ensured).toBe(1); expect(posted[0].kind).toBe("session_start");
  });
  it("never throws / always exits 0: no live relay → drop, exit 0", async () => {
    const { posted, deps: d } = deps({ resolve: () => null });
    const code = await runHook(JSON.stringify({ session_id: "s1", cwd: "/repo", hook_event_name: "Stop" }), d as any);
    expect(code).toBe(0); expect(posted).toHaveLength(0);
  });
  it("POST failure is swallowed → exit 0 (REQ-004)", async () => {
    const { deps: d } = deps({ postEvent: async () => { throw new Error("relay down"); } });
    const code = await runHook(JSON.stringify({ session_id: "s1", cwd: "/repo", hook_event_name: "Stop" }), d as any);
    expect(code).toBe(0);
  });
  it("unmapped hook → exit 0, no post", async () => {
    const { posted, deps: d } = deps();
    const code = await runHook(JSON.stringify({ session_id: "s1", cwd: "/repo", hook_event_name: "PreCompact" }), d as any);
    expect(code).toBe(0); expect(posted).toHaveLength(0);
  });
});
