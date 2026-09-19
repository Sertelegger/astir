/**
 * CAP-05 parentage, where the pipeline decides what it knows.
 *
 * `resolveParent` produces the answer and the registry decides whether to keep
 * it. That second half had a rule borrowed from fields where it did not belong.
 */

import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION } from "../src/contract/event.js";
import { Registry } from "../src/model/registry.js";

describe("a guess may be replaced by a fact, never the reverse", () => {
  /**
   * `parentSource` was only ever filled when null — the rule `agentType` and
   * `description` use, where every answer is equally good. These answers are
   * not: a sidecar read is exact, and `inferred` means astir could not find
   * one. The provider writes the sidecar around the time the first event
   * fires, so an agent whose event won that race was pinned to `inferred`
   * forever, and the sidecar appearing a moment later could never correct it.
   * That made the deterministic route a coin flip per agent.
   */
  const ev = (over: Record<string, unknown>) => ({
    v: CONTRACT_VERSION,
    eventId: `e${Math.floor(Number(over.ts ?? 1))}`,
    provider: "claude" as const,
    sessionId: "s1",
    ts: 1_787_000_000,
    kind: "subagent_start" as const,
    agentId: "a1",
    agentType: null,
    parentAgentId: null,
    parentSource: null,
    tool: null,
    description: null,
    paths: [],
    op: null,
    ok: null,
    notificationKind: null,
    ...over,
  });

  it("upgrades an inferred parent when the sidecar turns up", () => {
    const r = new Registry({ nowMs: () => 1_000 });
    r.apply(ev({ parentSource: "inferred", parentAgentId: null }), "/repo");
    r.apply(ev({ eventId: "e2", parentSource: "sidecar", parentAgentId: "root" }), "/repo");

    const agent = r.list()[0]?.agents.get("a1");
    expect(agent?.parentSource).toBe("sidecar");
    expect(agent?.parentId).toBe("root");
  });

  it("does NOT downgrade a sidecar answer to a later guess", () => {
    // The other direction, which order alone would get wrong: a read answer
    // must not be replaced by "I could not find one".
    const r = new Registry({ nowMs: () => 1_000 });
    r.apply(ev({ parentSource: "sidecar", parentAgentId: "root" }), "/repo");
    r.apply(ev({ eventId: "e2", parentSource: "inferred", parentAgentId: null }), "/repo");

    const agent = r.list()[0]?.agents.get("a1");
    expect(agent?.parentSource).toBe("sidecar");
    expect(agent?.parentId).toBe("root");
  });

  it("still fills an unknown parent from the first answer of any kind", () => {
    const r = new Registry({ nowMs: () => 1_000 });
    r.apply(ev({ parentSource: null }), "/repo");
    r.apply(ev({ eventId: "e2", parentSource: "inferred", parentAgentId: null }), "/repo");
    expect(r.list()[0]?.agents.get("a1")?.parentSource).toBe("inferred");
  });
});
