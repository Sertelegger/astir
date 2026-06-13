import { describe, it, expect } from "vitest";
import { Aggregator } from "../src/aggregator.js";
import type { AggDiscovery } from "../src/discovery.js";
import type { Frame } from "../src/protocol.js";

describe("aggregate integration", () => {
  it("two live sessions of different providers union into the view", () => {
    const subs = new Map<string, (f: Frame) => void>();
    const discos: AggDiscovery[] = [
      { sessionId: "claudeS", provider: "claude", cwd: "/a", port: 1, token: "t" },
      { sessionId: "codexS", provider: "codex", cwd: "/b", port: 2, token: "t" },
    ];
    const agg = new Aggregator({ scan: () => discos, subscribe: (d, onFrame) => { subs.set(d.sessionId, onFrame); return () => {}; } });
    agg.refresh();
    for (const d of discos) subs.get(d.sessionId)!({ type: "snapshot", sessionId: d.sessionId, ts: 1, payload: { provider: d.provider, sessionId: d.sessionId, state: "live", tree: { path: "", type: "dir", heat: 0, children: [] }, agents: [], specs: [] } as any });
    const s = agg.sessions();
    expect(s).toHaveLength(2);
    expect(s.every((e) => e.status === "live")).toBe(true);
    expect(s.map((e) => e.provider).sort()).toEqual(["claude", "codex"]);
  });
});
