import { useEffect, useRef, useState } from "react";
import { Coalescer } from "../../src/status/coalesce";
import {
  type Connection,
  type ConnectionEvent,
  initialConnection,
  nextConnection,
} from "../../src/status/connection";
import { applyDelta, type Delta, type Snapshot } from "../../src/status/frames";
import { type OverviewSession, overview } from "../../src/status/overview";
import type { StatusBody } from "../../src/status/types";
import { authHeaders } from "./credentials";
import { readSse } from "./sse";

export interface SessionView {
  snapshot: Snapshot | null;
  /** `performance.now()` when the newest frame landed, for local decay. */
  receivedAt: number;
  connection: Connection;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * Follow one session: connect, reduce frames, and hand React the newest state
 * at most once per animation frame.
 *
 * The reduce happens eagerly and the render lazily — see `Coalescer`. Skipping a
 * delta to save a render would corrupt the state, because a delta only means
 * anything applied to its predecessor.
 */
/**
 * `hostOf` lets the view say WHERE a session it cannot stream actually lives,
 * turning "not here" into "runs on megabrain-dev". Optional: without it the
 * message is still honest, just less useful.
 */
export function useSession(
  token: string,
  sessionId: string | null,
  hostOf?: (id: string) => string | null,
): SessionView {
  const [view, setView] = useState<SessionView>({
    snapshot: null,
    receivedAt: 0,
    connection: initialConnection,
  });
  // Kept in a ref as well so the reader loop never renders against a stale
  // closure, which is how a reconnect ends up applying deltas to the snapshot
  // from before it.
  const base = useRef<Snapshot | null>(null);
  const lookupHost = useRef(hostOf);
  lookupHost.current = hostOf;

  useEffect(() => {
    if (sessionId === null) return;
    const abort = new AbortController();
    let connection = initialConnection;
    base.current = null;

    const coalescer = new Coalescer<SessionView>(
      {
        schedule: (cb) => window.requestAnimationFrame(cb),
        cancel: (h) => window.cancelAnimationFrame(h),
        hidden: () => document.hidden,
      },
      setView,
    );
    const onVisible = () => coalescer.resume();
    document.addEventListener("visibilitychange", onVisible);

    const advance = (event: ConnectionEvent): void => {
      connection = nextConnection(connection, event);
      // Connection state is NOT coalesced. It is small, rare, and the one thing
      // that must never be a frame behind: a view still saying "Live" after the
      // daemon died is the exact dishonesty VIEW-02 exists to prevent.
      setView((v) => ({ ...v, connection }));
    };

    const publish = (snapshot: Snapshot): void => {
      base.current = snapshot;
      coalescer.push({ snapshot, receivedAt: performance.now(), connection });
    };

    const run = async (): Promise<void> => {
      while (!abort.signal.aborted) {
        try {
          const res = await fetch(`/stream?session=${encodeURIComponent(sessionId)}`, {
            headers: authHeaders(token),
            signal: abort.signal,
          });
          // A 404 is not a failure of the connection — the daemon answered, and
          // it simply does not own this session. Retrying cannot change that,
          // and calling it "unreachable" blames the daemon for something that
          // is not wrong with it.
          if (res.status === 404) {
            advance({ type: "absent", host: lookupHost.current?.(sessionId) ?? null });
            return;
          }
          if (!res.ok || res.body === null) {
            throw new Error(res.status === 401 ? "not authorised" : `daemon replied ${res.status}`);
          }
          advance({ type: "open", at: Date.now() });

          // Set when a `seq` gap means this connection's base can no longer be
          // trusted; reconnecting is the repair, not an error to report.
          let resync = false;
          for await (const message of readSse(res.body, abort.signal)) {
            if (message.event === "end") {
              advance({ type: "end" });
              return;
            }
            if (message.event === "snapshot") {
              publish(JSON.parse(message.data) as Snapshot);
              continue;
            }
            if (message.event === "delta" && base.current !== null) {
              const delta = JSON.parse(message.data) as Delta;
              // VIEW-02 — `seq` counts frames actually SENT, so consecutive
              // ones differ by exactly 1 and a jump means a frame was lost.
              // Applying the next delta anyway would merge it into a base that
              // never saw the missing one, and the map would then be wrong in a
              // way that never repairs itself: files are grow-only, so nothing
              // later removes a tile that should not be there, and the error is
              // invisible because a stale tile looks exactly like a real one.
              //
              // Re-opening is the whole repair. The daemon's opening message is
              // always a snapshot, so the cost is one reconnect and the result
              // is exact. Deliberately NOT routed through the catch below:
              // nothing is wrong with the connection, and reporting it as lost
              // would put a false error in front of the user.
              if (delta.seq !== base.current.seq + 1) {
                base.current = null;
                resync = true;
                break;
              }
              // `applyDelta` itself drops a frame whose session id does not
              // match, so a crossed stream cannot silently merge two repos.
              publish(applyDelta(base.current, delta));
            }
          }
          if (resync) continue;
          // The body ended without an `end` event: the daemon went away rather
          // than the session finishing. Those mean different things.
          throw new Error("stream closed");
        } catch (error) {
          if (abort.signal.aborted) return;
          advance({ type: "lost", detail: error instanceof Error ? error.message : "unknown" });
          const wait = connection.state === "unreachable" ? connection.retryInMs : 1000;
          await sleep(wait, abort.signal);
          if (abort.signal.aborted) return;
          advance({ type: "retry" });
        }
      }
    };

    void run();
    return () => {
      abort.abort();
      coalescer.stop();
      document.removeEventListener("visibilitychange", onVisible);
    };
    // `hostOf` is deliberately not a dependency: it is a lookup over data that
    // changes on every poll, and re-running the effect for it would tear the
    // stream down and rebuild it every few seconds.
  }, [token, sessionId]);

  return view;
}

export interface World {
  sessions: OverviewSession[];
  /** Files each session has touched, for choosing a default and labelling. */
  touched: Map<string, number>;
  /** `performance.now()` when the newest poll landed, for advancing durations. */
  receivedAt: number;
  /** False once a poll has failed — distinct from "nothing is running". */
  reachable: boolean;
}

/**
 * VIEW-08/09 — every session, polled.
 *
 * Polled rather than streamed, deliberately. `/state` is a small bounded
 * snapshot the menu bar already reads on a timer, and the set of sessions
 * changes on the scale of seconds — a session starting is a human action. A
 * second SSE channel would buy latency nobody can perceive and add a second
 * reconnect path to get wrong. The per-session map, where a delta lands many
 * times a second, is where streaming actually pays.
 */
export function useWorld(token: string, intervalMs = 2000): World {
  const [world, setWorld] = useState<World>({
    sessions: [],
    touched: new Map(),
    receivedAt: 0,
    reachable: true,
  });

  useEffect(() => {
    const abort = new AbortController();
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch("/state", { headers: authHeaders(token), signal: abort.signal });
        if (!res.ok) throw new Error(`daemon replied ${res.status}`);
        const body = (await res.json()) as StatusBody;
        setWorld({
          sessions: overview(body),
          touched: new Map((body.sessions ?? []).map((s) => [s.sessionId, s.files?.touched ?? 0] as const)),
          receivedAt: performance.now(),
          reachable: true,
        });
      } catch {
        if (abort.signal.aborted) return;
        // Reported rather than swallowed: "no sessions" and "cannot ask" look
        // identical on screen unless one of them says so.
        setWorld((w) => ({ ...w, reachable: false }));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), intervalMs);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [token, intervalMs]);

  return world;
}
