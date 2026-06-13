import { describe, it, expect } from "vitest";
import { SessionState } from "../src/model/session-state.js";
import { systemClock } from "../src/model/clock.js";

function ss(root = process.cwd()) {
  return new SessionState({ sessionId: "s1", provider: "claude", cwd: root, clock: systemClock, halfLifeSeconds: 30 });
}
const ev = (o: Record<string, unknown>) => ({ v: 1, provider: "claude", sessionId: "s1", ...o });

describe("SessionState", () => {
  it("dedupes by eventId (heat counted once)", () => {
    const s = ss();
    const e = ev({ eventId: "x", ts: 1, kind: "post_tool", agentId: "s1", tool: "Edit", paths: ["src/a.ts"], op: "edit", ok: true });
    s.apply(e); s.apply(e); // duplicate
    expect(s.tree.getLeaf("src/a.ts")!.heat.value()).toBeCloseTo(3, 4); // one edit, not two
  });
  it("does not derive heat from reasoning (REQ-017) — only events", () => {
    const s = ss();
    s.applyReasoning("s1", 1, "Refactoring the auth flow now");
    expect(s.tree.maxLeafHeat()).toBe(0);
    expect(s.agents.get("s1")).toBeUndefined(); // reasoning for unknown agent creates no record (REQ-012a)
  });
  it("computes a Now line from reasoning when it passes the gate, else template", () => {
    const s = ss();
    s.apply(ev({ eventId: "1", ts: 1, kind: "session_start", agentId: "s1", paths: [], op: null }));
    s.applyReasoning("s1", 2, "Refactoring the login error handling");
    s.refreshNow("s1");
    expect(s.agents.get("s1")!.now).toBe("Refactoring the login error handling");
    expect(s.agents.get("s1")!.nowSource).toBe("reasoning");
    s.apply(ev({ eventId: "2", ts: 3, kind: "post_tool", agentId: "s1", tool: "Edit", paths: ["src/x.ts"], op: "edit", ok: true }));
    s.applyReasoning("s1", 4, "."); // fails gate
    s.refreshNow("s1");
    expect(s.agents.get("s1")!.nowSource).toBe("template");
    expect(s.agents.get("s1")!.now).toBe("Editing x.ts");
  });
  it("snapshot rolls dir heat up from leaves and tags provider", () => {
    const s = ss();
    s.apply(ev({ eventId: "1", ts: 1, kind: "post_tool", agentId: "s1", tool: "Edit", paths: ["src/a.ts"], op: "edit", ok: true }));
    const snap = s.snapshot();
    expect(snap.provider).toBe("claude");
    const srcDir = snap.tree.children.find((c) => c.path === "src")!;
    expect(srcDir.heat).toBeGreaterThan(0);
  });
});
