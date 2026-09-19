/**
 * DMN-06 — a restored session says so, on every surface.
 *
 * `src/status/types.ts` states the rule beside the field: discovery confirmed
 * the SESSION is still running, nothing confirms its agent state is current, so
 * "rendering this identically to a heard-from session would assert more than it
 * knows". It reached `astir status` and stopped there — the menu bar, the
 * overview and the web view all asserted exactly that, and the flag was not
 * even on the frame, so the browser could not have said otherwise.
 *
 * Compare `predatesDaemon`, added in the same work for the same reason and
 * propagated to all four.
 */

import { describe, expect, it } from "vitest";
import { RepoMap } from "../src/model/map.js";
import { buildSnapshot } from "../src/status/frames.js";
import { overview } from "../src/status/overview.js";

const session = (over: Record<string, unknown> = {}) => ({
  sessionId: "s1",
  cwd: "/repo",
  name: "astir-aa",
  status: "busy",
  agents: [
    {
      id: "s1",
      state: "blocked",
      agentType: null,
      activeMs: 0,
      blockedMs: 840_000,
      inStateMs: 840_000,
      acknowledged: false,
    },
  ],
  ...over,
});

describe("the frame carries it, or the browser cannot say it", () => {
  const snap = (restored?: boolean) =>
    buildSnapshot({
      sessionId: "s1",
      cwd: "/repo",
      name: null,
      status: "busy",
      agents: [],
      map: new RepoMap({ nowMs: () => 1_000 }),
      seq: 1,
      counters: { pathsOutsideRepo: 0, invalidEvents: 0 },
      ...(restored === undefined ? {} : { restored }),
    });

  it("marks a restored snapshot", () => {
    expect(snap(true).restored).toBe(true);
  });

  it("omits the field entirely when not restored", () => {
    // Absent rather than `false`: every ordinary frame would otherwise carry a
    // byte saying nothing, and a delta between two of them would compare it.
    expect("restored" in snap(false)).toBe(false);
    expect("restored" in snap()).toBe(false);
  });
});

describe("the overview says it", () => {
  it("marks a live session that was restored", () => {
    // Live is exactly how it would otherwise render, which is the lie: it has
    // agents and a record, so nothing about it looks recovered.
    const rows = overview({ blockedCount: 1, sessions: [session({ restored: true })] });
    expect(rows[0]?.restored).toBe(true);
  });

  it("does not mark an ordinary live session", () => {
    const rows = overview({ blockedCount: 1, sessions: [session()] });
    expect(rows[0]?.restored).toBe(false);
  });

  it("never marks a silent session, which has no agent state to restore", () => {
    const rows = overview({
      blockedCount: 0,
      sessions: [],
      silent: [{ sessionId: "q1", cwd: "/repo", name: null, status: null, pid: null, startedAt: null }],
    });
    expect(rows[0]?.restored).toBe(false);
  });
});

describe("PSH-16, arriving from the other direction", () => {
  /**
   * A restored block's `blockedForMs` accrued BEFORE the daemon died, so it
   * clears the dwell the instant the daemon returns — and the dwell exists to
   * let a block prove it is real. This one proves only that it was real
   * earlier, which is precisely the interruption PSH-16 was written to prevent.
   *
   * Re-measured from the restore rather than skipped: a genuinely blocked agent
   * emits NOTHING, so suppressing until it acts would silence the one thing
   * this product exists to say.
   */
  const blocked = (restored: boolean) => ({
    sessionId: "s1",
    agentId: "a1",
    cwd: "/repo",
    reason: "permission_prompt",
    blockedForMs: 840_000,
    restored,
  });

  async function loopWith(agents: ReturnType<typeof blocked>[], nowMs: () => number) {
    const sent: string[] = [];
    const { NotifyLoop } = await import("../src/notify/loop.js");
    return {
      sent,
      loop: new NotifyLoop({
        registry: { blockedAgents: () => agents, list: () => [] } as never,
        policy: { shouldNotify: () => true, resolved: () => {}, prune: () => {} } as never,
        dispatcher: {
          send: async (e: { kind: string }) => {
            sent.push(e.kind);
            return [];
          },
        } as never,
        now: nowMs,
        notifyAfterMs: 5_000,
      }),
    };
  }

  it("does not interrupt on a block recovered from disk", async () => {
    const t = 1_000;
    const { loop, sent } = await loopWith([blocked(true)], () => t);
    await loop.pulse();
    expect(sent, "a memory is not grounds to interrupt anyone").toEqual([]);
  });

  it("DOES interrupt once the dwell has passed since the restore", async () => {
    // Suppressing forever would silence a genuinely blocked agent, which emits
    // nothing and so could never clear the flag by itself.
    let t = 1_000;
    const { loop, sent } = await loopWith([blocked(true)], () => t);
    await loop.pulse();
    t += 6_000;
    await loop.pulse();
    expect(sent).toHaveLength(1);
  });

  it("interrupts immediately for a block that was never restored", async () => {
    // The gate must not slow down the ordinary path — 840s is long past dwell.
    const t = 1_000;
    const { loop, sent } = await loopWith([blocked(false)], () => t);
    await loop.pulse();
    expect(sent).toHaveLength(1);
  });
});
