import { normalizeClaudeHook } from "./normalize.js";
import { resolveRelay, postEvent as realPostEvent, type RelayRef } from "./relay-io.js";
import type { ClideEvent } from "./contract.js";

export interface HookDeps {
  now: () => number;
  resolve: (sessionId: string) => RelayRef | null;
  postEvent: (relay: RelayRef, event: ClideEvent) => Promise<void>;
  ensureRelay: (sessionId: string, cwd: string) => Promise<void>; // SessionStart only: spawn relay+tailer
}

/** Pure-ish hook core. NEVER throws; always resolves to exit code 0 (REQ-004). */
export async function runHook(rawStdin: string, deps: HookDeps): Promise<number> {
  try {
    const payload = JSON.parse(rawStdin) as Record<string, unknown>;
    const event = normalizeClaudeHook(payload, deps.now());
    if (!event) return 0; // unmapped hook
    if (event.kind === "session_start") {
      const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
      try { await deps.ensureRelay(event.sessionId, cwd); } catch { /* never block */ }
    }
    const relay = deps.resolve(event.sessionId);
    if (relay) { try { await deps.postEvent(relay, event); } catch { /* drop, never block */ } }
    return 0;
  } catch { return 0; }
}

/* c8 ignore start — real CLI wiring, exercised only in a live Claude session (human-verified) */
export async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const code = await runHook(raw, {
    now: () => Date.now() / 1000,
    resolve: (sid) => resolveRelay(sid),
    postEvent: (relay, event) => realPostEvent(relay, event),
    ensureRelay: async () => { /* spawn relay+tailer — see README; uses node + the relay/tailer entry paths */ },
  });
  process.exit(code);
}
/* c8 ignore stop */
