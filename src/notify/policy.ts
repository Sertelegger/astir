/**
 * PSH-02 — how long a notification's relevance lasts, and how insistently it
 * repeats, per state.
 *
 * Badge persistence is per-state, not uniform. Terminal states ("completed",
 * "failed") are self-explanatory: say it once and let it go. "Blocked" is the
 * opposite — an agent waiting on a human stays blocked until that human acts,
 * so a single fire-and-forget alert is not enough. Miss it once and the signal
 * is gone forever, which is the exact failure this project exists to prevent.
 *
 * The blocked cadence is therefore a *piecewise schedule*, not a widening
 * backoff from a fixed offset list. The distinction matters: a backoff assumes
 * the value of a reminder decays with age, but here the cost of a missed
 * reminder is constant — the agent is idle the entire time, burning wall-clock
 * that the user is paying for. So the early cadence is deliberately aggressive
 * (once a minute for ten minutes, when an interruption is cheapest and the
 * context is freshest) and only relaxes once repetition has clearly failed to
 * reach anyone, at which point the reminder's job changes from "interrupt" to
 * "do not let this be forgotten".
 */

export type NotifyKind = "blocked" | "completed" | "failed";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** One segment of a piecewise cadence: repeat every `everyMs` while age < `untilMs`. */
export interface CadencePhase {
  untilMs: number;
  everyMs: number;
}

export interface Lifetime {
  /** Ascending by `untilMs`. Empty means "notify once, never repeat". */
  phases: CadencePhase[];
  /** Cadence after the last phase, or null to stop repeating. */
  tailEveryMs: number | null;
  /** Stop notifying entirely once this old, and forget the entry. */
  maxAgeMs: number;
}

export const DEFAULT_LIFETIMES: Record<NotifyKind, Lifetime> = {
  // Aggressive early, then progressively calmer — but never silent inside the
  // first day. 10 reminders in the first 10 minutes, 10 more over the next 20,
  // 12 more over the following hour, then a steady quarter-hourly nudge.
  blocked: {
    phases: [
      { untilMs: 10 * MIN, everyMs: 1 * MIN },
      { untilMs: 30 * MIN, everyMs: 2 * MIN },
      { untilMs: 90 * MIN, everyMs: 5 * MIN },
    ],
    tailEveryMs: 15 * MIN,
    maxAgeMs: 24 * HOUR,
  },
  // Terminal and self-explanatory: once is enough.
  completed: { phases: [], tailEveryMs: null, maxAgeMs: 5 * MIN },
  // Worth a slightly longer memory than success, but still not repeated.
  failed: { phases: [], tailEveryMs: null, maxAgeMs: HOUR },
};

/** The cadence in force at `age`, or null if repetition has stopped. */
export function cadenceAt(life: Lifetime, age: number): number | null {
  for (const phase of life.phases) {
    if (age < phase.untilMs) return phase.everyMs;
  }
  return life.tailEveryMs;
}

interface Entry {
  kind: NotifyKind;
  firstAt: number;
  lastAt: number;
  sent: number;
}

/**
 * Pure decision logic — no I/O, no timers. The caller supplies `now`, so the
 * whole escalation schedule is testable without waiting a day.
 */
export class NotifyPolicy {
  private entries = new Map<string, Entry>();
  private lifetimes: Record<NotifyKind, Lifetime>;

  constructor(overrides?: Partial<Record<NotifyKind, Lifetime>>) {
    this.lifetimes = { ...DEFAULT_LIFETIMES, ...overrides };
  }

  /** True if a notification for `key` should be emitted at `now`. */
  shouldNotify(key: string, kind: NotifyKind, now: number): boolean {
    const existing = this.entries.get(key);

    // A change of kind is a new situation, not a continuation of the old one.
    if (existing === undefined || existing.kind !== kind) {
      this.entries.set(key, { kind, firstAt: now, lastAt: now, sent: 1 });
      return true;
    }

    const life = this.lifetimes[kind];
    const age = now - existing.firstAt;
    if (age >= life.maxAgeMs) return false;

    const every = cadenceAt(life, age);
    if (every === null) return false;

    // Measured from the last reminder, not from first contact: a poll that runs
    // late must not fire a burst of back-to-back catch-up notifications.
    if (now - existing.lastAt < every) return false;

    existing.lastAt = now;
    existing.sent++;
    return true;
  }

  /** How many notifications `key` has produced — used by the menu bar and tests. */
  sentCount(key: string): number {
    return this.entries.get(key)?.sent ?? 0;
  }

  /** When `key` first became notable, or null if it is not tracked. */
  firstSeen(key: string): number | null {
    return this.entries.get(key)?.firstAt ?? null;
  }

  /** The condition cleared — an agent stopped being blocked. Forget it. */
  resolve(key: string): void {
    this.entries.delete(key);
  }

  /** Drop entries past their maximum age so this cannot grow unbounded. */
  prune(now: number): void {
    for (const [key, entry] of [...this.entries]) {
      if (now - entry.firstAt >= this.lifetimes[entry.kind].maxAgeMs) this.entries.delete(key);
    }
  }

  /** Test/diagnostic accessor. */
  size(): number {
    return this.entries.size;
  }
}
