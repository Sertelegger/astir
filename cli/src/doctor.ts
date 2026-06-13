import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export type LiveProbe = (rec: { sessionId?: string; port?: number }) => boolean;

/** Discovery files whose relay is not live per the injected probe (REQ-018/094). */
export function findStale(sessionsDir: string, isLive: LiveProbe): string[] {
  let files: string[];
  try { files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json")); } catch { return []; }
  const stale: string[] = [];
  for (const f of files) {
    const path = join(sessionsDir, f);
    try {
      const rec = JSON.parse(readFileSync(path, "utf8")) as { sessionId?: string; port?: number };
      if (!isLive(rec)) stale.push(path);
    } catch { stale.push(path); } // unreadable → stale
  }
  return stale;
}

/** Remove stale discovery files. (Logs cleanup is handled by the c8-ignored CLI entry.) */
export function cleanStale(sessionsDir: string, isLive: LiveProbe): string[] {
  const stale = findStale(sessionsDir, isLive);
  for (const p of stale) { try { rmSync(p, { force: true }); } catch { /* ignore */ } }
  return stale;
}
