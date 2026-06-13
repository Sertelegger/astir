import { spawn } from "node:child_process";
/* c8 ignore start — spawns an external viewer; verified manually (REQ-073) */
/** Launch a non-VSCode markdown viewer (e.g. `glow`) detached, once per created spec. Failures are ignored. */
export function launchViewer(viewerCommand: string, absPath: string): void {
  if (!viewerCommand) return;
  try {
    const [cmd, ...args] = viewerCommand.split(" ");
    if (!cmd) return;
    const child = spawn(cmd, [...args, absPath], { detached: true, stdio: "ignore" });
    child.on("error", () => { /* viewer missing — ignore */ });
    child.unref();
  } catch { /* never throw */ }
}
/* c8 ignore stop */
