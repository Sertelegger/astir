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

  constructor(opts: RepoMapOpts = {}) {
    this.now = opts.nowMs ?? (() => performance.now());
    this.halfLifeMs = opts.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;
    this.referenceHeat = opts.referenceHeat ?? DEFAULT_REFERENCE_HEAT;
    this.idleFloor = opts.idleFloor ?? DEFAULT_IDLE_FLOOR;
    this.maxElapsedMs = opts.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS;
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
