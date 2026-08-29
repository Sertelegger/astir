import { useEffect, useState } from "react";

/**
 * A clock that ticks, so durations on screen advance between frames.
 *
 * The daemon sends `inStateMs` as of the moment a frame was built, and
 * `diffSnapshots` deliberately does NOT treat a changed `inStateMs` as worth a
 * frame — a timer that advances by itself would otherwise put every agent in
 * every delta and turn the whole sparse-delta design into a full snapshot once
 * a second.
 *
 * The consequence is that the client has to do the advancing. Without this the
 * view sits there labelled "Live" with a number frozen at whatever it was when
 * the last real change happened, which for an idle session is forever. That is
 * a worse lie than showing nothing, because the label vouches for it.
 *
 * One second, not an animation frame: this drives text like "4m 12s", and
 * sixty repaints a second to move a number once is a laptop fan for nothing.
 * Paused while the document is hidden, per VIEW-03, and resynced on return so
 * the first thing a returning tab shows is current rather than stale.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = (): void => {
      if (timer !== undefined) return;
      timer = setInterval(() => setNow(performance.now()), intervalMs);
    };
    const stop = (): void => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = (): void => {
      if (document.hidden) {
        stop();
        return;
      }
      setNow(performance.now()); // catch up before the next tick, not after it
      start();
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);

  return now;
}
