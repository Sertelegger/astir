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

  it("snapshot stamps pulse only on the given touched paths (REQ-024)", () => {
    const s = ss();
    s.apply(ev({ eventId: "1", ts: 1, kind: "post_tool", agentId: "s1", tool: "Edit", paths: ["src/a.ts"], op: "edit", ok: true }));
    const find = (n: any, path: string): any => n.type === "file" ? (n.path === path ? n : undefined) : (n.children ?? []).map((c: any) => find(c, path)).find(Boolean);
    const withPulse = s.snapshot(new Set(["src/a.ts"]));
    expect(find(withPulse.tree, "src/a.ts").pulse).toBe(true);
    const noPulse = s.snapshot();
    expect(find(noPulse.tree, "src/a.ts").pulse).toBeUndefined();
  });

  it("invokes the summarizer when reasoning fails the gate, upgrading Now to model (REQ-033b)", async () => {
    const updated: string[] = [];
    const fakeSummarizer = { summarize: async () => "Refactoring the auth module" };
    const s = new SessionState({ sessionId: "s1", provider: "claude", cwd: process.cwd(), clock: systemClock, summarizer: fakeSummarizer, onNowUpdate: (id: string) => updated.push(id) });
    s.apply(ev({ eventId: "1", ts: 1, kind: "session_start", agentId: "s1", paths: [], op: null }));
    s.apply(ev({ eventId: "2", ts: 2, kind: "post_tool", agentId: "s1", tool: "Bash", paths: [], op: "other", ok: true })); // no reasoning → template, summarizer fires
    await new Promise((r) => setTimeout(r, 0));
    expect(s.agents.get("s1")!.now).toBe("Refactoring the auth module");
    expect(s.agents.get("s1")!.nowSource).toBe("model");
    expect(updated).toContain("s1");
  });
  it("does NOT invoke the summarizer when reasoning passes the gate", async () => {
    let called = 0;
    const fakeSummarizer = { summarize: async () => { called += 1; return "x"; } };
    const s = new SessionState({ sessionId: "s1", provider: "claude", cwd: process.cwd(), clock: systemClock, summarizer: fakeSummarizer });
    s.apply(ev({ eventId: "1", ts: 1, kind: "session_start", agentId: "s1", paths: [], op: null }));
    s.applyReasoning("s1", 2, "Refactoring the login flow");
    s.refreshNow("s1");
    await new Promise((r) => setTimeout(r, 0));
    expect(called).toBe(0);
    expect(s.agents.get("s1")!.nowSource).toBe("reasoning");
  });

  it("emits a spec change (created) when a spec-glob path is written (REQ-070)", () => {
    const specs: Array<{ path: string; changeKind: string }> = [];
    const s = new SessionState({ sessionId: "s1", provider: "claude", cwd: process.cwd(), clock: systemClock, specGlobs: ["docs/**/*.md"], onSpec: (path, changeKind) => specs.push({ path, changeKind }) });
    s.apply(ev({ eventId: "1", ts: 1, kind: "post_tool", agentId: "s1", tool: "Write", paths: ["docs/new.md"], op: "write", ok: true }));
    expect(specs).toEqual([{ path: "docs/new.md", changeKind: "created" }]);
    s.apply(ev({ eventId: "2", ts: 2, kind: "post_tool", agentId: "s1", tool: "Edit", paths: ["docs/new.md"], op: "edit", ok: true }));
    expect(specs.at(-1)).toEqual({ path: "docs/new.md", changeKind: "updated" });
    expect(s.snapshot().specs).toContain("docs/new.md"); // included in snapshot for late connect
  });
  it("does not emit specs for non-matching paths", () => {
    const specs: unknown[] = [];
    const s = new SessionState({ sessionId: "s1", provider: "claude", cwd: process.cwd(), clock: systemClock, specGlobs: ["docs/**/*.md"], onSpec: () => specs.push(1) });
    s.apply(ev({ eventId: "1", ts: 1, kind: "post_tool", agentId: "s1", tool: "Edit", paths: ["src/a.ts"], op: "edit", ok: true }));
    expect(specs).toHaveLength(0);
  });
});
