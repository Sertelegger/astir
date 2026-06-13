import { describe, it, expect } from "vitest";
import { Aggregator } from "../src/aggregator.js";
import type { AggDiscovery } from "../src/discovery.js";
import type { Frame, SnapshotDTO } from "../src/protocol.js";

const d = (id: string): AggDiscovery => ({ sessionId: id, provider: "claude", cwd: `/${id}`, port: 1, token: "t" });
const snap = (id: string, state: SnapshotDTO["state"] = "live"): Frame<SnapshotDTO> => ({ type: "snapshot", sessionId: id, ts: 1, payload: { provider: "claude", sessionId: id, state, tree: { path: "", type: "dir", heat: 0, children: [] }, agents: [], specs: [] } as any });

// A controllable fake subscribe: records the callbacks so the test can push frames/status.
function harness() {
  const subs = new Map<string, { onFrame: (f: Frame) => void; onStatus: (s: string) => void; unsubbed: boolean }>();
  let discos: AggDiscovery[] = [];
  const agg = new Aggregator({
    scan: () => discos,
    subscribe: (disc, onFrame, onStatus) => { const rec = { onFrame, onStatus, unsubbed: false }; subs.set(disc.sessionId, rec); return () => { rec.unsubbed = true; }; },
  });
  return { agg, subs, setDiscos: (xs: AggDiscovery[]) => { discos = xs; } };
}

describe("Aggregator", () => {
  it("adds a session on refresh; a snapshot makes it live", () => {
    const h = harness();
    h.setDiscos([d("a")]); h.agg.refresh();
    expect(h.agg.sessions().map((s) => s.sessionId)).toEqual(["a"]);
    expect(h.agg.sessions()[0]!.status).toBe("connecting");
    h.subs.get("a")!.onFrame(snap("a"));
    expect(h.agg.sessions()[0]!.status).toBe("live");
    expect(h.agg.sessions()[0]!.snapshot?.sessionId).toBe("a");
  });
  it("removes a session (and unsubscribes) when it disappears (churn, REQ-082)", () => {
    const h = harness();
    h.setDiscos([d("a")]); h.agg.refresh();
    const rec = h.subs.get("a")!;
    h.setDiscos([]); h.agg.refresh();
    expect(h.agg.sessions()).toHaveLength(0);
    expect(rec.unsubbed).toBe(true);
  });
  it("adds a new session on a later refresh without disturbing existing", () => {
    const h = harness();
    h.setDiscos([d("a")]); h.agg.refresh(); h.subs.get("a")!.onFrame(snap("a"));
    h.setDiscos([d("a"), d("b")]); h.agg.refresh();
    expect(h.agg.sessions().map((s) => s.sessionId).sort()).toEqual(["a", "b"]);
    expect(h.agg.sessions().find((s) => s.sessionId === "a")!.status).toBe("live"); // unchanged
  });
  it("rejects a stream whose snapshot sessionId mismatches (REQ-082)", () => {
    const h = harness();
    h.setDiscos([d("a")]); h.agg.refresh();
    h.subs.get("a")!.onFrame(snap("OTHER")); // wrong id
    expect(h.agg.sessions()[0]!.status).toBe("connecting"); // not trusted
    expect(h.agg.sessions()[0]!.snapshot).toBeNull();
  });
  it("marks unreachable when the subscriber reports it; ended on ended state", () => {
    const h = harness();
    h.setDiscos([d("a"), d("b")]); h.agg.refresh();
    h.subs.get("a")!.onStatus("unreachable");
    h.subs.get("b")!.onFrame(snap("b", "ended"));
    expect(h.agg.sessions().find((s) => s.sessionId === "a")!.status).toBe("unreachable");
    expect(h.agg.sessions().find((s) => s.sessionId === "b")!.status).toBe("ended");
  });
});
