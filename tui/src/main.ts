/* c8 ignore start */
/**
 * clide-tui live entry point.
 * Long-lived SSE loop + terminal renderer — human-verified against a live relay.
 * HUMAN-BLOCKED: run `CLIDE_SESSION_ID=<id> clide-tui` against a running relay to verify.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SseReader } from "./sse.js";
import { reduce, emptyState, type TuiState } from "./store.js";
import { renderTree, renderRail } from "./render.js";
import { detectColorMode } from "./color.js";
import type { Frame } from "./protocol.js";

interface SessionFile { port: number; token: string; }

async function resolveSession(sessionId: string): Promise<SessionFile> {
  const p = join(homedir(), ".clide", "sessions", `${sessionId}.json`);
  const raw = await readFile(p, "utf8");
  return JSON.parse(raw) as SessionFile;
}

export async function runTui(): Promise<void> {
  const sessionId = process.env["CLIDE_SESSION_ID"] ?? process.argv[2];
  if (!sessionId) { console.error("Usage: clide-tui <session-id>  or  CLIDE_SESSION_ID=<id> clide-tui"); process.exit(1); }

  const session = await resolveSession(sessionId);
  const url = `http://127.0.0.1:${session.port}/stream`;
  const mode = detectColorMode(process.env as Record<string, string | undefined>);

  let state: TuiState = emptyState();

  const reader = new SseReader({
    url,
    token: session.token,
    onFrame: (frame: Frame) => {
      state = reduce(state, frame);
      if (state.tree) {
        process.stdout.write("\x1b[2J\x1b[H"); // clear screen
        process.stdout.write(renderTree(state.tree, state.maxLeafHeat, mode));
        process.stdout.write("\n\n");
        process.stdout.write(renderRail(state.agents));
        process.stdout.write("\n");
      }
    },
  });

  reader.start();
}

// CLI entry
await runTui();
/* c8 ignore stop */
