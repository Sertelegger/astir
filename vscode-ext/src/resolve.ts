import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface WorkspaceRelay { sessionId: string; provider: string; port: number; token: string; cwd: string; startedAt: number; }

/** Find the most-recent LIVE relay whose discovery cwd matches the workspace (REQ-080 tiebreaker). */
export function resolveWorkspaceRelay(workspaceCwd: string, sessionsDir = join(homedir(), ".clide", "sessions")): WorkspaceRelay | null {
  let files: string[];
  try { files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json")); } catch { return null; }
  const matches: WorkspaceRelay[] = [];
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(sessionsDir, f), "utf8")) as Record<string, unknown>;
      if (r.cwd === workspaceCwd && r.state === "live" && typeof r.port === "number" && typeof r.token === "string" && typeof r.sessionId === "string") {
        matches.push({ sessionId: r.sessionId, provider: String(r.provider ?? "claude"), port: r.port, token: r.token, cwd: workspaceCwd, startedAt: typeof r.startedAt === "number" ? r.startedAt : 0 });
      }
    } catch { /* skip unreadable */ }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.startedAt - a.startedAt);
  return matches[0]!;
}
