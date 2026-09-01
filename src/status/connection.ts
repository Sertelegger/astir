/**
 * VIEW-02 — connection state, as a thing the view must SAY rather than infer.
 *
 * The requirement singles out two states that a naive client renders
 * identically: a session that finished, and a daemon that cannot be reached.
 * Both stop producing frames. Conflating them is the same class of lie as a menu
 * bar showing a dead daemon as "idle" — the view looks calm and means nothing,
 * and the longer it stays calm the more it is trusted.
 *
 * So they are separate terminal-ness: `ended` is final and must NOT reconnect
 * (there is nothing to reconnect to, and retrying forever would make a finished
 * session look like a broken one), while `unreachable` retries with backoff and
 * says so, including when it will next try.
 *
 * A pure reducer so every transition is testable without a socket, a timer or a
 * browser.
 */

export type Connection =
  | { state: "connecting"; attempt: number }
  | { state: "live"; since: number }
  /** The session finished. Terminal: nothing will arrive, and that is correct. */
  | { state: "ended" }
  /** Contact lost. The session is probably still running; we stopped being told. */
  | { state: "unreachable"; attempt: number; retryInMs: number; detail: string }
  /**
   * The daemon answered, and does not have this session.
   *
   * Distinct from `unreachable` and terminal for the same reason `ended` is:
   * retrying cannot help. A session belongs to the daemon that ingested its
   * hooks, so asking a different one produces a 404 forever — and reporting
   * that as "daemon unreachable" blames the daemon for something that is not
   * wrong with it, which is the dishonesty this whole type exists to avoid.
   */
  | { state: "absent"; host: string | null };

export type ConnectionEvent =
  | { type: "open"; at: number }
  | { type: "end" }
  | { type: "lost"; detail: string }
  | { type: "absent"; host: string | null }
  | { type: "retry" };

/** First retry is nearly immediate; a daemon restart should not cost a reload. */
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

/**
 * Exponential, capped.
 *
 * Uncapped backoff means a view left open overnight is an hour behind by
 * morning while claiming to be retrying. The cap is what keeps "unreachable"
 * a temporary state rather than a permanent one.
 */
export function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1));
}

export const initialConnection: Connection = { state: "connecting", attempt: 1 };

export function nextConnection(current: Connection, event: ConnectionEvent): Connection {
  // Terminal states. A late error from a socket closing afterwards must not
  // resurrect the stream and start it retrying something that cannot succeed.
  if (current.state === "ended" || current.state === "absent") return current;

  switch (event.type) {
    case "open":
      return { state: "live", since: event.at };
    case "end":
      return { state: "ended" };
    case "absent":
      return { state: "absent", host: event.host };
    case "lost": {
      // Attempts count from the last SUCCESSFUL connection, so a stream that has
      // been live for hours retries promptly rather than inheriting the backoff
      // of whatever trouble it had at startup.
      const attempt = current.state === "live" ? 1 : current.attempt + 1;
      return {
        state: "unreachable",
        attempt,
        retryInMs: backoffMs(attempt),
        detail: event.detail,
      };
    }
    case "retry":
      return {
        state: "connecting",
        attempt: current.state === "unreachable" ? current.attempt : 1,
      };
  }
}

/** What the human is told. Short, and never optimistic about a failure. */
export function describeConnection(c: Connection): string {
  switch (c.state) {
    case "connecting":
      return c.attempt > 1 ? `Reconnecting (attempt ${c.attempt})…` : "Connecting…";
    case "live":
      return "Live";
    case "ended":
      return "Session ended";
    case "unreachable":
      return `Daemon unreachable — retrying in ${Math.round(c.retryInMs / 100) / 10}s`;
    case "absent":
      return c.host === null
        ? "This daemon does not have that session"
        : `That session runs on ${c.host}, not here`;
  }
}
