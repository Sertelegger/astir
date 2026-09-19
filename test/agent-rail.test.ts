/**
 * CAP-05 — the spawn tree, and the ordering rule that keeps it honest.
 *
 * Parentage was resolved deterministically, stored on the record and persisted
 * across a restart — then dropped before it reached the wire. So SC3 ("a
 * three-level subagent tree renders with correct parentage") was not merely
 * unimplemented, it was *unsatisfiable*: no amount of view work could nest a
 * rail whose data carried no parent.
 *
 * The ordering rule is the part worth pinning. The rail exists to answer G1 —
 * which agent needs you — so structure must never bury that.
 */

import { describe, expect, it } from "vitest";
import { nestAgents } from "../src/status/agents.js";

const a = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  state: "thinking",
  acknowledged: false,
  parentId: null as string | null,
  ...over,
});

const shape = (rows: ReturnType<typeof nestAgents>) =>
  rows.map((r) => `${"  ".repeat(r.depth)}${r.agent.id}`);

describe("the tree renders at all", () => {
  it("nests a child under its parent", () => {
    expect(shape(nestAgents([a("root"), a("kid", { parentId: "root" })]))).toEqual(["root", "  kid"]);
  });

  it("renders three levels, which is SC3's actual claim", () => {
    const rows = nestAgents([a("root"), a("kid", { parentId: "root" }), a("grandkid", { parentId: "kid" })]);
    expect(shape(rows)).toEqual(["root", "  kid", "    grandkid"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
  });

  it("keeps several roots side by side", () => {
    expect(shape(nestAgents([a("one"), a("two")]))).toEqual(["one", "two"]);
  });
});

describe("depth must not outrank needing a human", () => {
  it("pulls a blocked grandchild's whole branch to the top", () => {
    // The rule the rail lives or dies by. Ordering by structure alone would
    // bury the one row the product exists to show, several scrolls down.
    const rows = nestAgents([
      a("quiet-root"),
      a("quiet-kid", { parentId: "quiet-root" }),
      a("busy-root"),
      a("busy-kid", { parentId: "busy-root" }),
      a("blocked-grandkid", { parentId: "busy-kid", state: "blocked" }),
    ]);
    expect(rows[0]?.agent.id).toBe("busy-root");
    expect(shape(rows)).toEqual([
      "busy-root",
      "  busy-kid",
      "    blocked-grandkid",
      "quiet-root",
      "  quiet-kid",
    ]);
  });

  it("ranks an unacknowledged block above a dismissed one", () => {
    // Dismissing says "I know", not "it is resolved".
    const rows = nestAgents([
      a("dismissed", { state: "blocked", acknowledged: true }),
      a("shouting", { state: "blocked", acknowledged: false }),
    ]);
    expect(rows.map((r) => r.agent.id)).toEqual(["shouting", "dismissed"]);
  });

  it("orders siblings by urgency, not just roots", () => {
    const rows = nestAgents([
      a("root"),
      a("calm", { parentId: "root" }),
      a("stuck", { parentId: "root", state: "blocked" }),
    ]);
    expect(shape(rows)).toEqual(["root", "  stuck", "  calm"]);
  });

  it("does not reorder equally quiet siblings", () => {
    // A rail that reshuffles between frames makes every row's position
    // meaningless and every click a gamble.
    const rows = nestAgents([a("root"), a("b", { parentId: "root" }), a("c", { parentId: "root" })]);
    expect(shape(rows)).toEqual(["root", "  b", "  c"]);
  });
});

describe("it never loses an agent", () => {
  it("promotes an orphan to a root rather than hiding it", () => {
    // The parent finished and was filtered out. Dropping the child would hide
    // LIVE work because something unrelated ended.
    const rows = nestAgents([a("survivor", { parentId: "long-gone" })]);
    expect(shape(rows)).toEqual(["survivor"]);
  });

  it("orders a blocked orphan like any other root, rather than appending it", () => {
    // A single orphan lands at depth 0 whether it was promoted to a root or
    // merely swept up at the end, so presence alone cannot tell those apart —
    // and a swept-up agent is appended LAST, which for a blocked one is the
    // worst place on the rail.
    const rows = nestAgents([
      a("calm-root"),
      a("stuck-orphan", { parentId: "finished-long-ago", state: "blocked" }),
    ]);
    expect(rows[0]?.agent.id).toBe("stuck-orphan");
  });

  it("survives a cycle instead of hanging the tab", () => {
    // `parentId` arrives over a wire; a malformed chain is one payload away.
    const rows = nestAgents([a("x", { parentId: "y" }), a("y", { parentId: "x" }), a("normal")]);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.agent.id).sort()).toEqual(["normal", "x", "y"]);
  });

  it("renders a long chain without losing or duplicating a row", () => {
    // Written while trying to build a cycle REACHABLE from a root, which turns
    // out to be impossible: each agent has exactly one `parentId`, so every
    // member of a cycle has its parent inside that cycle and none is ever a
    // root. What this actually pins is the deep-chain case — and the fact that
    // a cycle can only ever be rescued by the completeness sweep, never by the
    // walk, is recorded on `nestAgents` itself.
    const rows = nestAgents([
      a("root"),
      a("x", { parentId: "root" }),
      a("y", { parentId: "x" }),
      a("loop", { parentId: "y" }),
      // `x` is also claimed by `loop`, closing the ring beneath a real root.
      a("x2", { parentId: "loop" }),
      a("back", { parentId: "x2" }),
    ]);
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.agent.id)).size).toBe(6);
  });

  it("survives an agent that claims to be its own parent", () => {
    const rows = nestAgents([a("narcissus", { parentId: "narcissus" })]);
    expect(shape(rows)).toEqual(["narcissus"]);
  });

  it("shows every agent exactly once in a deep tree", () => {
    const agents = [
      a("r"),
      ...Array.from({ length: 20 }, (_, i) => a(`n${i}`, { parentId: i === 0 ? "r" : `n${i - 1}` })),
    ];
    const rows = nestAgents(agents);
    expect(rows).toHaveLength(21);
    expect(new Set(rows.map((r) => r.agent.id)).size).toBe(21);
  });

  it("returns nothing for nothing", () => {
    expect(nestAgents([])).toEqual([]);
  });
});
