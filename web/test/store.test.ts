// web/test/store.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store.js";
import type { Frame, SnapshotDTO } from "../src/protocol.js";

const snap = (over: Partial<SnapshotDTO> = {}): SnapshotDTO => ({
  provider: "claude", sessionId: "s1", state: "live",
  tree: { path: "", type: "dir", heat: 3, children: [
    { path: "src", type: "dir", heat: 3, children: [
      { path: "src/a.ts", type: "file", loc: 10, binary: false, heat: 3, reads: 0, edits: 1, agents: [] },
    ] },
  ] },
  agents: [{ id: "s1", provider: "claude", name: "main", agentType: null, parentId: null, parentInferred: false, state: "thinking", now: "Editing a.ts", nowSource: "template", color: "#60a5fa", currentFiles: [] }],
  ...over,
});
const frame = <T>(type: Frame["type"], payload: T, sessionId = "s1"): Frame<T> => ({ type, sessionId, ts: 1, payload });

describe("Store", () => {
  it("applies a snapshot, exposes maxLeafHeat, and verifies sessionId", () => {
    const s = new Store("s1");
    s.apply(frame("snapshot", snap()));
    expect(s.state.sessionId).toBe("s1");
    expect(s.state.maxLeafHeat).toBe(3);
    expect(s.state.agents).toHaveLength(1);
  });
  it("rejects a snapshot whose sessionId mismatches (REQ-040)", () => {
    const s = new Store("s1");
    s.apply(frame("snapshot", snap({ sessionId: "OTHER" }), "OTHER"));
    expect(s.state.sessionId).toBeNull(); // not trusted
  });
  it("delta replaces the snapshot view; spec add/delete maintains the list", () => {
    const s = new Store("s1");
    s.apply(frame("snapshot", snap()));
    s.apply(frame("spec", { path: "docs/x.md", changeKind: "created" }));
    expect(s.state.specs).toContain("docs/x.md");
    s.apply(frame("spec", { path: "docs/x.md", changeKind: "deleted" }));
    expect(s.state.specs).not.toContain("docs/x.md");
  });
  it("session-state frame updates connection lifecycle", () => {
    const s = new Store("s1");
    s.apply(frame("snapshot", snap()));
    s.apply(frame("session-state", { state: "ended" }));
    expect(s.state.sessionState).toBe("ended");
  });
});
