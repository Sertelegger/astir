import { describe, it, expect, afterEach } from "vitest";
import { SessionState } from "../src/model/session-state.js";
import { systemClock } from "../src/model/clock.js";
import { Counters } from "../src/log/logger.js";
import { RelayServer } from "../src/relay/server.js";
import { Driver } from "./synthetic-driver.js";

let server: RelayServer | undefined;
afterEach(async () => { if (server) await server.close(); server = undefined; });

describe("end-to-end via synthetic driver", () => {
  it("replays events + reasoning and the hottest file is the one most recently edited", async () => {
    const state = new SessionState({ sessionId: "s1", provider: "claude", cwd: process.cwd(), clock: systemClock });
    server = new RelayServer({ state, token: "tok", counters: new Counters(), flushMs: 10 });
    const port = await server.listen();
    const d = new Driver(`http://127.0.0.1:${port}`, "tok", "s1");

    await d.event({ kind: "session_start", agentId: "s1" });
    await d.event({ kind: "post_tool", agentId: "s1", tool: "Read", paths: ["src/cold.ts"], op: "read", ok: true });
    await d.event({ kind: "post_tool", agentId: "s1", tool: "Edit", paths: ["src/hot.ts"], op: "edit", ok: true });
    await d.event({ kind: "post_tool", agentId: "s1", tool: "Edit", paths: ["src/hot.ts"], op: "edit", ok: true });
    await d.reasoning("s1", "Refactoring the hot module");

    const snap = await d.state();
    const leaves: any[] = [];
    const walk = (n: any) => { if (n.type === "file") leaves.push(n); else n.children.forEach(walk); };
    walk(snap.tree);
    const hottest = leaves.sort((a, b) => b.heat - a.heat)[0];
    expect(hottest.path).toBe("src/hot.ts");
    expect(snap.agents.find((a: any) => a.id === "s1").now).toBe("Refactoring the hot module");
  });

  it("a duplicate eventId does not double-count heat (REQ-016)", async () => {
    const state = new SessionState({ sessionId: "s1", provider: "claude", cwd: process.cwd(), clock: systemClock });
    server = new RelayServer({ state, token: "tok", counters: new Counters(), flushMs: 10 });
    const port = await server.listen();
    const d = new Driver(`http://127.0.0.1:${port}`, "tok", "s1");
    const dup = { eventId: "dup", kind: "post_tool" as const, agentId: "s1", tool: "Edit", paths: ["src/x.ts"], op: "edit" as const, ok: true };
    await d.eventRaw({ v: 1, provider: "claude", sessionId: "s1", ts: 1, paths: [], ...dup });
    await d.eventRaw({ v: 1, provider: "claude", sessionId: "s1", ts: 1, paths: [], ...dup });
    const snap = await d.state();
    const leaf = (function find(n: any): any { if (n.type === "file" && n.path === "src/x.ts") return n; return (n.children ?? []).map(find).find(Boolean); })(snap.tree);
    expect(leaf.heat).toBeCloseTo(3, 4); // single edit
  });
});
