/**
 * PSH-02 — how long a notification's relevance lasts, and how insistently it
 * repeats, per state.
 *
 * Badge persistence is per-state, not uniform. Terminal states ("completed",
 * "failed") are self-explanatory: say it once and let it go. "Blocked" is the
 * opposite — an agent waiting on a human stays blocked until that human acts,
 * so a single fire-and-forget alert is not always enough.
 *
 * How often a blocked agent is reminded is a setting (#98), because how much
 * interruption is right depends on the person, not on the agent:
 *
 * - `calm`, the default: reminders at +10 and +30 minutes after the first
 *   alert, then hourly. Enough that a missed alert comes back, few enough to
 *   leave on all day.
 * - `insistent`: the only schedule before #98, unchanged. Its reasoning still
 *   holds for whoever wants it: the cost of a missed reminder does not decay
 *   with age, since the agent is idle the whole time, so it is aggressive
 *   early (once a minute for ten minutes, when an interruption is cheapest
 *   and the context freshest) and settles at quarter-hourly rather than
 *   relaxing further. In use, its 32 alerts in the first 90 minutes were too
 *   many to be the default.
 * - `off`: the first alert only. A block that ends still sends its
 *   `resolved` doorbell, which is the loop's business, not this file's.
 *
 * Every schedule ends at 24 hours, and every one measures a reminder from the
 * last one sent, so a poll that runs late fires once rather than a burst.
 */

export type NotifyKind = "blocked" | "completed" | "failed";

/** PSH-02 — how often a blocked agent is reminded (#98). */
export type ReminderSchedule = "off" | "calm" | "insistent";

export const REMINDER_SCHEDULES: readonly ReminderSchedule[] = ["off", "calm", "insistent"];

export const DEFAULT_REMINDERS: ReminderSchedule = "calm";

export function isReminderSchedule(value: unknown): value is ReminderSchedule {
  return typeof value === "string" && (REMINDER_SCHEDULES as readonly string[]).includes(value);
}

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** One segment of a piecewise cadence: repeat every `everyMs` while age < `untilMs`. */
export interface CadencePhase {
  untilMs: number;
  everyMs: number;
}

export interface Lifetime {
  /**
   * Reminders at offsets from the first alert, ascending, before the cadence
   * below takes over. Each is due one step after the reminder sent before it,
   * the step being its distance from the offset before it, so on time they
   * land on the offsets. A late one moves the rest along rather than letting
   * the next follow it at once, and any offset a late poll passed goes with
   * it. Absent means none.
   */
  atMs?: readonly number[];
  /** Ascending by `untilMs`. Empty means "notify once, never repeat". */
  phases: CadencePhase[];
  /** Cadence after the last phase, or null to stop repeating. */
  tailEveryMs: number | null;
  /** Stop notifying entirely once this old. */
  maxAgeMs: number;
}

/** The blocked-agent lifetime for each reminder schedule. */
export const BLOCKED_LIFETIMES: Record<ReminderSchedule, Lifetime> = {
  // +10 and +30 after the first alert, then an hour after whichever reminder
  // went last: 26 alerts in a day, the first included. Each step is measured
  // from the reminder before it (10 minutes, then 20, then 60), so a +10 that
  // a late poll sent at 29:59 is not followed by +30 a second later.
  //
  // Offsets rather than phases, because a phase is chosen by the age NOW: at
  // exactly +10 a "10 minutes until +10" phase has already ended, and the
  // next phase's 20-minute gap, from a first alert only 10 minutes back,
  // would move the reminder to +20.
  calm: {
    atMs: [10 * MIN, 30 * MIN],
    phases: [],
    tailEveryMs: 60 * MIN,
    maxAgeMs: 24 * HOUR,
  },
  // Aggressive early, then progressively calmer — but never silent inside the
  // first day. 10 alerts in the first 10 minutes, 10 more over the next 20,
  // 12 more over the following hour, then a steady quarter-hourly nudge.
  insistent: {
    phases: [
      { untilMs: 10 * MIN, everyMs: 1 * MIN },
      { untilMs: 30 * MIN, everyMs: 2 * MIN },
      { untilMs: 90 * MIN, everyMs: 5 * MIN },
    ],
    tailEveryMs: 15 * MIN,
    maxAgeMs: 24 * HOUR,
  },
  // The first alert and nothing after it. Still a day long, so an agent
  // blocked all along is not announced again as new.
  off: { phases: [], tailEveryMs: null, maxAgeMs: 24 * HOUR },
};

