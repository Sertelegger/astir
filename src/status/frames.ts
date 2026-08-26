/**
 * VIEW-02 — what the view renders from: a snapshot, then deltas.
 *
 * Pure functions on purpose, in the same spirit as `renderMenubar`. Everything
 * here is testable under vitest with no DOM, no HTTP and no clock of its own,
 * so the transport and the eventual rendering shell stay thin enough to be
 * replaced without taking the semantics with them.
 *
 * ## Why heat is not in the frames
 *
 * Heat decays continuously, so a frame carrying it would differ from the last
 * one at every instant and every "delta" would be a full snapshot wearing a
 * smaller name. Worse, the map could only animate as fast as the network.
 *
 * Frames carry `ageMs` — how long since a file was last touched — plus the
 * decay parameters, and the client recomputes heat locally. A file then only
 * enters a delta when it is actually *touched*, which is sparse, and the map
 * cools smoothly between deltas at whatever framerate the browser likes.
 *
 * It also sidesteps clock skew entirely. An age is a duration, and both ends
 * agree on how long a second is; they do not agree on what time it is, and the
 * map's own clock is monotonic and process-relative so it means nothing
 * anywhere else.
 */

import type { RepoMap } from "../model/map.js";
import type { StatusAgent } from "./types.js";

export const FRAME_VERSION = { major: 1, minor: 0 } as const;

/** How the client reconstructs heat without being told it. */
export interface DecayParams {
  halfLifeMs: number;
  referenceHeat: number;
  idleFloor: number;
}

export interface FileFrame {
  path: string;
  /** Cumulative touches this session. Only ever grows. */
  total: number;
  /**
   * Heat as it stood at the moment of the last touch — NOT `total`, and not
   * heat now.
   *
   * The two differ, and assuming otherwise is the easy mistake here: heat
   * accumulates and decays between touches, so a file touched twenty times
   * across an hour carries far less heat than a file touched twenty times in a
   * minute, while both have a total of twenty. Sending the stored value and the
   * age lets the client reproduce the model's curve exactly rather than
   * approximate it.
   */
  heat: number;
  /** Milliseconds since last touched, as of this frame. */
  ageMs: number;
}

export interface AgentFrame {
  id: string;
  agentType: string | null;
  state: string;
  activeMs: number;
  blockedMs: number;
  inStateMs: number;
  turnMs: number;
  acknowledged: boolean;
}

/**
 * VIEW-06 — what was dropped. Carried on every snapshot so the view can show a
 * persistent indicator rather than quietly rendering an incomplete picture.
 */
export interface FrameCounters {
  droppedPaths: number;
  rejected: number;
}

export interface Snapshot {
  kind: "snapshot";
  v: typeof FRAME_VERSION;
  /** VIEW-02 — the client verifies this matches the session it asked for. */
  sessionId: string;
  seq: number;
  cwd: string;
  name: string | null;
  status: string | null;
  agents: AgentFrame[];
  files: FileFrame[];
  decay: DecayParams;
  counters: FrameCounters;
}

export interface Delta {
  kind: "delta";
  v: typeof FRAME_VERSION;
  sessionId: string;
  seq: number;
  /** Absent when unchanged. */
  status?: string | null;
  name?: string | null;
  agents?: {
    upsert?: AgentFrame[];
    /** #13 — a frame that cannot express removal leaves ghosts on the map. */
    remove?: string[];
  };
  /** Files are grow-only: a touched file never stops having been touched. */
  files?: { upsert: FileFrame[] };
  counters?: FrameCounters;
}

export type Frame = Snapshot | Delta;

export interface SnapshotInput {
  sessionId: string;
  cwd: string;
  name: string | null;
  status: string | null;
  agents: StatusAgent[];
  map: Pick<RepoMap, "ages" | "decayParams">;
  counters: FrameCounters;
  seq: number;
}

export function buildSnapshot(input: SnapshotInput): Snapshot {
  return {
    kind: "snapshot",
    v: FRAME_VERSION,
    sessionId: input.sessionId,
    seq: input.seq,
    cwd: input.cwd,
    name: input.name,
    status: input.status,
    agents: input.agents.map(toAgentFrame),
    files: input.map.ages(),
    decay: input.map.decayParams(),
    counters: input.counters,
  };
}

function toAgentFrame(a: StatusAgent): AgentFrame {
  return {
    id: a.id,
    agentType: a.agentType,
    state: a.state,
    activeMs: a.activeMs,
    blockedMs: a.blockedMs,
    inStateMs: a.inStateMs,
    turnMs: a.turnMs ?? 0,
    acknowledged: a.acknowledged,
  };
}

/** Fields whose change is worth a frame. `inStateMs` is excluded — it advances
 * on its own and the client can tick it, exactly like heat. */
function agentChanged(a: AgentFrame, b: AgentFrame): boolean {
  return (
    a.state !== b.state ||
    a.acknowledged !== b.acknowledged ||
    a.agentType !== b.agentType ||
    a.activeMs !== b.activeMs ||
    a.blockedMs !== b.blockedMs ||
    a.turnMs !== b.turnMs
  );
}

/**
 * The difference between two snapshots, or `null` when there is none.
 *
 * Files are compared on `total` and NOT on `ageMs`: age changes every instant
 * by definition, so diffing it would make every file appear in every delta and
 * defeat the entire point. A file whose total moved has just been touched, and
 * its age is ~0 anyway.
 */
