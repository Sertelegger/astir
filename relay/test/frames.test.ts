import { describe, it, expect } from "vitest";
import { makeFrame, FRAME_TYPES } from "../src/contract/frames.js";

describe("frames", () => {
  it("exposes exactly the 4 frame types (pulse is NOT a type)", () => {
    expect([...FRAME_TYPES].sort()).toEqual(["delta", "session-state", "snapshot", "spec"]);
  });
  it("stamps sessionId and ts on every frame", () => {
    const f = makeFrame("session-state", "s1", 1.5, { state: "live" });
    expect(f).toEqual({ type: "session-state", sessionId: "s1", ts: 1.5, payload: { state: "live" } });
  });
});
