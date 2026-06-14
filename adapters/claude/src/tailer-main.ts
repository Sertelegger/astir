/* c8 ignore start — long-lived process loop; verified in a live session */
import { existsSync, openSync, readSync, closeSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { tailStep } from "./tailer.js";
import { resolveRelay, postReasoning } from "./relay-io.js";

const POLL_MS = 500;

/** Derive the Claude transcript path from cwd + sessionId. Returns null if not found. */
async function findTranscript(sessionId: string, cwd: string): Promise<string | null> {
  const home = homedir();
  // Claude encodes cwd by replacing '/' and '.' with '-'
  const encoded = cwd.replace(/[/.]/g, "-");
  const candidate = join(home, ".claude", "projects", encoded, `${sessionId}.jsonl`);
  if (existsSync(candidate)) return candidate;
  // fallback: scan all project dirs
  const projectsDir = join(home, ".claude", "projects");
  if (!existsSync(projectsDir)) return null;
  try {
    const dirs = await readdir(projectsDir);
    for (const dir of dirs) {
      const p = join(projectsDir, dir, `${sessionId}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch { /* best effort */ }
  return null;
}

function discoveryPath(sessionId: string): string {
  return join(homedir(), ".clide", "sessions", `${sessionId}.json`);
}

async function runTailer(): Promise<void> {
  const sessionId = process.env.CLIDE_SESSION_ID ?? "";
  const cwd = process.env.CLIDE_CWD ?? process.cwd();
  if (!sessionId) return;

  // Wait up to 10s for transcript to appear
  let transcriptPath: string | null = null;
  for (let i = 0; i < 20 && transcriptPath === null; i++) {
    transcriptPath = await findTranscript(sessionId, cwd);
    if (transcriptPath === null) await new Promise(r => setTimeout(r, POLL_MS));
  }
  if (transcriptPath === null) return;

  // Start from EOF
  const fd = openSync(transcriptPath, "r");
  let offset: number;
  try {
    const { size } = await import("node:fs/promises").then(m => m.stat(transcriptPath!));
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
