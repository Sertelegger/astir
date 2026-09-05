/** Shared daemon query for the `status` and `menubar` surfaces. */

import { hostname } from "node:os";
import { readTokenIfPresent } from "../config/paths.js";
import { sameHost } from "../notify/envelope.js";
import type { RemoteSession, StatusBody, StatusResult } from "./types.js";

/**
 * Never throws. Every failure becomes a `reason` a surface can display, because
 * a silent failure here reads as "nothing is happening" — which is exactly the
 * lie this project exists downstream of.
 */
export async function fetchStatus(port: number, timeoutMs = 3_000): Promise<StatusResult> {
  const token = process.env.ASTIR_TOKEN ?? readTokenIfPresent();
  if (token === null) return { ok: false, reason: "no token — run `astir install`" };

  try {
    const res = await fetch(`http://127.0.0.1:${port}/state`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) return { ok: false, reason: "token rejected — is it current?" };
    if (!res.ok) return { ok: false, reason: `daemon returned ${res.status}` };
    return { ok: true, body: (await res.json()) as StatusBody };
  } catch {
    return { ok: false, reason: `no daemon on 127.0.0.1:${port}` };
  }
}

/** One blocked agent on another machine, as the local notifier reports it. */
export interface RemoteAgentView {
  host: string;
  repo: string;
  sessionId: string;
  agentId: string;
  reason: string;
  since: number;
  lastSeen: number;
  acknowledged: boolean;
  stale?: boolean;
}

/**
 * PSH-12 — ask the local notifier what other machines are waiting on.
 *
 * Returns `null` when no notifier is running, which is the common case and not
 * an error: without one, there are simply no remote sessions to show.
 */
export async function fetchRemote(
  port: number,
  timeoutMs = 3_000,
  /**
   * This machine's name, for deciding what came from here. Injectable so a test
   * never has to derive a fixture from the real hostname — building one by
   * appending to `hostname()` produces a DIFFERENT host on Linux and the SAME
   * one on macOS, where the name carries a `.local` suffix and the comparison
   * is on the first label.
   */
  selfHost: string = hostname(),
): Promise<{ agents: RemoteAgentView[]; sessions: RemoteSession[] } | null> {
  const token = process.env.ASTIR_NOTIFY_TOKEN ?? process.env.ASTIR_TOKEN ?? readTokenIfPresent();
  if (token === null) return null;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/state`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { agents?: RemoteAgentView[]; sessions?: RemoteSession[] };
    // DMN-10 — `sessions` is absent from an older notifier, which is not an
    // error: it simply has nothing but doorbells to report.
    //
    // Anything this machine sent is dropped on the way back in. The notifier
    // refuses a roster from its own host, but that only protects a notifier
    // from the daemon beside it — and over `ssh -R` the notifier is on ANOTHER
    // machine, where our roster is legitimately remote and is stored. Polling
    // it on 127.0.0.1 then returns our own sessions, and every local one is
    // listed a second time under "Other machines" on the box displaying it.
    //
    // Both halves, not just sessions: a doorbell carries an origin host too and
    // is not origin-checked on the way in, so the blocked-agent list reflects
    // by the same route.
    return {
      agents: (body.agents ?? []).filter((a) => !sameHost(a.host, selfHost)),
      sessions: (body.sessions ?? []).filter((s) => !sameHost(s.host, selfHost)),
    };
  } catch {
    return null;
  }
}
