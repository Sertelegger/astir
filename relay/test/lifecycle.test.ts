import { describe, it, expect, vi } from "vitest";
import { Lifecycle } from "../src/relay/lifecycle.js";

function lc(pidAlive: () => boolean, opts = {}) {
  const onShutdown = vi.fn();
  const l = new Lifecycle({ pidAlive, idleShutdownMs: 1000, endGraceMs: 500, onShutdown, ...opts });
  return { l, onShutdown };
}

describe("Lifecycle", () => {
  it("does NOT reap a confirmed-alive idle session (REQ-019c)", () => {
    const { l, onShutdown } = lc(() => true);
    l.note(0); l.evaluate(10_000); // long idle but pid alive
    expect(onShutdown).not.toHaveBeenCalled();
    expect(l.state).toBe("LIVE");
  });
  it("reaps when pid is dead (REQ-019b)", () => {
    const { l, onShutdown } = lc(() => false);
    l.note(0); l.evaluate(1);
    expect(onShutdown).toHaveBeenCalledOnce();
    expect(l.state).toBe("ENDED");
  });
  it("idle-reaps only when pid liveness is unconfirmable", () => {
    const { l, onShutdown } = lc(() => { throw new Error("unknown"); });
    l.note(0); l.evaluate(2000); // beyond idle window, pid unknown
    expect(onShutdown).toHaveBeenCalledOnce();
  });
  it("session_end → ENDED, then SHUTDOWN after grace; a SessionStart in grace revives", () => {
    const { l, onShutdown } = lc(() => true);
    l.note(0); l.onSessionEnd(0);
    expect(l.state).toBe("ENDED");
    l.onSessionStart(100); // within grace
    expect(l.state).toBe("LIVE");
    l.onSessionEnd(200); l.evaluate(800); // grace elapsed (800-200>500)
    expect(onShutdown).toHaveBeenCalledOnce();
    expect(l.state).toBe("SHUTDOWN");
  });
});
