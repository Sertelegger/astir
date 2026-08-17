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
