import { describe, expect, it } from "vitest";
import { Coalescer } from "../src/status/coalesce.js";
import {
  backoffMs,
  type Connection,
  describeConnection,
  initialConnection,
  nextConnection,
} from "../src/status/connection.js";

const drive = (start: Connection, ...events: Parameters<typeof nextConnection>[1][]) =>
  events.reduce(nextConnection, start);

describe("VIEW-02 — ended and unreachable are different states", () => {
  it("distinguishes a finished session from a lost daemon", () => {
    // The requirement exists because a naive client renders both as "no frames
    // are arriving", and one of them means everything is fine.
    expect(drive(initialConnection, { type: "open", at: 0 }, { type: "end" }).state).toBe("ended");
    expect(drive(initialConnection, { type: "open", at: 0 }, { type: "lost", detail: "socket" }).state).toBe(
      "unreachable",
    );
  });

  it("says something different about each, in words", () => {
    const ended = describeConnection({ state: "ended" });
    const gone = describeConnection({
      state: "unreachable",
      attempt: 1,
      retryInMs: 500,
      detail: "socket",
    });
    expect(ended).not.toBe(gone);
    expect(ended.toLowerCase()).toContain("ended");
    expect(gone.toLowerCase()).toContain("unreachable");
  });

  it("never leaves `ended`, however much noise follows", () => {
    // A socket closing after the end frame arrives is normal and must not make
    // a finished session start retrying as though it had broken.
    const ended = drive(initialConnection, { type: "end" });
    expect(drive(ended, { type: "lost", detail: "socket" })).toBe(ended);
    expect(drive(ended, { type: "retry" })).toBe(ended);
    expect(drive(ended, { type: "open", at: 5 })).toBe(ended);
  });
});

describe("reconnection backs off, but not forever", () => {
  it("grows the delay while failures continue", () => {
    let c = initialConnection;
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      c = nextConnection(c, { type: "lost", detail: "refused" });
      if (c.state === "unreachable") delays.push(c.retryInMs);
      c = nextConnection(c, { type: "retry" });
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
  });

  it("caps the delay so an overnight view is not an hour behind by morning", () => {
    expect(backoffMs(50)).toBe(backoffMs(6));
    expect(backoffMs(1000)).toBeLessThanOrEqual(15_000);
  });

  it("resets the backoff after a successful connection", () => {
    // A stream live for hours that blips must retry promptly, not inherit the
    // backoff of whatever trouble it had at startup.
    let c: Connection = { state: "unreachable", attempt: 6, retryInMs: 15_000, detail: "x" };
    c = drive(c, { type: "retry" }, { type: "open", at: 1 }, { type: "lost", detail: "blip" });

    expect(c.state).toBe("unreachable");
    if (c.state === "unreachable") expect(c.retryInMs).toBe(backoffMs(1));
  });

  it("counts attempts in what it tells the human", () => {
    const c = drive(initialConnection, { type: "lost", detail: "x" }, { type: "retry" });
    expect(describeConnection(c)).toContain("attempt 2");
  });
});

/* ── VIEW-03 ─────────────────────────────────────────────────────────────── */

function harness(startHidden = false) {
  const queue: Array<() => void> = [];
  let hidden = startHidden;
  const rendered: number[] = [];
  const c = new Coalescer<number>(
    {
      schedule: (cb) => queue.push(cb),
      cancel: () => queue.splice(0),
      hidden: () => hidden,
    },
    (v) => rendered.push(v),
  );
  return {
    c,
    rendered,
    frame: () => {
      for (const cb of queue.splice(0)) cb();
    },
    scheduled: () => queue.length,
    show: () => {
      hidden = false;
    },
    hide: () => {
      hidden = true;
    },
  };
}

describe("VIEW-03 — one render per animation frame", () => {
  it("collapses a burst into a single render of the NEWEST state", () => {
    // Not the oldest, and not all of them. Rendering an intermediate state and
    // stopping there is the bug this shape exists to prevent.
    const h = harness();
    h.c.push(1);
    h.c.push(2);
    h.c.push(3);

    expect(h.rendered).toEqual([]);
    h.frame();
    expect(h.rendered).toEqual([3]);
  });

  it("renders again on the next frame, rather than latching", () => {
    const h = harness();
    h.c.push(1);
    h.frame();
    h.c.push(2);
    h.frame();
    expect(h.rendered).toEqual([1, 2]);
  });

  it("does nothing on a frame with no new state", () => {
    const h = harness();
    h.c.push(1);
    h.frame();
    h.frame();
    h.frame();
    expect(h.rendered).toEqual([1]);
  });
});

describe("VIEW-03 — hidden documents do not render", () => {
  it("schedules nothing at all while hidden", () => {
    const h = harness(true);
    h.c.push(1);
    h.c.push(2);
    expect(h.scheduled()).toBe(0);
    expect(h.rendered).toEqual([]);
  });

  it("shows the newest state when the tab comes back", () => {
    // Without this a session that went quiet while hidden would show stale data
    // until it happened to change again — which for an idle session is never.
    const h = harness(true);
    h.c.push(1);
    h.c.push(2);

    h.show();
    h.c.resume();
    h.frame();

    expect(h.rendered).toEqual([2]);
  });

  it("stays quiet on resume when nothing is owed", () => {
    const h = harness(true);
    h.show();
    h.c.resume();
    h.frame();
    expect(h.rendered).toEqual([]);
  });

  it("reports whether a render is owed", () => {
    const h = harness(true);
    expect(h.c.pending).toBe(false);
    h.c.push(1);
    expect(h.c.pending).toBe(true);
    h.show();
    h.c.resume();
    h.frame();
    expect(h.c.pending).toBe(false);
  });

  it("drops everything once stopped, so a torn-down view cannot render", () => {
    const h = harness();
    h.c.push(1);
    h.c.stop();
    h.frame();
    h.c.push(2);
    h.frame();
    expect(h.rendered).toEqual([]);
  });
});
