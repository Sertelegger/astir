/**
 * VIEW-03 — at most one render per animation frame, and none while hidden.
 *
 * Two distinct problems, both of which a naive `setState` per frame gets wrong:
 *
 * 1. **Bursts.** A busy session can produce several frames inside one animation
 *    frame. Rendering each is work the display cannot show, and it is worst
 *    exactly when the session is busiest — the moment the view most needs to
 *    stay responsive.
 *
 * 2. **Hidden tabs.** A backgrounded view that keeps rendering burns a laptop's
 *    battery to draw pixels nobody is looking at. Browsers already throttle
 *    `requestAnimationFrame` in hidden tabs, but they do not stop the reduce
 *    work behind it, and throttling is not a guarantee.
 *
 * The distinction that makes this correct: frames are REDUCED eagerly and
 * RENDERED lazily. Every delta is folded into the working state the instant it
 * arrives — skipping one would corrupt the state, because a delta only makes
 * sense applied to its predecessor. What is coalesced is the render, and only
 * the newest state is ever handed over.
 *
 * Dependencies are injected so all of this is testable in Node with no browser.
 */

export interface CoalesceDeps {
  /** `requestAnimationFrame`. */
  schedule: (cb: () => void) => number;
  /** `cancelAnimationFrame`. */
  cancel: (handle: number) => void;
  /** `() => document.hidden`. */
  hidden: () => boolean;
}

export class Coalescer<T> {
  private latest: { value: T } | null = null;
  private handle: number | null = null;
  private stopped = false;

  constructor(
    private readonly deps: CoalesceDeps,
    private readonly render: (value: T) => void,
  ) {}

  /** Hand over the newest state. Renders at most once per animation frame. */
  push(value: T): void {
    if (this.stopped) return;
    this.latest = { value };
    this.arm();
  }

  /**
   * Call on `visibilitychange`.
   *
   * A view that was hidden mid-burst has state waiting; showing it must render
   * that immediately rather than wait for the next frame to arrive, or a session
   * that went quiet while the tab was hidden would show stale data indefinitely.
   */
  resume(): void {
    if (this.stopped) return;
    this.arm();
  }

  private arm(): void {
    if (this.handle !== null || this.latest === null || this.deps.hidden()) return;
    this.handle = this.deps.schedule(() => {
      this.handle = null;
      const pending = this.latest;
      this.latest = null;
      if (pending !== null && !this.stopped) this.render(pending.value);
    });
  }

  /** True while a render is owed — state has arrived that has not been drawn. */
  get pending(): boolean {
    return this.latest !== null;
  }

  stop(): void {
    this.stopped = true;
    if (this.handle !== null) this.deps.cancel(this.handle);
    this.handle = null;
    this.latest = null;
  }
}
