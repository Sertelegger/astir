import { describe, it, expect } from "vitest";
import { parseSseChunk } from "../src/sse.js";
import { reduce, emptyState } from "../src/store.js";
import type { Frame, SnapshotDTO } from "../src/protocol.js";

const snap: SnapshotDTO = { provider: "claude", sessionId: "s1", state: "live",
  tree: { path: "", type: "dir", heat: 3, children: [{ path: "src/a.ts", type: "file", loc: 5, binary: false, heat: 3, reads: 0, edits: 1, agents: [] }] },
  agents: [] };

describe("tui sse + store", () => {
  it("parseSseChunk extracts data frames and buffers partials", () => {
    const out: Frame[] = [];
    let buf = parseSseChunk("", 'data: {"type":"snapshot","sessionId":"s1","ts":1,"payload":{}}\n\ndata: {"ty', (f) => out.push(f));
    expect(out).toHaveLength(1);
    buf = parseSseChunk(buf, 'pe":"delta","sessionId":"s1","ts":2,"payload":{}}\n\n', (f) => out.push(f));
    expect(out.map((f) => f.type)).toEqual(["snapshot", "delta"]);
  });
  it("reduce applies snapshot, computes maxLeafHeat", () => {
    const f: Frame<SnapshotDTO> = { type: "snapshot", sessionId: "s1", ts: 1, payload: snap };
    const s = reduce(emptyState(), f);
    expect(s.tree?.path).toBe("");
    expect(s.maxLeafHeat).toBe(3);
    expect(s.sessionState).toBe("live");
  });
});
