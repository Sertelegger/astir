/* c8 ignore start — spawns detached processes; verified in a live session */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER = "codex";

/** Resolve the built relay entry: env override, else relative to the plugin/repo layout. */
function relayEntry(): string {
  if (process.env.CLIDE_RELAY_ENTRY) return process.env.CLIDE_RELAY_ENTRY;
  const root = process.env.CLAUDE_PLUGIN_ROOT ?? join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
  return join(root, "relay", "dist", "relay", "main.js");
}
function tailerEntry(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return join(here, "tailer-main.js"); // built sibling of this file
}

/** Spawn the per-session relay (detached) and the reasoning tailer. Best-effort; never throws. */
export function spawnRelayAndTailer(sessionId: string, cwd: string): void {
  try {
    spawn(process.execPath, [relayEntry()], {
      detached: true, stdio: "ignore",
      env: { ...process.env, CLIDE_SESSION_ID: sessionId, CLIDE_PROVIDER: PROVIDER, CLIDE_CWD: cwd, CLIDE_SESSION_PID: String(process.ppid) },
    }).unref();
  } catch { /* never block the session */ }
  try {
    spawn(process.execPath, [tailerEntry()], {
      detached: true, stdio: "ignore",
      env: { ...process.env, CLIDE_SESSION_ID: sessionId, CLIDE_PROVIDER: PROVIDER, CLIDE_CWD: cwd },
    }).unref();
  } catch { /* never block */ }
}
/* c8 ignore stop */
