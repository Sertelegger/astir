import { describe, it, expect } from "vitest";
import { validateEvent } from "../src/contract/event.js";

const base = {
  v: 1, eventId: "e1", provider: "claude", sessionId: "s1", ts: 1781200000.1,
  kind: "post_tool", agentId: "s1", tool: "Edit", paths: ["src/a.ts"], op: "edit", ok: true,
};

describe("validateEvent", () => {
  it("accepts a well-formed post_tool event", () => {
    const r = validateEvent(base);
    expect(r.ok).toBe(true);
  });
  it("rejects an unknown kind", () => {
    const r = validateEvent({ ...base, kind: "frobnicate" });
    expect(r.ok).toBe(false);
  });
  it("rejects a missing eventId", () => {
    const { eventId, ...noId } = base;
    expect(validateEvent(noId).ok).toBe(false);
  });
  it("rejects an unknown major contract version", () => {
    expect(validateEvent({ ...base, v: 99 }).ok).toBe(false);
  });
  it("defaults paths to [] and op to null when absent", () => {
    const { paths, op, ...bare } = base;
    const r = validateEvent({ ...bare, kind: "stop" });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.event.paths).toEqual([]); expect(r.event.op).toBeNull(); }
  });
});
