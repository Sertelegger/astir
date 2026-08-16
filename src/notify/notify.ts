/**
 * PSH-01/PSH-09 — raise an OS notification. Doorbell, not payload.
 *
 * Deliberately shells out per platform rather than taking a dependency:
 * `node-notifier` is three years stale and bundles a nine-year-stale binary,
 * and Claude Code itself uses bare `osascript`.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export interface Notification {
  title: string;
  body: string;
}

export type Notifier = (n: Notification) => void;

/** WSL is Linux with Windows interop available; it needs the Windows path. */
function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return existsSync("/proc/sys/fs/binfmt_misc/WSLInterop") || Boolean(process.env.WSL_DISTRO_NAME);
  } catch {
    return false;
  }
}

/** Strip characters that would terminate the AppleScript string literal. */
function forAppleScript(s: string): string {
  return s.replace(/["\\]/g, " ").slice(0, 200);
}

export function createNotifier(): Notifier {
  const run = (cmd: string, args: string[]): void => {
    // Fire and forget. A notifier that throws must never reach ingest.
    execFile(cmd, args, () => undefined);
  };

  if (process.platform === "darwin") {
    return ({ title, body }) => {
      const script = `display notification "${forAppleScript(body)}" with title "${forAppleScript(title)}"`;
      run("osascript", ["-e", script]);
    };
  }

  if (isWsl()) {
    return ({ title, body }) => {
      run("powershell.exe", [
        "-NoProfile",
        "-Command",
        `New-BurntToastNotification -Text ${JSON.stringify(title)},${JSON.stringify(body)}`,
      ]);
    };
  }

  if (process.platform === "linux") {
    return ({ title, body }) => run("notify-send", ["-u", "critical", "-a", "clide", title, body]);
  }

  if (process.platform === "win32") {
    return ({ title, body }) => {
      run("powershell.exe", [
        "-NoProfile",
        "-Command",
        `New-BurntToastNotification -Text ${JSON.stringify(title)},${JSON.stringify(body)}`,
      ]);
    };
  }

  return () => undefined;
}
