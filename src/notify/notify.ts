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

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";

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

/**
 * What became of one attempt to put a notification on screen.
 *
 * The reason is content-free (SEC-01): it names the binary and how it failed —
 * `notify-send failed (exit 1)` — and never the title or body it was given,
 * because it is repeated on the startup line, in `doctor` and in `/healthz`'s
 * consumers.
 */
export type NotifyOutcome = { ok: true } | { ok: false; reason: string };

/**
 * How long a notifier may take before it counts as failed. Every one astir
 * runs posts and exits in well under a second; one still running after five
 * is wedged on a bus or a prompt, and what it eventually shows is not news.
 *
 * No longer than the sending daemon waits for `astir notifier` to answer
 * (`REMOTE_TIMEOUT_MS`), which hears this verdict only once it is reached.
 */
export const NOTIFIER_TIMEOUT_MS = 5_000;

export interface NotifierBackend {
  /**
   * Show one, and say what became of it.
   *
   * #78, round two — it used to be fire-and-forget, so a `notify-send` that
   * ran, failed and exited 1 was a delivery. On a headless systemd host that
   * is every run: pam_systemd exports the session bus address to each SSH
   * shell and user service, the static check below passes, and nothing owns
   * org.freedesktop.Notifications to show anything.
   */
  notify: (n: Notification) => Promise<NotifyOutcome>;
  /**
   * Remove an outstanding notification, where the platform allows it. Fire
   * and forget: a withdrawal shows nothing, so whether it worked says nothing
   * about whether this machine can show one.
   */
  remove: (group: string) => void;
  /** What `doctor` reports, so a missing capability is stated rather than guessed. */
  capabilities: { click: boolean; replace: boolean; remove: boolean };
  name: string;
  /**
   * PSH-07 / #78 — can this backend put anything on a screen at all?
   *
   * Checked rather than assumed. The Linux path used to pick `notify-send`
   * unconditionally and fire it with a callback that swallowed the ENOENT, so
   * a container with no binary and no desktop reported `delivery paths: local`
   * and answered every doorbell with success. False here makes the local
   * target refuse to claim a delivery it cannot make.
   */
  available: boolean;
  /**
   * Why not, when `available` is false. Content-free — it names a missing
   * binary or a missing display, never anything about a session — so the
   * startup line and `doctor` can repeat it verbatim.
   */
  unavailableReason?: string;
}

/**
 * Everything `createNotifierBackend` reads from the machine, injectable so the
 * platform branches are testable without being on that platform (§9).
 */
export interface NotifierProbe {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** Does this path exist? Finds binaries and recognises WSL. */
  exists?: (path: string) => boolean;
  /**
   * How a command is spawned, and what became of it. Injected by tests, which
   * must never put a real notification in front of whoever runs them.
   */
  run?: (cmd: string, args: string[]) => Promise<NotifyOutcome>;
}

/**
 * The real runner: spawn, then watch. A non-zero exit, a spawn error, or no
 * exit within `timeoutMs` is a failure; a child still running at the deadline
 * is killed, since nothing it shows after that is worth showing and an
 * orphaned notifier per doorbell piles up behind a wedged bus.
 *
 * Built from the binary's name and the error code alone. Not the error's
 * message: for a spawned command that is `Command failed: notify-send … <title>
 * <body>`, which would carry the notification's text into every place the
 * reason is repeated.
 */
