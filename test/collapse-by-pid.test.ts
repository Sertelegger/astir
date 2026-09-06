import { describe, expect, it } from "vitest";
import type { DiscoveredSession } from "../src/discovery/sessions.js";
import { collapseByPid } from "../src/discovery/sessions.js";

const d = (over: Partial<DiscoveredSession>): DiscoveredSession => ({
  sessionId: "a",
  cwd: "/repo",
  pid: 100,
  status: null,
  name: null,
  startedAt: null,
  ...over,
});

/** Nothing has been heard from, which is the state before any hook arrives. */
const heardNothing = () => false;

describe("one process is one session, whatever each profile calls it", () => {
  it("collapses two ids that share a pid", () => {
    // Reported from real use: `seenthat-e5` appeared twice. Same pid, same
    // slug, one `claude --continue` — but `~/.claude` called it f8bd4ab2 and
    // `~/.claude-nv` called it 6d2c8eb0. Each profile keeps its own registry
    // and mints its own id, so merging by id cannot see it.
    const got = collapseByPid(
      [d({ sessionId: "f8bd4ab2", pid: 1592449 }), d({ sessionId: "6d2c8eb0", pid: 1592449 })],
      heardNothing,
    );
    expect(got.map((s) => s.sessionId)).toEqual(["f8bd4ab2"]);
  });

  it("keeps genuinely different sessions apart", () => {
    const got = collapseByPid([d({ sessionId: "a", pid: 1 }), d({ sessionId: "b", pid: 2 })], heardNothing);
    expect(got.map((s) => s.sessionId)).toEqual(["a", "b"]);
  });

  it("prefers the id the daemon has actually heard from, not the first profile", () => {
    // The whole reason this takes a predicate. Hooks POST under exactly ONE of
    // the two ids; keep the other and the surviving row is enriched forever by
    // events that never arrive, so it never updates.
    const got = collapseByPid(
      [d({ sessionId: "quiet", pid: 7 }), d({ sessionId: "live", pid: 7 })],
      (id) => id === "live",
    );
    expect(got.map((s) => s.sessionId)).toEqual(["live"]);
  });

  it("keeps the earlier profile's id when neither has been heard from", () => {
    // candidateConfigDirs puts $CLAUDE_CONFIG_DIR first, so "earlier" is the
    // profile this daemon was actually started under.
    const got = collapseByPid(
      [d({ sessionId: "first", pid: 7 }), d({ sessionId: "second", pid: 7 })],
      heardNothing,
    );
    expect(got.map((s) => s.sessionId)).toEqual(["first"]);
  });

  it("keeps the incumbent when BOTH have been heard from", () => {
    // Ambiguous, so it does not thrash: an order that flips between polls would
    // make the row's id — and every action bound to it — unstable.
    const got = collapseByPid(
      [d({ sessionId: "first", pid: 7 }), d({ sessionId: "second", pid: 7 })],
      () => true,
    );
    expect(got.map((s) => s.sessionId)).toEqual(["first"]);
  });

  it("prefers the more active view when two profiles disagree about one process", () => {
    // Measured on a real machine: for pid 1592449, `~/.claude` said `idle` and
    // `~/.claude-nv` said `busy` — the same `claude --continue`. Profile order
    // picked `idle`, so astir reported a working session as quiet.
    //
    // Activity is evidence and its absence is not: a stale registry reports
    // what it last knew and cannot invent work. So the busier view wins.
    const got = collapseByPid(
      [
        d({ sessionId: "stale", pid: 1592449, status: "idle" }),
        d({ sessionId: "live", pid: 1592449, status: "busy" }),
      ],
      heardNothing,
    );
    expect(got.map((s) => s.sessionId)).toEqual(["live"]);
    expect(got[0]?.status).toBe("busy");
  });

  it("does not let a calmer view displace a busier incumbent", () => {
    // The same rule from the other side, which order alone would get wrong.
    const got = collapseByPid(
      [d({ sessionId: "live", pid: 7, status: "busy" }), d({ sessionId: "stale", pid: 7, status: "idle" })],
      heardNothing,
    );
    expect(got.map((s) => s.sessionId)).toEqual(["live"]);
  });

  it("treats a status it does not recognise as louder than idle, not quieter", () => {
    // We do not know what the word means, and astir must never look calmer than
    // it is entitled to — so an unfamiliar status must not be assumed quiet.
    const got = collapseByPid(
      [
        d({ sessionId: "idle", pid: 7, status: "idle" }),
        d({ sessionId: "odd", pid: 7, status: "compacting" }),
      ],
      heardNothing,
    );
    expect(got.map((s) => s.sessionId)).toEqual(["odd"]);
  });

  it("ranks an unknown status below a definitely-working one", () => {
    const got = collapseByPid(
      [
        d({ sessionId: "odd", pid: 7, status: "compacting" }),
        d({ sessionId: "busy", pid: 7, status: "busy" }),
      ],
      heardNothing,
    );
    expect(got.map((s) => s.sessionId)).toEqual(["busy"]);
  });

  it("prefers any status at all over none", () => {
    const got = collapseByPid(
      [d({ sessionId: "blank", pid: 7, status: null }), d({ sessionId: "idle", pid: 7, status: "idle" })],
      heardNothing,
    );
    expect(got.map((s) => s.sessionId)).toEqual(["idle"]);
  });

  it("still lets heard-from beat a livelier record that nothing reports to", () => {
    // Deliberate: a heard-from record showing a calmer state corrects itself on
    // the very next event, while a livelier record no hook targets never does.
    const got = collapseByPid(
      [
        d({ sessionId: "quiet-but-live", pid: 7, status: "idle" }),
        d({ sessionId: "busy-but-deaf", pid: 7, status: "busy" }),
      ],
      (id) => id === "quiet-but-live",
    );
    expect(got.map((s) => s.sessionId)).toEqual(["quiet-but-live"]);
  });

  it("never merges on a missing pid", () => {
    // No pid is no evidence. Fusing two genuine sessions into one row is a
    // worse failure than showing an extra, so absence must not be a key.
    const got = collapseByPid(
      [d({ sessionId: "a", pid: null }), d({ sessionId: "b", pid: null })],
      heardNothing,
    );
    expect(got.map((s) => s.sessionId)).toEqual(["a", "b"]);
  });

  it("preserves the order of everything it keeps", () => {
    // Surfaces rank from this list; reordering it on every poll would make the
    // menu bar shuffle for no reason a reader could see.
    const got = collapseByPid(
      [
        d({ sessionId: "a", pid: 1 }),
        d({ sessionId: "b", pid: 2 }),
        d({ sessionId: "b2", pid: 2 }),
        d({ sessionId: "c", pid: 3 }),
      ],
      heardNothing,
    );
    expect(got.map((s) => s.sessionId)).toEqual(["a", "b", "c"]);
  });

  it("keeps the winner in the loser's position rather than moving it to the end", () => {
    // The loser is deliberately NOT last. Removing it and appending the winner
    // gives the same answer when it is, so a fixture ending on the collapsed
    // pair cannot tell the two implementations apart — the first version of
    // this test could not, and a mutation that appends survived it.
    const got = collapseByPid(
      [d({ sessionId: "quiet", pid: 9 }), d({ sessionId: "x", pid: 1 }), d({ sessionId: "live", pid: 9 })],
      (id) => id === "live",
    );
    expect(got.map((s) => s.sessionId)).toEqual(["live", "x"]);
  });
});
