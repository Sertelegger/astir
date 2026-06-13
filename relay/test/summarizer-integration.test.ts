import { describe, it, expect } from "vitest";
import { SessionState } from "../src/model/session-state.js";
import { AutoSummarizer } from "../src/relay/auto-summarizer.js";
import { systemClock } from "../src/model/clock.js";

const ev = (o: Record<string, unknown>) => ({ v: 1, provider: "claude", sessionId: "s1", ...o });

describe("summarizer integration (injected model fn → Now upgrade)", () => {
  it("end-to-end: a tool action with no reasoning yields a model Now via AutoSummarizer", async () => {
    const summarizer = new AutoSummarizer(async (fields) => `Working on ${fields[0]?.basenames[0] ?? "the repo"}`.slice(0, 80), { minIntervalSeconds: 0 });
    const s = new SessionState({ sessionId: "s1", provider: "claude", cwd: process.cwd(), clock: systemClock, summarizer });
    s.apply(ev({ eventId: "1", ts: 1, kind: "session_start", agentId: "s1", paths: [], op: null }));
    s.apply(ev({ eventId: "2", ts: 2, kind: "post_tool", agentId: "s1", tool: "Edit", paths: ["src/auth.ts"], op: "edit", ok: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(s.agents.get("s1")!.nowSource).toBe("model");
    expect(s.agents.get("s1")!.now).toBe("Working on auth.ts");
  });
});
