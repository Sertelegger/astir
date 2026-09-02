import { describe, expect, it } from "vitest";
import { RepoMap } from "../src/model/map.js";
import {
  applyDelta,
  buildSnapshot,
  diffSnapshots,
  heatFrom,
  type Snapshot,
  shades,
} from "../src/status/frames.js";
import type { StatusAgent } from "../src/status/types.js";

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const MIN = 60_000;

/** Fail loudly at the assertion rather than silently at a `!`. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

const agent = (over: Partial<StatusAgent> = {}): StatusAgent => ({
  id: "a1",
  state: "thinking",
  agentType: null,
  activeMs: 0,
  blockedMs: 0,
  inStateMs: 0,
  acknowledged: false,
  ...over,
});

function snap(over: Partial<Snapshot> = {}, map = new RepoMap({ nowMs: clock().now })): Snapshot {
  return {
    ...buildSnapshot({
      sessionId: "s1",
      cwd: "/repo",
      name: "astir-aa",
      status: "busy",
      agents: [agent()],
      map,
      counters: { pathsOutsideRepo: 0, invalidEvents: 0 },
      seq: 1,
    }),
    ...over,
  };
}

describe("VIEW-02 — deltas stay sparse", () => {
  it("emits nothing when nothing changed", () => {
    const a = snap();
    expect(diffSnapshots(a, { ...a, seq: 2 })).toBeNull();
  });

  it("does NOT resend a file just because time passed", () => {
    // The whole reason frames carry an age instead of heat. Diffing on a value
    // that changes every instant would put every file in every delta and make
    // "delta" a synonym for "snapshot".
    const c = clock();
    const map = new RepoMap({ nowMs: c.now });
    map.touch(["a.ts", "b.ts"]);
    const first = snap({}, map);

    c.advance(10 * MIN);
    const later = snap({ seq: 2 }, map);

    expect(first.files[0]?.ageMs).not.toBe(later.files[0]?.ageMs); // age really did move
    expect(diffSnapshots(first, later)).toBeNull(); // …and it still sends nothing
  });

  it("sends a file when it is actually touched", () => {
    const c = clock();
    const map = new RepoMap({ nowMs: c.now });
    map.touch(["a.ts"]);
    const first = snap({}, map);

    c.advance(MIN);
    map.touch(["a.ts"]);
    const delta = diffSnapshots(first, snap({ seq: 2 }, map));

    expect(delta?.files?.upsert.map((f) => f.path)).toEqual(["a.ts"]);
  });

  it("does not resend an agent whose only change is time in state", () => {
    // `inStateMs` advances by itself; the client ticks it like heat.
    const a = snap({ agents: [{ ...toFrame(agent()), inStateMs: 1_000 }] });
    const b = snap({ seq: 2, agents: [{ ...toFrame(agent()), inStateMs: 90_000 }] });
    expect(diffSnapshots(a, b)).toBeNull();
  });
});

/** The frame shape for an agent, so tests can vary one field. */
function toFrame(a: StatusAgent) {
  return {
    id: a.id,
    agentType: a.agentType,
    description: a.description ?? null,
    tool: a.tool ?? null,
    toolPath: a.toolPath ?? null,
    state: a.state,
    activeMs: a.activeMs,
    blockedMs: a.blockedMs,
    inStateMs: a.inStateMs,
    turnMs: 0,
    acknowledged: a.acknowledged,
  };
}

describe("#11 — deltas can express removal", () => {
  it("removes an agent that is gone", () => {
    const two = snap({ agents: [toFrame(agent()), toFrame(agent({ id: "a2" }))] });
    const one = snap({ seq: 2, agents: [toFrame(agent())] });

    expect(diffSnapshots(two, one)?.agents?.remove).toEqual(["a2"]);
  });

  it("actually drops it when applied — no ghost left on the map", () => {
    const two = snap({ agents: [toFrame(agent()), toFrame(agent({ id: "a2" }))] });
    const one = snap({ seq: 2, agents: [toFrame(agent())] });
    const delta = diffSnapshots(two, one);

    expect(applyDelta(two, must(delta, "a delta")).agents.map((a) => a.id)).toEqual(["a1"]);
  });

  it("reports a state change as an upsert", () => {
    const a = snap({ agents: [toFrame(agent({ state: "thinking" }))] });
    const b = snap({ seq: 2, agents: [toFrame(agent({ state: "blocked" }))] });

    expect(diffSnapshots(a, b)?.agents?.upsert?.[0]?.state).toBe("blocked");
  });
});

