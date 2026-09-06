/**
 * A second provider must not delete the first one's sessions.
 *
 * `reconcile` is called per provider, and everything it does with the answer —
 * pruning, replacing the silent list, deciding a record is reapable — used to
 * be global. None of that is a bug while exactly one provider exists, which is
 * why a green suite says nothing about it. It becomes data loss on a 5s timer
 * the moment a second lister is added, which is the next obvious change.
 */

import { describe, expect, it } from "vitest";
import { type AstirEvent, CONTRACT_VERSION, type Kind, type Provider } from "../src/contract/event.js";
import type { DiscoveredSession } from "../src/discovery/sessions.js";
import { Registry } from "../src/model/registry.js";

let seq = 0;
function ev(provider: Provider, sessionId: string, kind: Kind = "session_start"): AstirEvent {
  seq++;
  return {
    v: CONTRACT_VERSION,
    eventId: `e${seq}`,
    provider,
    sessionId,
    ts: 1_786_900_000 + seq,
    kind,
    agentId: sessionId,
    agentType: null,
    parentAgentId: null,
    parentSource: null,
    tool: null,
    description: null,
    paths: [],
    op: null,
    ok: null,
    notificationKind: null,
  };
}

const disc = (sessionId: string, cwd = "/repo"): DiscoveredSession => ({
  sessionId,
  cwd,
  pid: null,
  status: null,
  name: null,
  startedAt: null,
});

describe("reconcile is scoped to the provider that reported", () => {
  it("does not prune another provider's sessions when one reports without them", () => {
    // THE bug. Claude's lister knows nothing about Codex's sessions, so their
    // absence from its answer is not evidence of anything. Pruning on it
    // deletes them — every tick, silently, with every test still green.
    const r = new Registry({ nowMs: () => 1_000 });
    r.apply(ev("claude", "c1"), "/repo/a");
    r.apply(ev("codex", "x1"), "/repo/b");

    // Both have been vouched for by their own provider's discovery.
    r.reconcile([disc("c1")], { provider: "claude" });
    r.reconcile([disc("x1")], { provider: "codex" });
    expect(
      r
        .list()
        .map((s) => s.sessionId)
        .sort(),
    ).toEqual(["c1", "x1"]);

    // Now Claude reports only its own. Codex's session must survive.
    const { pruned } = r.reconcile([disc("c1")], { provider: "claude" });
    expect(pruned).toBe(0);
    expect(
      r
        .list()
        .map((s) => s.sessionId)
        .sort(),
    ).toEqual(["c1", "x1"]);
  });

  it("still prunes within the reporting provider", () => {
    // The scoping must not disable the prune it is narrowing — a session its
    // OWN provider has stopped listing really is gone.
    const r = new Registry({ nowMs: () => 1_000 });
    r.apply(ev("claude", "c1"), "/repo/a");
    r.apply(ev("claude", "c2"), "/repo/b");
    r.reconcile([disc("c1"), disc("c2")], { provider: "claude" });

    const { pruned } = r.reconcile([disc("c1")], { provider: "claude" });
    expect(pruned).toBe(1);
    expect(r.list().map((s) => s.sessionId)).toEqual(["c1"]);
  });

  it("prunes nothing for a provider that reports an empty list, for the other's sessions", () => {
    // The input the prune exists for, and the one a provider cannot be derived
    // from — which is why `provider` is passed explicitly rather than read off
    // the array.
    const r = new Registry({ nowMs: () => 1_000 });
    r.apply(ev("codex", "x1"), "/repo/b");
    r.reconcile([disc("x1")], { provider: "codex" });

    r.reconcile([], { provider: "claude" });
    expect(r.list().map((s) => s.sessionId)).toEqual(["x1"]);
  });

  it("keeps each provider's silent sessions when the other reports", () => {
    // The silent list was replaced wholesale on a complete answer. A complete
    // answer from ONE provider does not contain the other's silent sessions, so
    // replacing on it dropped them from every surface.
    const r = new Registry({ nowMs: () => 1_000 });
    r.reconcile([disc("quiet-claude", "/a")], { provider: "claude" });
    r.reconcile([disc("quiet-codex", "/b")], { provider: "codex" });

    expect(
      r
        .silent()
        .map((s) => s.sessionId)
        .sort(),
    ).toEqual(["quiet-claude", "quiet-codex"]);

    // Claude reports again, unchanged. Codex's silent session must remain.
    r.reconcile([disc("quiet-claude", "/a")], { provider: "claude" });
    expect(
      r
        .silent()
        .map((s) => s.sessionId)
        .sort(),
    ).toEqual(["quiet-claude", "quiet-codex"]);
  });

  it("replaces a provider's OWN silent list rather than accumulating it", () => {
    // Scoping must not turn the list into an append-only log: a session that
    // has genuinely gone away has to leave.
    const r = new Registry({ nowMs: () => 1_000 });
    r.reconcile([disc("a"), disc("b")], { provider: "claude" });
    r.reconcile([disc("a")], { provider: "claude" });
    expect(r.silent().map((s) => s.sessionId)).toEqual(["a"]);
  });

  it("does not let one provider's working discovery make the other's records reapable", () => {
    // The subtlest of the three. The undiscovered sweep deletes a record
    // discovery has never vouched for — reasonable, once discovery WORKS. With
    // one global flag, Claude's discovery answering makes astir willing to reap
    // a Codex session it has never once been able to see. And a blocked Codex
    // session emits nothing, so its `lastEventTs` stalls and the sweep reaches
    // it first: the state the product exists to report is the one it deletes.
    let now = 1_000;
    const r = new Registry({ nowMs: () => now, undiscoveredTtlMs: 10_000 });
    r.apply(ev("codex", "x1"), "/repo/b");

    // Only CLAUDE's discovery has ever answered.
    r.reconcile([], { provider: "claude" });

    now += 60_000;
    // The sweep lives in `tick()`. Calling a `sweep()` that does not exist —
    // via optional chaining, which fails silently — is how the first version of
    // this test passed while asserting nothing.
    r.tick();
    expect(r.list().map((s) => s.sessionId)).toEqual(["x1"]);
  });
});
