/**
 * PSH-01/PSH-09/PSH-13 — raise an OS notification. Doorbell, not payload.
 *
 * Deliberately shells out per platform rather than taking a dependency:
 * `node-notifier` is three years stale and bundles a nine-year-stale binary,
 * and Claude Code itself uses bare `osascript`.
 *
 * On macOS there is a catch that bare `osascript` cannot solve. A notification
 * posted by `display notification` does not belong to the posting script — it
 * belongs to **Script Editor** (`com.apple.ScriptEditor2`), because that is the
 * bundle hosting the AppleScript. Clicking it therefore launches Script Editor,
 * which is both useless and alarming. The same limitation means such a
 * notification cannot carry a click action, cannot be replaced by a later one,
 * and cannot be removed programmatically — so a reminder every minute stacks up
 * a column of identical banners that only the user can clear by hand.
 *
 * `terminal-notifier` fixes all four, so it is used when present and the plain
 * path remains as an honest fallback that says what it cannot do.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export interface Notification {
  title: string;
  body: string;
  /**
   * Replace-key. Successive reminders about the same agent should update one
   * banner rather than pile up, and this is what lets a resolution remove it.
   */
  group?: string;
  /** Command run when the notification is clicked. */
  onClick?: { command: string; args: string[] };
}

export type Notifier = (n: Notification) => void;

export interface NotifierBackend {
  notify: Notifier;
  /** Remove an outstanding notification, where the platform allows it. */
  remove: (group: string) => void;
  /** What `doctor` reports, so a missing capability is stated rather than guessed. */
  capabilities: { click: boolean; replace: boolean; remove: boolean };
  name: string;
}

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

function which(cmd: string): string | null {
  for (const dir of [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    `${process.env.HOME ?? ""}/.local/bin`,
  ]) {
    const path = `${dir}/${cmd}`;
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Quote for `terminal-notifier -execute`, which hands the string to a shell.
 * Single quotes with the standard `'\''` escape: nothing inside can be
 * interpreted, so a repo or session name can never become a command.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function createNotifierBackend(): NotifierBackend {
  const run = (cmd: string, args: string[]): void => {
    // Fire and forget. A notifier that throws must never reach ingest.
    execFile(cmd, args, () => undefined);
  };

  if (process.platform === "darwin") {
    const tn = which("terminal-notifier");
    if (tn !== null) {
      return {
        name: "terminal-notifier",
        capabilities: { click: true, replace: true, remove: true },
        notify: ({ title, body, group, onClick }) => {
          const args = ["-title", title, "-message", body];
          if (group !== undefined) args.push("-group", group);
          if (onClick !== undefined) {
            const cmd = [onClick.command, ...onClick.args].map(shellQuote).join(" ");
            args.push("-execute", cmd);
          }
          run(tn, args);
        },
        remove: (group) => run(tn, ["-remove", group]),
      };
    }

    return {
      name: "osascript",
      // Stated, not assumed: everything downstream that offers a click action or
      // a dismissal needs to know it will not work here.
      capabilities: { click: false, replace: false, remove: false },
      notify: ({ title, body }) => {
        const script = `display notification "${forAppleScript(body)}" with title "${forAppleScript(title)}"`;
        run("osascript", ["-e", script]);
      },
      remove: () => undefined,
    };
  }

  if (isWsl() || process.platform === "win32") {
    return {
      name: "burnt-toast",
      capabilities: { click: false, replace: false, remove: false },
      notify: ({ title, body }) =>
        run("powershell.exe", [
          "-NoProfile",
          "-Command",
          `New-BurntToastNotification -Text ${JSON.stringify(title)},${JSON.stringify(body)}`,
        ]),
      remove: () => undefined,
    };
  }

  if (process.platform === "linux") {
    return {
      name: "notify-send",
      // `notify-send` replaces by hint, but not portably across every daemon.
      capabilities: { click: false, replace: false, remove: false },
      notify: ({ title, body }) => run("notify-send", ["-u", "critical", "-a", "astir", title, body]),
      remove: () => undefined,
    };
  }

  return {
    name: "none",
    capabilities: { click: false, replace: false, remove: false },
    notify: () => undefined,
    remove: () => undefined,
  };
}

/** Back-compatible shorthand for callers that only need to post a notification. */
export function createNotifier(): Notifier {
  return createNotifierBackend().notify;
}

/**
 * Wrap a bare notify function as a backend, for tests and for callers that only
 * care that something was raised. Declares no capabilities, so nothing downstream
 * will attach a click action it cannot honour.
 */
export function backendFromNotifier(notify: Notifier, name = "custom"): NotifierBackend {
  return {
    name,
    notify,
    remove: () => undefined,
    capabilities: { click: false, replace: false, remove: false },
  };
}