describe("snapshot + delta reconstructs the same state", () => {
  it("matches the snapshot it was diffed against", () => {
    // The property the whole scheme rests on. If the producer and the reducer
    // disagree about what a frame means, the view is quietly wrong and nothing
    // says so.
    const c = clock();
    const map = new RepoMap({ nowMs: c.now });
    map.touch(["a.ts"]);
    const before = snap({}, map);

    c.advance(MIN);
    map.touch(["a.ts", "b.ts"]);
    const after = snap({ seq: 2, agents: [toFrame(agent({ state: "tool-running" }))] }, map);

    const rebuilt = applyDelta(before, must(diffSnapshots(before, after), "a delta"));
    expect(rebuilt.agents).toEqual(after.agents);
    expect(new Map(rebuilt.files.map((f) => [f.path, f.total]))).toEqual(
      new Map(after.files.map((f) => [f.path, f.total])),
    );
  });

  it("survives a chain of deltas", () => {
    const c = clock();
    const map = new RepoMap({ nowMs: c.now });
    let base = snap({}, map);
    let seq = 1;
    for (let i = 0; i < 20; i++) {
      map.touch([`f${i % 4}.ts`]);
      c.advance(5_000);
      const next = snap({ seq: ++seq }, map);
      const d = diffSnapshots(base, next);
      base = d === null ? base : applyDelta(base, d);
    }
    const truth = snap({ seq }, map);
    expect(new Map(base.files.map((f) => [f.path, f.total]))).toEqual(
      new Map(truth.files.map((f) => [f.path, f.total])),
    );
  });

  it("VIEW-02 — ignores a frame for a different session", () => {
    // Identity is verified rather than assumed; a stream crossed with another
    // session's would otherwise silently merge two repos.
    const base = snap();
    const changed = must(diffSnapshots(base, snap({ seq: 2, status: "idle" })), "a delta");
    const foreign = { ...changed, sessionId: "other" };
    expect(applyDelta(base, foreign)).toBe(base);
  });
});

describe("heat reconstructed client-side matches the model", () => {
  it("agrees with the model's own decayed value", () => {
    // If these diverge the map lies about what is hot, so the client's curve is
    // checked against the model rather than assumed to match.
    const c = clock();
    const map = new RepoMap({ nowMs: c.now, halfLifeMs: 5 * MIN });
    map.touch(["a.ts"]);
    c.advance(2 * MIN);
    map.touch(["a.ts"]);

    const frame = snap({}, map);
    c.advance(3 * MIN);
    const fromModel = map.list().find((l) => l.path === "a.ts")?.heat ?? 0;
    const fromFrame = heatFrom(must(frame.files[0], "a file"), 3 * MIN, frame.decay);

    expect(fromFrame).toBeCloseTo(fromModel, 6);
  });

  it("is NOT total × decay, which is the tempting shortcut", () => {
    // A file touched repeatedly over an hour has far less heat than its total
    // implies, because earlier touches decayed before the later ones landed.
    const c = clock();
    const map = new RepoMap({ nowMs: c.now, halfLifeMs: 5 * MIN });
    for (let i = 0; i < 10; i++) {
      map.touch(["spread.ts"]);
      c.advance(5 * MIN);
    }
    const frame = snap({}, map);
    const file = must(frame.files[0], "a file");

    expect(file.total).toBe(10);
    expect(file.heat).toBeLessThan(3);
  });

  it("normalises against the absolute reference, so the view can cool too", () => {
    const c = clock();
    const map = new RepoMap({ nowMs: c.now, halfLifeMs: 5 * MIN, referenceHeat: 2 });
    map.touch(["only.ts"]);
    const frame = snap({}, map);

    const now = shades(frame.files, "live", 0, frame.decay)[0]?.intensity ?? 0;
    const later = shades(frame.files, "live", 40 * MIN, frame.decay)[0]?.intensity ?? 0;

    expect(later).toBeLessThan(now);
    expect(shades(frame.files, "live", 40 * MIN, frame.decay)[0]?.idle).toBe(true);
  });
});

describe("VIEW-10 / SC11 — the same file, opposite answers", () => {
  it("reads COLD live and HOT for the session", () => {
    // The scenario the two modes exist for: a file edited heavily early and
    // untouched since. Live says "nothing is happening there"; session says
    // "that is where this session's work went". Both are true.
    const c = clock();
    const map = new RepoMap({ nowMs: c.now, halfLifeMs: 5 * MIN });
    for (let i = 0; i < 20; i++) map.touch(["early.ts"]);
    c.advance(60 * MIN);
    map.touch(["late.ts"]);

    const frame = snap({}, map);
    const live = new Map(shades(frame.files, "live", 0, frame.decay).map((s) => [s.path, s]));
    const session = new Map(shades(frame.files, "session", 0, frame.decay).map((s) => [s.path, s]));

    expect(live.get("early.ts")?.idle).toBe(true);
    expect(live.get("early.ts")?.intensity).toBeLessThan(live.get("late.ts")?.intensity ?? 0);

    expect(session.get("early.ts")?.intensity).toBe(1);
    expect(session.get("early.ts")?.intensity).toBeGreaterThan(session.get("late.ts")?.intensity ?? 1);
  });

  it("never fades a file in session mode, however old", () => {
    const c = clock();
    const map = new RepoMap({ nowMs: c.now, halfLifeMs: 5 * MIN });
    map.touch(["ancient.ts"]);
    c.advance(24 * 60 * MIN);

    const frame = snap({}, map);
    expect(shades(frame.files, "session", 0, frame.decay)[0]?.idle).toBe(false);
    expect(shades(frame.files, "live", 0, frame.decay)[0]?.idle).toBe(true);
  });

  it("does not divide by zero before anything is touched", () => {
    const frame = snap();
    expect(shades(frame.files, "session", 0, frame.decay)).toEqual([]);
    expect(shades(frame.files, "live", 0, frame.decay)).toEqual([]);
  });
});
