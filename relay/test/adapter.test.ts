import { describe, it, expect } from "vitest";
import type { CaptureAdapter } from "../src/contract/adapter.js";
import { validateEvent } from "../src/contract/event.js";

// An example adapter that does nothing but emit a contract-valid event proves the
// interface is sufficient without any relay/renderer change (REQ-007 / TST-CAP-07).
class ExampleAdapter implements CaptureAdapter {
  readonly provider = "claude" as const;
  installHooks(): void {}
  uninstallHooks(): void {}
  normalize(): ReturnType<CaptureAdapter["normalize"]> {
    return { v: 1, eventId: "e", provider: "claude", sessionId: "s1", ts: 1, kind: "stop", agentId: "s1", paths: [], op: null };
  }
}

describe("CaptureAdapter interface", () => {
  it("an example adapter emits a contract-valid event", () => {
    const a = new ExampleAdapter();
    expect(validateEvent(a.normalize({}, "s1")).ok).toBe(true);
    expect(a.provider).toBe("claude");
  });
});