export function childRunner(
  timeoutMs = NOTIFIER_TIMEOUT_MS,
): (cmd: string, args: string[]) => Promise<NotifyOutcome> {
  return (cmd, args) =>
    new Promise((resolve) => {
      const name = basename(cmd);
      const couldNotStart = (err: unknown): NotifyOutcome => {
        const code = (err as { code?: unknown } | null)?.code;
        return {
          ok: false,
          reason: `${name} could not start${typeof code === "string" ? ` (${code})` : ""}`,
        };
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(cmd, args, { stdio: "ignore" });
      } catch (err) {
        // A synchronous spawn failure (a malformed argument) never reaches `error`.
        resolve(couldNotStart(err));
        return;
      }
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const settle = (outcome: NotifyOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      timer = setTimeout(() => {
        settle({ ok: false, reason: `${name} did not exit within ${timeoutMs / 1000} s` });
        child.kill("SIGKILL");
      }, timeoutMs);
      child.once("error", (err) => settle(couldNotStart(err)));
      child.once("exit", (code, signal) => {
        if (code === 0) settle({ ok: true });
        else if (code !== null) settle({ ok: false, reason: `${name} failed (exit ${code})` });
        else settle({ ok: false, reason: `${name} was killed (${signal ?? "by a signal"})` });
      });
    });
}

/** WSL is Linux with Windows interop available; it needs the Windows path. */
function isWsl(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean,
): boolean {
  if (platform !== "linux") return false;
  try {
    return exists("/proc/sys/fs/binfmt_misc/WSLInterop") || Boolean(env.WSL_DISTRO_NAME);
  } catch {
    return false;
  }
}

/**
 * Is there anything for `notify-send` to show a notification ON?
 *
 * It talks to a notification server over the session bus, and a desktop is
 * what provides both. In a container with neither, the binary runs, exits,
 * and nothing appears — so the binary alone proves nothing. An
 * exported-but-empty variable counts as unset: it is what a stripped
 * environment usually carries.
 *
 * Necessary, not sufficient, and only the first gate. On a systemd host
 * pam_systemd exports `DBUS_SESSION_BUS_ADDRESS` to every SSH login and user
 * service whether or not anything on that bus can show a notification — so a
 * headless server with libnotify-bin passes this and fails every run. The
 * run's own exit status is the second gate (`childRunner`).
 */
function hasDesktop(env: Record<string, string | undefined>): boolean {
  return ["DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY"].some((k) => (env[k] ?? "") !== "");
}

/** Strip characters that would terminate the AppleScript string literal. */
function forAppleScript(s: string): string {
  return s.replace(/["\\]/g, " ").slice(0, 200);
}

/**
 * Find a command. The fixed directories come first because a daemon started
 * by launchd or systemd gets a minimal PATH that omits Homebrew; PATH itself
 * follows, because a distribution that installs `notify-send` somewhere else
 * (NixOS, for one) must not read as "not installed".
 */
function which(
  cmd: string,
  env: Record<string, string | undefined> = process.env,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const fixed = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", `${env.HOME ?? ""}/.local/bin`];
  const onPath = (env.PATH ?? "").split(":").filter((d) => d !== "");
  for (const dir of [...fixed, ...onPath]) {
    const path = `${dir}/${cmd}`;
    if (exists(path)) return path;
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

export function createNotifierBackend(probe: NotifierProbe = {}): NotifierBackend {
  const platform = probe.platform ?? process.platform;
  const env = probe.env ?? process.env;
  const exists = probe.exists ?? existsSync;
  // Watched, not fired and forgotten — and never throwing, so a notifier that
  // fails still cannot reach ingest.
  const run = probe.run ?? childRunner();

  if (platform === "darwin") {
    const tn = which("terminal-notifier", env, exists);
    if (tn !== null) {
      return {
        name: "terminal-notifier",
        available: true,
        capabilities: { click: true, replace: true, remove: true },
        notify: ({ title, body, group, onClick }) => {
          const args = ["-title", title, "-message", body];
          if (group !== undefined) args.push("-group", group);
          if (onClick !== undefined) {
            const cmd = [onClick.command, ...onClick.args].map(shellQuote).join(" ");
            args.push("-execute", cmd);
          }
          return run(tn, args);
        },
        remove: (group) => void run(tn, ["-remove", group]),
      };
    }

    return {
      name: "osascript",
      // It ships with macOS, and this is the path the user's Mac has been
      // delivering through. Degraded is not dead.
      available: true,
      // Stated, not assumed: everything downstream that offers a click action or
      // a dismissal needs to know it will not work here.
      capabilities: { click: false, replace: false, remove: false },
      notify: ({ title, body }) => {
        const script = `display notification "${forAppleScript(body)}" with title "${forAppleScript(title)}"`;
        // Exits 0 whether or not the OS displayed it (A7), so only a failure
        // to run at all is learned here. Better than learning nothing.
        return run("osascript", ["-e", script]);
      },
      remove: () => undefined,
    };
  }

  if (isWsl(platform, env, exists) || platform === "win32") {
    return {
      name: "burnt-toast",
      // Unchanged: whether the BurntToast module is installed is a PowerShell
      // question with no cheap answer from here.
      available: true,
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

  if (platform === "linux") {
    // #78 — both, or nothing will appear. The binary is named first because
    // it is the first thing to fix: with it missing, a display changes nothing.
    const bin = which("notify-send", env, exists);
    const unavailableReason =
      bin === null ? "notify-send not found" : !hasDesktop(env) ? "no session bus or display" : undefined;
    return {
      name: "notify-send",
      available: unavailableReason === undefined,
      ...(unavailableReason === undefined ? {} : { unavailableReason }),
      // `notify-send` replaces by hint, but not portably across every daemon.
      capabilities: { click: false, replace: false, remove: false },
      // The path that was FOUND, not a bare name for the spawn to resolve
      // again against a PATH that may not contain it. Nothing at all when
      // dead, and a failure rather than silence: a spawn whose failure is
      // swallowed is how this lied in the first place.
      notify: ({ title, body }) =>
        bin !== null && unavailableReason === undefined
          ? run(bin, ["-u", "critical", "-a", "astir", title, body])
          : Promise.resolve({ ok: false, reason: unavailableReason ?? "notify-send unavailable" }),
      remove: () => undefined,
    };
  }

  return {
    name: "none",
    available: false,
    unavailableReason: "no notifier on this platform",
    capabilities: { click: false, replace: false, remove: false },
    notify: () => Promise.resolve({ ok: false, reason: "no notifier on this platform" }),
    remove: () => undefined,
  };
}

/** Back-compatible shorthand for callers that only need to post a notification. */
export function createNotifier(): Notifier {
  const backend = createNotifierBackend();
  return (n) => void backend.notify(n);
}

/**
 * Wrap a bare notify function as a backend, for tests and for callers that only
 * care that something was raised. Declares no capabilities, so nothing downstream
 * will attach a click action it cannot honour.
 *
 * Available, because a caller handing over a function is asserting it works —
 * which is also why anything that needs the TRUTH about this machine's local
 * path must use `createNotifierBackend` rather than wrapping `createNotifier`.
 */
export function backendFromNotifier(notify: Notifier, name = "custom"): NotifierBackend {
  return {
    name,
    notify: (n) => {
      notify(n);
      return Promise.resolve({ ok: true });
    },
    remove: () => undefined,
    available: true,
    capabilities: { click: false, replace: false, remove: false },
  };
}
