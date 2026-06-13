import { describe, it, expect } from "vitest";
import { AutoSummarizer, type ModelFn } from "../src/relay/auto-summarizer.js";
import type { SummarizerEvent } from "../src/relay/summarizer.js";

const evs: SummarizerEvent[] = [{ kind: "post_tool", tool: "Edit", op: "edit", paths: ["src/auth/login.ts"] }];

describe("AutoSummarizer", () => {
  it("returns a gate-passing phrase and truncates to <=80", async () => {
    const s = new AutoSummarizer(async () => "Refactoring the login error handling", { minIntervalSeconds: 0 });
    expect(await s.summarize("a", evs)).toBe("Refactoring the login error handling");
  });
  it("rejects model output that fails the Now gate (returns null → caller falls back)", async () => {
    const s = new AutoSummarizer(async () => "Edit(src/a.ts)", { minIntervalSeconds: 0 });
    expect(await s.summarize("a", evs)).toBeNull();
  });
  it("egresses ONLY kind/tool/op/basename to the model fn (REQ-036)", async () => {
    let seen: any;
    const fn: ModelFn = async (fields) => { seen = fields; return "Editing login"; };
    const s = new AutoSummarizer(fn, { minIntervalSeconds: 0 });
    await s.summarize("a", evs);
    expect(seen).toEqual([{ kind: "post_tool", tool: "Edit", op: "edit", basenames: ["login.ts"] }]);
    expect(JSON.stringify(seen)).not.toContain("src/auth");
  });
  it("at most one in-flight call per agent", async () => {
    let calls = 0;
    const fn: ModelFn = async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return "Editing the file"; };
    const s = new AutoSummarizer(fn, { minIntervalSeconds: 0 });
    const [r1, r2] = await Promise.all([s.summarize("a", evs), s.summarize("a", evs)]);
    expect(calls).toBe(1);
    expect(r1).toBe("Editing the file");
    expect(r2).toBeNull();
  });
  it("debounces by minInterval (per agent)", async () => {
    let t = 0; let calls = 0;
    const s = new AutoSummarizer(async () => { calls++; return "Editing the file"; }, { minIntervalSeconds: 10, now: () => t });
    await s.summarize("a", evs); // t=0 → calls
    t = 5; await s.summarize("a", evs); // suppressed
    expect(calls).toBe(1);
    t = 11; await s.summarize("a", evs); // allowed
    expect(calls).toBe(2);
  });
  it("trips a circuit-breaker after repeated failures, then cools down", async () => {
    let t = 0; let calls = 0;
    const s = new AutoSummarizer(async () => { calls++; throw new Error("429"); }, { minIntervalSeconds: 0, failureThreshold: 2, cooldownSeconds: 30, now: () => t });
    expect(await s.summarize("a", evs)).toBeNull(); // fail 1
    expect(await s.summarize("a", evs)).toBeNull(); // fail 2 → breaker opens
    const before = calls;
    expect(await s.summarize("a", evs)).toBeNull(); // breaker open → no call
    expect(calls).toBe(before);
    t = 31; await s.summarize("a", evs); // cooled down → calls again
    expect(calls).toBe(before + 1);
  });
});
