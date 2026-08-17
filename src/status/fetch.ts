/** Shared daemon query for the `status` and `menubar` surfaces. */

import { readTokenIfPresent } from "../config/paths.js";
import type { StatusBody, StatusResult } from "./types.js";

/**
 * Never throws. Every failure becomes a `reason` a surface can display, because
 * a silent failure here reads as "nothing is happening" — which is exactly the
 * lie this project exists downstream of.
 */
export async function fetchStatus(port: number, timeoutMs = 3_000): Promise<StatusResult> {
  const token = process.env.CLIDE_TOKEN ?? readTokenIfPresent();
  if (token === null) return { ok: false, reason: "no token — run `clide install`" };

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
  acknowledged: boolean;
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
): Promise<{ agents: RemoteAgentView[] } | null> {
  const token = process.env.CLIDE_NOTIFY_TOKEN ?? process.env.CLIDE_TOKEN ?? readTokenIfPresent();
  if (token === null) return null;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/state`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { agents?: RemoteAgentView[] };
    return { agents: body.agents ?? [] };
  } catch {
    return null;
  }
}
