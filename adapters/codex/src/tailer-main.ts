/* c8 ignore start — long-lived process loop; verified in a live session */
import { existsSync, openSync, readSync, closeSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { tailStep } from "./tailer.js";
import { resolveRelay, postReasoning } from "./relay-io.js";

const POLL_MS = 500;

/** Find the newest rollout-*.jsonl under ~/.codex/sessions/&#42;&#42;/ */
async function findNewestRollout(): Promise<string | null> {
  const sessionsDir = join(homedir(), ".codex", "sessions");
  if (!existsSync(sessionsDir)) return null;
  let newest: { path: string; mtime: number } | null = null;
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subdir = join(sessionsDir, entry.name);
      let files: string[];
      try { files = await readdir(subdir); } catch { continue; }
      for (const f of files) {
        if (!f.startsWith("rollout-") || !f.endsWith(".jsonl")) continue;
        const fp = join(subdir, f);
        try {
          const s = await stat(fp);
          if (newest === null || s.mtimeMs > newest.mtime) {
            newest = { path: fp, mtime: s.mtimeMs };
          }
        } catch { /* skip */ }
      }
    }
  } catch { return null; }
  return newest?.path ?? null;
}

function discoveryPath(sessionId: string): string {
  return join(homedir(), ".clide", "sessions", `${sessionId}.json`);
}

async function runTailer(): Promise<void> {
  const sessionId = process.env.CLIDE_SESSION_ID ?? "";
  if (!sessionId) return;

  // Wait up to 10s for a rollout file to appear
  let transcriptPath: string | null = null;
  for (let i = 0; i < 20 && transcriptPath === null; i++) {
    transcriptPath = await findNewestRollout();
    if (transcriptPath === null) await new Promise(r => setTimeout(r, POLL_MS));
  }
  if (transcriptPath === null) return;

  // Start from EOF
  const fd = openSync(transcriptPath, "r");
  let offset: number;
  try {
    const { size } = await stat(transcriptPath);
    offset = size;
  } catch {
    closeSync(fd);
    return;
  }

  let buf = "";
  const chunk = Buffer.alloc(65536);

  while (true) {
    // Exit if relay discovery file disappears
    if (!existsSync(discoveryPath(sessionId))) { closeSync(fd); return; }

    // Read new bytes
    let bytesRead: number;
    try {
      bytesRead = readSync(fd, chunk, 0, chunk.length, offset);
    } catch { closeSync(fd); return; }

    if (bytesRead > 0) {
      offset += bytesRead;
      buf += chunk.subarray(0, bytesRead).toString("utf8");
      const parts = buf.split("\n");
      buf = parts.pop() ?? ""; // keep partial line
      const lines = parts.filter(l => l.trim().length > 0);
      if (lines.length > 0) {
        const relay = resolveRelay(sessionId);
        if (relay) {
          const post = (agentId: string, ts: number, text: string) => postReasoning(relay, agentId, ts, text);
          try { await tailStep(lines, sessionId, Date.now() / 1000, post); } catch { /* drop */ }
        }
      }
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

runTailer().catch(() => { /* never surface errors */ });
/* c8 ignore stop */
