import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ClideEvent } from "./contract.js";

export interface RelayRef { port: number; token: string; }

export function resolveRelay(sessionId: string, home = homedir()): RelayRef | null {
  const path = join(home, ".clide", "sessions", `${sessionId}.json`);
  if (!existsSync(path)) return null;
  try {
    const rec = JSON.parse(readFileSync(path, "utf8")) as { port?: number; token?: string };
    if (typeof rec.port === "number" && typeof rec.token === "string") return { port: rec.port, token: rec.token };
  } catch { /* fall through */ }
  return null;
}

async function post(relay: RelayRef, path: string, body: unknown, fetchImpl: typeof fetch, timeoutMs: number): Promise<void> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetchImpl(`http://127.0.0.1:${relay.port}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: ctrl.signal,
    });
  } finally { clearTimeout(t); }
}

export function postEvent(relay: RelayRef, event: ClideEvent, fetchImpl: typeof fetch = fetch, timeoutMs = 200): Promise<void> {
  return post(relay, "/events", event, fetchImpl, timeoutMs);
}
export function postReasoning(relay: RelayRef, agentId: string, ts: number, text: string, fetchImpl: typeof fetch = fetch, timeoutMs = 200): Promise<void> {
  return post(relay, "/reasoning", { agentId, ts, text }, fetchImpl, timeoutMs);
}
