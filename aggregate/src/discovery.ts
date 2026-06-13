import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface AggDiscovery { sessionId: string; provider: string; cwd: string; port: number; token: string; }

export function scanDiscovery(dir = join(homedir(), ".clide", "sessions")): AggDiscovery[] {
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out: AggDiscovery[] = [];
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
      if (r.state === "live" && typeof r.sessionId === "string" && typeof r.port === "number" && typeof r.token === "string") {
        out.push({ sessionId: r.sessionId, provider: String(r.provider ?? "claude"), cwd: String(r.cwd ?? ""), port: r.port, token: r.token });
      }
    } catch { /* skip */ }
  }
  return out;
}
