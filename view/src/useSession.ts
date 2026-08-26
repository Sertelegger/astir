import { useEffect, useRef, useState } from "react";
import { Coalescer } from "../../src/status/coalesce";
import {
  type Connection,
  type ConnectionEvent,
  initialConnection,
  nextConnection,
} from "../../src/status/connection";
import { applyDelta, type Delta, type Snapshot } from "../../src/status/frames";
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
export function useSession(token: string, sessionId: string | null): SessionView {
  const [view, setView] = useState<SessionView>({
    snapshot: null,
    receivedAt: 0,
    connection: initialConnection,
  });
  // Kept in a ref as well so the reader loop never renders against a stale
  // closure, which is how a reconnect ends up applying deltas to the snapshot
  // from before it.
  const base = useRef<Snapshot | null>(null);

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
          if (!res.ok || res.body === null) {
            throw new Error(res.status === 401 ? "not authorised" : `daemon replied ${res.status}`);
          }
          advance({ type: "open", at: Date.now() });

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
              // `applyDelta` itself drops a frame whose session id does not
              // match, so a crossed stream cannot silently merge two repos.
              publish(applyDelta(base.current, JSON.parse(message.data) as Delta));
            }
          }
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
  }, [token, sessionId]);

  return view;
}

export interface SessionChoice {
  sessionId: string;
  name: string | null;
  cwd: string;
  status: string | null;
  touched: number;
}

/** The list behind the session picker. VIEW-08's full switcher is still open. */
export function useSessionList(token: string): SessionChoice[] {
  const [sessions, setSessions] = useState<SessionChoice[]>([]);

  useEffect(() => {
    const abort = new AbortController();
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch("/state", {
          headers: authHeaders(token),
          signal: abort.signal,
        });
        if (!res.ok) return;
        const body = (await res.json()) as {
          sessions?: Array<{
            sessionId: string;
            name: string | null;
            cwd: string;
            status: string | null;
            files?: { touched: number };
          }>;
        };
        setSessions(
          (body.sessions ?? []).map((s) => ({
            sessionId: s.sessionId,
            name: s.name,
            cwd: s.cwd,
            status: s.status,
            touched: s.files?.touched ?? 0,
          })),
        );
      } catch {
        // The stream is what reports connection trouble; this poll staying quiet
        // avoids two surfaces arguing about the same fact.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 4000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [token]);

  return sessions;
}
