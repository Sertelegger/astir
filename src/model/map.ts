/**
 * MOD-01/MOD-02/MOD-08 — where work is happening, and where it has happened.
 *
 * Two numbers per file, deliberately different in kind:
 *
 *   heat   decays exponentially. Answers "what is being worked on NOW".
 *   total  never decays, only grows. Answers "what has this session touched".
 *
 * They are not two views of one number. A file edited heavily an hour ago and
 * untouched since must read cold on the live map and hot on the session map
 * (SC11), which is only possible if both are kept.
 *
 * ## The defect this design exists to avoid
 *
 * The previous version normalised colour against the *current maximum* leaf
 * heat. Under uniform exponential decay every leaf loses the same proportion,
 * so `heat / currentMax` is invariant — the hottest file stays exactly as hot
 * as it was, forever, and the map could never cool. A whole session's work
 * would sit there glowing at 3am.
 *
 * That is why MOD-01 requires normalising against
 * `max(currentMaxLeafHeat, ABSOLUTE_REFERENCE_HEAT)`: once real activity falls
 * below the reference, the reference takes over as the denominator and
 * everything fades together. The floor is what makes cooling possible, and it
 * has to be absolute — any relative floor reintroduces the same invariance.
 *
 * ## Growing, not scanning
 *
 * MOD-02: only files this session actually touched, plus nothing else. No
 * startup walk of the repo, no node cap, and no silent truncation — the
 * previous version had all three, and a truncated map that does not say it is
 * truncated is a lie about where work is happening.
 */

/** Time between a leaf halving in heat, absent further activity. */
const DEFAULT_HALF_LIFE_MS = 5 * 60_000;

/**
 * The absolute denominator floor, in units of "one touch".
 *
 * A single edit scores 1, so a reference of 2 means a file must be carrying
 * more than a couple of recent touches before it can saturate the scale. Too
 * low and one stray edit paints the map; too high and genuine activity never
 * shows.
 */
const DEFAULT_REFERENCE_HEAT = 2;

/** Below this, a leaf is idle — cold enough to render as background. */
const DEFAULT_IDLE_FLOOR = 0.05;

/**
 * Longest decay step honoured in one go.
 *
 * A laptop sleeping overnight, or a clock corrected by NTP, otherwise produces
 * an elapsed value that either flattens every leaf to zero or — if it went
 * backwards — *raises* heat. Clamping to a cap bounds both directions: elapsed
 * is confined to `[0, cap]`, so a jump can never resurrect a cold file, and a
 * long sleep decays by a bounded amount rather than an unbounded one.
 */
const DEFAULT_MAX_ELAPSED_MS = 60 * 60_000;

/**
 * Samples retained in the progression ring.
 *
 * Bounds memory in session length: an eight-hour session and a five-minute one
 * cost the same. The ring coarsens rather than truncates, so this trades
 * temporal resolution for a fixed ceiling — never span.
 */
const DEFAULT_PROGRESSION_SAMPLES = 60;

export interface RepoMapOpts {
  /**
   * Monotonic milliseconds. Defaults to `performance.now()` rather than
   * `Date.now()`: decay is computed from differences, and a wall clock can step
   * backwards. Only ever compared against itself, never against event
   * timestamps.
   */
  nowMs?: () => number;
  halfLifeMs?: number;
  referenceHeat?: number;
  idleFloor?: number;
  maxElapsedMs?: number;
  progressionSamples?: number;
}

/** One step of the progression: cumulative totals as of `at`. */
export interface Frame {
  at: number;
  totals: Record<string, number>;
}

export interface Leaf {
  path: string;
  /** Decayed to the moment it was read. */
  heat: number;
  /** Cumulative for the session. Never decreases. */
  total: number;
  /** Heat relative to `max(currentMax, referenceHeat)`, in `[0, 1]`. */
  intensity: number;
  idle: boolean;
}

/**
 * A closed interval of activity, stored as a DELTA rather than a snapshot.
 *
 * Two reasons. Memory: a snapshot holds every file the session has ever
 * touched, so a thousand-file session costs a thousand entries per sample,
 * whereas a delta holds only what moved in that interval. And merging: MOD-08
 * requires older samples be *merged* rather than dropped, and merging two
 * deltas is addition — exact, with nothing lost but the time resolution
 * between them. Merging two snapshots would mean discarding one.
 */
interface Sample {
  at: number;
  delta: Map<string, number>;
}

interface Entry {
  /** Heat as of `at` — decayed lazily on read rather than swept on a timer. */
  heat: number;
  at: number;
  total: number;
}

export class RepoMap {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly halfLifeMs: number;
  private readonly referenceHeat: number;
  private readonly idleFloor: number;
  private readonly maxElapsedMs: number;
  private readonly progressionSamples: number;
  /** Sealed intervals, oldest first. */
  private ring: Sample[] = [];
  /** Activity since the last `sample()`. */
  private pending = new Map<string, number>();
  private readonly startedAt: number;

