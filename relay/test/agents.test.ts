import { describe, it, expect } from "vitest";
import { AgentModel, type AgentModelOpts } from "../src/model/agents.js";

function model(opts?: AgentModelOpts) { return new AgentModel("s1", "claude", opts); }

describe("AgentModel", () => {
  it("creates the main agent with id == sessionId, parentId null, thinking", () => {
    const m = model();
    m.onSessionStart(1);
    const main = m.get("s1")!;
    expect(main.parentId).toBeNull();
    expect(main.state).toBe("thinking");
    expect(main.color).toBeTruthy();
  });
  it("pre_tool → tool-running, post_tool → thinking", () => {
    const m = model(); m.onSessionStart(1);
    m.onPreTool("s1", "Edit", 2); expect(m.get("s1")!.state).toBe("tool-running");
    m.onPostTool("s1", ["src/a.ts"], 3); expect(m.get("s1")!.state).toBe("thinking");
    expect(m.get("s1")!.currentFiles).toContain("src/a.ts");
  });
  it("lastTouchOf reports the newest touch ts per agent+path, undefined when untouched", () => {
    const m = model(); m.onSessionStart(1);
    expect(m.lastTouchOf("s1", "src/a.ts")).toBeUndefined();
    m.onPostTool("s1", ["src/a.ts"], 2);
    expect(m.lastTouchOf("s1", "src/a.ts")).toBe(2);
    m.onPostTool("s1", ["src/a.ts"], 5);
    expect(m.lastTouchOf("s1", "src/a.ts")).toBe(5); // updated, not appended
    expect(m.lastTouchOf("s1", "src/b.ts")).toBeUndefined();
    expect(m.lastTouchOf("ghost", "src/a.ts")).toBeUndefined();
  });
  it("Stop on main → waiting", () => {
    const m = model(); m.onSessionStart(1);
    m.onStop("s1", 4); expect(m.get("s1")!.state).toBe("waiting");
  });
  it("subagent start nests under main; subagent_stop ok → done, fail → error", () => {
    const m = model(); m.onSessionStart(1);
    m.onSubagentStart("agA", "Explore", "s1", false, 2);
    expect(m.get("agA")!.parentId).toBe("s1");
    expect(m.get("agA")!.state).toBe("thinking");
    m.onSubagentStop("agA", true, 3); expect(m.get("agA")!.state).toBe("done");
    m.onSubagentStart("agB", "Plan", "s1", false, 4);
    m.onSubagentStop("agB", false, 5); expect(m.get("agB")!.state).toBe("error");
  });
  it("a stale event does not revive a terminal agent (REQ-030)", () => {
    const m = model(); m.onSessionStart(1);
    m.onSubagentStart("agA", "Explore", "s1", false, 2);
    m.onSubagentStop("agA", true, 5);
    m.onPreTool("agA", "Read", 3); // stale (ts < stop)
    expect(m.get("agA")!.state).toBe("done");
  });
  it("idle after idleSeconds of no events; revives on next event", () => {
    const m = model({ idleSeconds: 10 }); m.onSessionStart(1);
    m.tick(100);                       // far future wall clock
    expect(m.get("s1")!.state).toBe("idle");
    m.onPreTool("s1", "Bash", 101); expect(m.get("s1")!.state).toBe("tool-running");
  });
  it("prunes terminal subagents after retention; never the main agent", () => {
    const m = model({ terminalRetentionSeconds: 60 }); m.onSessionStart(1);
    m.onSubagentStart("agA", "Explore", "s1", false, 2);
    m.onSubagentStop("agA", true, 3);
    m.tick(100);
    expect(m.get("agA")).toBeUndefined();
    expect(m.get("s1")).toBeDefined();
  });
  it("Stop on a non-main agent is ignored (no waiting, no idle-timer reset)", () => {
    const m = model({ idleSeconds: 10 }); m.onSessionStart(1);
    m.onSubagentStart("agA", "Explore", "s1", false, 2);
    m.onPreTool("agA", "Read", 3);          // agA is tool-running, lastEventTs=3
    m.onStop("agA", 50);                     // must be ignored for a subagent
    expect(m.get("agA")!.state).toBe("tool-running");
    m.tick(14);                              // 14 - 3 = 11 >= 10 → agA should be idle (timer NOT reset to 50)
    expect(m.get("agA")!.state).toBe("idle");
  });
  it("a stale pre_tool arriving after its post_tool does not regress state (REQ-016)", () => {
    const m = model(); m.onSessionStart(1);
    m.onPostTool("s1", ["src/a.ts"], 3);   // → thinking, lastEventTs=3
    m.onPreTool("s1", "Edit", 2);          // stale (ts=2 < 3): must NOT regress to tool-running
    expect(m.get("s1")!.state).toBe("thinking");
  });
  it("assigns stable distinct colors to subagents", () => {
    const m = model(); m.onSessionStart(1);
    m.onSubagentStart("a", "X", "s1", false, 2);
    m.onSubagentStart("b", "Y", "s1", false, 3);
    expect(m.get("a")!.color).not.toBe(m.get("b")!.color);
    const first = m.get("a")!.color;
    m.onPreTool("a", "Read", 4);
    expect(m.get("a")!.color).toBe(first); // stable
  });
});
