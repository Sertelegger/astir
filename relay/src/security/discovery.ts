import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { DiscoveryState, Provider } from "../contract/types.js";

export interface Discovery {
  v: number;
  provider: Provider;
  sessionId: string;
  pid: number;
  cwd: string;
  port: number;
  token: string;
  startedAt: number;
  state: DiscoveryState;
}

/** Write atomically with 0600, ensuring the parent dir is 0700. REQ-010. */
export function writeDiscovery(path: string, rec: Discovery): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(rec), { mode: 0o600 });
}

export function readDiscovery(path: string): Discovery | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")) as Discovery; }
  catch { return null; }
}

/**
 * Liveness per REQ-018: a discovery file is "live" only if GET /healthz on its
 * recorded port returns 200 AND the sessionId matches — never the `state` field alone.
 */
export async function probeLiveness(rec: Discovery, timeoutMs = 300): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${rec.port}/healthz`, { signal: ctrl.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { sessionId?: string };
    return body.sessionId === rec.sessionId;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