  constructor(opts: RepoMapOpts = {}) {
    this.now = opts.nowMs ?? (() => performance.now());
    this.halfLifeMs = opts.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;
    this.referenceHeat = opts.referenceHeat ?? DEFAULT_REFERENCE_HEAT;
    this.idleFloor = opts.idleFloor ?? DEFAULT_IDLE_FLOOR;
    this.maxElapsedMs = opts.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS;
    this.progressionSamples = Math.max(2, opts.progressionSamples ?? DEFAULT_PROGRESSION_SAMPLES);
    this.startedAt = this.now();
  }

  /** Files touched this session. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Record activity on paths.
   *
   * Decay is applied to the existing heat *before* adding, so two touches an
   * hour apart do not sum as though they were simultaneous.
   */
  touch(paths: readonly string[], weight = 1): void {
    if (!Number.isFinite(weight) || weight <= 0) return;
    const now = this.now();
    for (const path of paths) {
      if (typeof path !== "string" || path.length === 0) continue;
      this.pending.set(path, (this.pending.get(path) ?? 0) + weight);
      const prev = this.entries.get(path);
      if (prev === undefined) {
        this.entries.set(path, { heat: weight, at: now, total: weight });
        continue;
      }
      prev.heat = this.decayed(prev, now) + weight;
      prev.at = now;
      prev.total += weight;
    }
  }

  private decayed(entry: Entry, now: number): number {
    // Clamped both ways — see DEFAULT_MAX_ELAPSED_MS.
    const elapsed = Math.min(Math.max(now - entry.at, 0), this.maxElapsedMs);
    return entry.heat * 0.5 ** (elapsed / this.halfLifeMs);
  }

  /**
   * Every touched file, hottest first.
   *
   * `intensity` is normalised against `max(currentMax, referenceHeat)` — the
   * reference is what lets the whole map cool rather than merely re-ranking.
   */
  list(): Leaf[] {
    const now = this.now();
    const decayed: Array<{ path: string; heat: number; total: number }> = [];
    let max = 0;
    for (const [path, entry] of this.entries) {
      const heat = this.decayed(entry, now);
      if (heat > max) max = heat;
      decayed.push({ path, heat, total: entry.total });
    }

    const denominator = Math.max(max, this.referenceHeat);
    return decayed
      .map((d) => ({
        path: d.path,
        heat: d.heat,
        total: d.total,
        intensity: denominator === 0 ? 0 : d.heat / denominator,
        idle: d.heat < this.idleFloor,
      }))
      .sort((a, b) => b.heat - a.heat || a.path.localeCompare(b.path));
  }

  /**
   * Seal the current interval into the progression.
   *
   * Called on a timer by the daemon. An interval with no activity is still
   * recorded: the progression has to span the whole session honestly, and a
   * quiet stretch is a real feature of how work spread, not an absence of data.
   */
  sample(): void {
    this.ring.push({ at: this.now(), delta: this.pending });
    this.pending = new Map();
    if (this.ring.length > this.progressionSamples) this.compact();
  }

  /**
   * Halve the ring by merging adjacent pairs.
   *
   * Merging is summation, so no total is lost — only the resolution between the
   * two intervals. The pair takes the later timestamp, which is when its
   * combined activity had certainly happened. Because this halves rather than
   * evicting a head, the oldest interval survives every compaction and the
   * progression keeps spanning the entire session.
   */
  private compact(): void {
    const merged: Sample[] = [];
    for (let i = 0; i < this.ring.length; i += 2) {
      const a = this.ring[i];
      const b = this.ring[i + 1];
      if (a === undefined) continue;
      if (b === undefined) {
        merged.push(a);
        continue;
      }
      for (const [path, n] of a.delta) b.delta.set(path, (b.delta.get(path) ?? 0) + n);
      merged.push({ at: b.at, delta: b.delta });
    }
    this.ring = merged;
  }

  /** Sealed intervals currently retained. Bounded by `progressionSamples`. */
  get samples(): number {
    return this.ring.length;
  }

  /** When this map started, so a caller can see the span the frames cover. */
  get since(): number {
    return this.startedAt;
  }

  /**
   * The progression, as cumulative totals per step.
   *
   * Deltas are prefix-summed here rather than stored summed, so the ring stays
   * small and merging stays exact. The last frame necessarily equals `totals()`
   * for everything sealed — which is the property that proves compaction loses
   * nothing.
   */
  frames(): Frame[] {
    const running = new Map<string, number>();
    const out: Frame[] = [];
    for (const sample of this.ring) {
      for (const [path, n] of sample.delta) running.set(path, (running.get(path) ?? 0) + n);
      out.push({ at: sample.at, totals: Object.fromEntries(running) });
    }
    return out;
  }

  /** The hottest `n`. The map itself is never truncated — only this view is. */
  hottest(n: number): Leaf[] {
    return this.list().slice(0, Math.max(0, n));
  }

  /**
   * Cumulative totals, largest first.
   *
   * Totals may be normalised against their own maximum without reintroducing
   * D3's invariance problem: they only ever grow, and they grow *unevenly*, so
   * the ratio between them genuinely changes over a session.
   */
  totals(): Array<{ path: string; total: number }> {
    return [...this.entries.entries()]
      .map(([path, e]) => ({ path, total: e.total }))
      .sort((a, b) => b.total - a.total || a.path.localeCompare(b.path));
  }
}