export const DEFAULT_LIFETIMES: Record<NotifyKind, Lifetime> = {
  blocked: BLOCKED_LIFETIMES[DEFAULT_REMINDERS],
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
 * Whether a reminder is due at `now`, for an entry first notified at
 * `firstAt` and last at `lastAt`.
 *
 * The first offset still ahead of the last reminder comes first, one step
 * after it. After the last offset, the cadence for the current age. Either
 * way measured from the last reminder sent, not from first contact: a poll
 * that runs late must not fire a burst of back-to-back catch-up
 * notifications.
 */
function reminderDue(life: Lifetime, firstAt: number, lastAt: number, now: number): boolean {
  const offsets = life.atMs ?? [];
  const next = offsets.findIndex((offset) => firstAt + offset > lastAt);
  if (next !== -1) {
    const step = (offsets[next] ?? 0) - (next > 0 ? (offsets[next - 1] ?? 0) : 0);
    return now - lastAt >= step;
  }
  const every = cadenceAt(life, now - firstAt);
  return every !== null && now - lastAt >= every;
}

export interface NotifyPolicyOpts {
  /**
   * PSH-02 — the blocked-agent schedule, or a getter for it. A getter is read
   * at every decision, so a changed setting applies to a block already in
   * progress from the next pulse on: its next step measured from the last
   * reminder sent, its day still counted from the block's first alert.
   * Defaults to `calm`.
   */
  reminders?: ReminderSchedule | (() => ReminderSchedule);
}

/**
 * Pure decision logic — no I/O, no timers. The caller supplies `now`, so the
 * whole escalation schedule is testable without waiting a day. The schedule
 * is handed in, never read here: where it comes from is the daemon's business.
 */
export class NotifyPolicy {
  private entries = new Map<string, Entry>();
  private readonly reminders: () => ReminderSchedule;

  constructor(opts: NotifyPolicyOpts = {}) {
    const reminders = opts.reminders ?? DEFAULT_REMINDERS;
    this.reminders = typeof reminders === "function" ? reminders : () => reminders;
  }

  private lifetime(kind: NotifyKind): Lifetime {
    return kind === "blocked" ? BLOCKED_LIFETIMES[this.reminders()] : DEFAULT_LIFETIMES[kind];
  }

  /** True if a notification for `key` should be emitted at `now`. */
  shouldNotify(key: string, kind: NotifyKind, now: number): boolean {
    const existing = this.entries.get(key);

    // A change of kind is a new situation, not a continuation of the old one.
    if (existing === undefined || existing.kind !== kind) {
      this.entries.set(key, { kind, firstAt: now, lastAt: now, sent: 1 });
      return true;
    }

    const life = this.lifetime(kind);
    if (now - existing.firstAt >= life.maxAgeMs) return false;
    if (!reminderDue(life, existing.firstAt, existing.lastAt, now)) return false;

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

  /**
   * Drop entries past their maximum age so this cannot grow unbounded — all
   * but those in `keep`, whose condition still stands.
   *
   * A day-old entry for an agent still blocked has to stay. Forgotten, the
   * next pulse read the same block as new: a fresh first alert, and the
   * whole schedule over again, so no schedule ever ended at 24 hours and
   * `off` alerted once a day. It goes when the block does, through `resolve`.
   */
  prune(now: number, keep: ReadonlySet<string> = new Set()): void {
    for (const [key, entry] of [...this.entries]) {
      if (keep.has(key)) continue;
      if (now - entry.firstAt >= this.lifetime(entry.kind).maxAgeMs) this.entries.delete(key);
    }
  }

  /** Test/diagnostic accessor. */
  size(): number {
    return this.entries.size;
  }
}
