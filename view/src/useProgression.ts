/**
 * VIEW-11 — the session's shape over time, fetched rather than streamed.
 *
 * A progression is the whole session, so streaming it would resend the past on
 * every tick when what actually changed is one appended step. `/progression`
 * serves it on request; this hook asks once per session and again only when
 * told to.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Progression } from "../../src/model/map";
import { authHeaders } from "./credentials";

export type ProgressionState =
  | { status: "loading" }
  | { status: "ready"; progression: Progression }
  /**
   * The daemon answered and does not have this session.
   *
   * Every REMOTE session lands here: the registry holds only what reached this
   * daemon. Distinct from an error because retrying cannot help — and distinct
   * from an empty progression, which would say the session did nothing rather
   * than that we asked the wrong machine.
   */
  | { status: "elsewhere" }
  | { status: "failed"; detail: string };

export function useProgression(
  token: string,
  sessionId: string | null,
  /** False while the panel is hidden — fetching for a panel nobody opened is waste. */
  active: boolean,
): { state: ProgressionState; refresh: () => void } {
  const [state, setState] = useState<ProgressionState>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  // So a slow response for a session you have since navigated away from cannot
  // land on top of the one you are looking at now.
  const wanted = useRef<string | null>(null);

  // `nonce` is never read inside this effect — bumping it IS how `refresh()`
  // re-runs it. Dropping it from the deps would silently make the refresh
  // button inert, which is the worst outcome available: a control that looks
  // live and does nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (sessionId === null || !active) return;
    wanted.current = sessionId;
    const abort = new AbortController();
    setState({ status: "loading" });

    void (async () => {
      try {
        const res = await fetch(`/progression?session=${encodeURIComponent(sessionId)}`, {
          headers: authHeaders(token),
          signal: abort.signal,
        });
        if (wanted.current !== sessionId) return;
        if (res.status === 404) return setState({ status: "elsewhere" });
        if (!res.ok) return setState({ status: "failed", detail: `daemon replied ${res.status}` });
        setState({ status: "ready", progression: (await res.json()) as Progression });
      } catch (error) {
        if (abort.signal.aborted) return;
        setState({ status: "failed", detail: error instanceof Error ? error.message : "unknown" });
      }
    })();

    return () => abort.abort();
  }, [token, sessionId, active, nonce]);

  return { state, refresh };
}

/**
 * Prefix-sum the deltas into cumulative totals, one entry per step.
 *
 * The wire carries deltas because cumulative totals re-inflate a long session
 * into tens of thousands of entries. This is the other half of that trade, and
 * it is the cheap half: the same arithmetic the daemon would have done, against
 * a payload a fraction of the size.
 */
export function cumulative(p: Progression): Array<Record<string, number>> {
  const running = new Map<string, number>();
  return p.steps.map((step) => {
    for (const [path, n] of Object.entries(step.delta)) {
      running.set(path, (running.get(path) ?? 0) + n);
    }
    return Object.fromEntries(running);
  });
}