export function diffSnapshots(prev: Snapshot, next: Snapshot): Delta | null {
  const delta: Delta = {
    kind: "delta",
    v: FRAME_VERSION,
    sessionId: next.sessionId,
    seq: next.seq,
  };
  let changed = false;

  if (prev.status !== next.status) {
    delta.status = next.status;
    changed = true;
  }
  if (prev.name !== next.name) {
    delta.name = next.name;
    changed = true;
  }

  const before = new Map(prev.agents.map((a) => [a.id, a]));
  const upsert = next.agents.filter((a) => {
    const was = before.get(a.id);
    return was === undefined || agentChanged(was, a);
  });
  const present = new Set(next.agents.map((a) => a.id));
  const remove = prev.agents.map((a) => a.id).filter((id) => !present.has(id));
  if (upsert.length > 0 || remove.length > 0) {
    delta.agents = {
      ...(upsert.length > 0 ? { upsert } : {}),
      ...(remove.length > 0 ? { remove } : {}),
    };
    changed = true;
  }

  const totals = new Map(prev.files.map((f) => [f.path, f.total]));
  const touched = next.files.filter((f) => totals.get(f.path) !== f.total);
  if (touched.length > 0) {
    delta.files = { upsert: touched };
    changed = true;
  }

  if (
    prev.counters.droppedPaths !== next.counters.droppedPaths ||
    prev.counters.rejected !== next.counters.rejected
  ) {
    delta.counters = next.counters;
    changed = true;
  }

  return changed ? delta : null;
}

/**
 * Fold a delta into a snapshot, giving the state the client should be showing.
 *
 * Lives here rather than in the client so the reducer is tested once, against
 * the same fixtures as the producer — a snapshot-plus-delta scheme fails when
 * the two ends disagree about what a frame means, and that disagreement is
 * invisible until something is quietly missing on screen.
 */
export function applyDelta(base: Snapshot, delta: Delta): Snapshot {
  if (delta.sessionId !== base.sessionId) return base;

  const agents = new Map(base.agents.map((a) => [a.id, a]));
  for (const id of delta.agents?.remove ?? []) agents.delete(id);
  for (const a of delta.agents?.upsert ?? []) agents.set(a.id, a);

  const files = new Map(base.files.map((f) => [f.path, f]));
  for (const f of delta.files?.upsert ?? []) files.set(f.path, f);

  return {
    ...base,
    seq: delta.seq,
    status: delta.status !== undefined ? delta.status : base.status,
    name: delta.name !== undefined ? delta.name : base.name,
    agents: [...agents.values()],
    files: [...files.values()],
    counters: delta.counters ?? base.counters,
  };
}

/**
 * Heat, reconstructed client-side.
 *
 * The same curve the model uses, deliberately duplicated rather than imported
 * from it: the model's version reads a monotonic clock and mutates entries,
 * while this one is a pure function of an age. Sharing the implementation would
 * mean shipping the model's clock to the browser.
 */
export function heatFrom(file: FileFrame, elapsedSinceFrameMs: number, decay: DecayParams): number {
  const elapsed = Math.max(file.ageMs + elapsedSinceFrameMs, 0);
  return file.heat * 0.5 ** (elapsed / decay.halfLifeMs);
}

/**
 * VIEW-10 — the two modes of the map, over identical geometry.
 *
 * `live` colours by decaying heat: where work is happening NOW. `session`
 * colours by cumulative total: where work has happened AT ALL. They look alike
 * and mean opposite things, which is exactly why the spec requires the active
 * one to be labelled.
 */
export type MapMode = "live" | "session";

export interface Shade {
  path: string;
  total: number;
  /** Whatever the mode is about — decayed heat, or cumulative touches. */
  value: number;
  /** `[0, 1]`, for the ramp. */
  intensity: number;
  /** Cold enough to render as background. Never true in session mode. */
  idle: boolean;
}

/**
 * Normalise for the chosen mode.
 *
 * The two denominators are deliberately different in kind, and the asymmetry is
 * the point:
 *
 * - Live normalises against `max(currentMax, referenceHeat)` — see MOD-01. An
 *   absolute floor is what lets the map COOL; against the current maximum alone
 *   the hottest file stays exactly as hot forever, because uniform exponential
 *   decay preserves every ratio.
 * - Session normalises against the largest total, with no floor. Totals only
 *   grow, and they grow unevenly, so their ratios genuinely change over a
 *   session and there is no invariance to escape. A floor here would instead
 *   make an entire early session render as uniformly cold, which is false.
 */
export function shades(
  files: readonly FileFrame[],
  mode: MapMode,
  elapsedSinceFrameMs: number,
  decay: DecayParams,
): Shade[] {
  if (mode === "session") {
    const max = files.reduce((m, f) => (f.total > m ? f.total : m), 0);
    return files.map((f) => ({
      path: f.path,
      total: f.total,
      value: f.total,
      intensity: max <= 0 ? 0 : f.total / max,
      // A file this session touched is part of this session's work, however
      // long ago. Fading it here would answer the live question in session mode.
      idle: false,
    }));
  }

  const heats = files.map((f) => ({
    path: f.path,
    total: f.total,
    value: heatFrom(f, elapsedSinceFrameMs, decay),
  }));
  const max = heats.reduce((m, h) => (h.value > m ? h.value : m), 0);
  const denominator = Math.max(max, decay.referenceHeat);
  return heats.map((h) => ({
    ...h,
    intensity: denominator === 0 ? 0 : h.value / denominator,
    idle: h.value < decay.idleFloor,
  }));
}
