/**
 * PSH-02 — how long a notification's relevance lasts, per state.
 *
 * The insight is borrowed from Codex's ambient-pet state model: badge persistence
 * is per-state, not uniform. "Running" decays quickly because it is
 * self-correcting; "needs input" persists, because a blocked agent stays blocked
 * until a human acts. A single fire-and-forget alert is not enough — miss it once
 * and the signal is gone forever, which is the exact failure this project exists
 * to prevent.
 *
 * So `blocked` re-reminds on a widening backoff until it is resolved or a day
 * passes, and terminal states notify once and expire.
 */

export type NotifyKind = "blocked" | "completed" | "failed";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

interface Lifetime {
  /** Offsets from the first notification at which to re-notify. */
  reminderOffsetsMs: number[];
  /** After the explicit offsets are exhausted, repeat at this cadence. */
  repeatEveryMs: number | null;
  /** Stop notifying entirely once this old, and forget the entry. */
  maxAgeMs: number;
}

export const LIFETIMES: Record<NotifyKind, Lifetime> = {
  // Widening backoff: insistent early while it is most recoverable, then a
  // steady hourly nudge so an agent blocked overnight is still surfaced without
  // becoming noise.
  blocked: {
    reminderOffsetsMs: [0, 2 * MIN, 5 * MIN, 15 * MIN, 30 * MIN],
    repeatEveryMs: HOUR,
    maxAgeMs: 24 * HOUR,
  },
  // Terminal and self-explanatory: say it once, then let it go.
  completed: { reminderOffsetsMs: [0], repeatEveryMs: null, maxAgeMs: 5 * MIN },
  // Worth a slightly longer memory than success, but still not repeated.
  failed: { reminderOffsetsMs: [0], repeatEveryMs: null, maxAgeMs: HOUR },
};

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

  /** True if a notification for `key` should be emitted at `now`. */
  shouldNotify(key: string, kind: NotifyKind, now: number): boolean {
    const existing = this.entries.get(key);

    // A change of kind is a new situation, not a continuation of the old one.
    if (existing === undefined || existing.kind !== kind) {
      this.entries.set(key, { kind, firstAt: now, lastAt: now, sent: 1 });
      return true;
    }

    const life = LIFETIMES[kind];
    const age = now - existing.firstAt;
    if (age >= life.maxAgeMs) return false;

    const nextOffset = this.nextOffset(life, existing.sent);
    if (nextOffset === null || age < nextOffset) return false;

    existing.lastAt = now;
    existing.sent++;
    return true;
  }

  /** Offset at which reminder number `sent` becomes due, or null if there is none. */
  private nextOffset(life: Lifetime, sent: number): number | null {
    const explicit = life.reminderOffsetsMs[sent];
    if (explicit !== undefined) return explicit;
    if (life.repeatEveryMs === null) return null;
    const last = life.reminderOffsetsMs.at(-1) ?? 0;
    const extra = sent - life.reminderOffsetsMs.length + 1;
    return last + extra * life.repeatEveryMs;
  }

  /** The condition cleared — an agent stopped being blocked. Forget it. */
  resolve(key: string): void {
    this.entries.delete(key);
  }

  /** Drop entries past their maximum age so this cannot grow unbounded. */
  prune(now: number): void {
    for (const [key, entry] of [...this.entries]) {
      if (now - entry.firstAt >= LIFETIMES[entry.kind].maxAgeMs) this.entries.delete(key);
    }
  }

  /** Test/diagnostic accessor. */
  size(): number {
    return this.entries.size;
  }
}
