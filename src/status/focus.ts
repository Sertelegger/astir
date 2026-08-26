/**
 * PSH-11 — take me to the session that needs me.
 *
 * A notification that tells you an agent is blocked but not *where* still leaves
 * you hunting across desktops, tabs and panes, which is the problem this project
 * started from. So the click has to land somewhere.
 *
 * There is no single answer, because a session can be running in a plain
 * terminal, in a tmux pane, inside VS Code's integrated terminal, or over SSH on
 * a machine that has no window at all. The strategy is therefore layered, and
 * each layer reports honestly whether it did anything:
 *
 *   1. tmux — if the process sits under a pane, select that window and pane, and
 *      switch the attached client to it.
 *   2. GUI app — walk the process ancestry until an `.app` bundle appears. This
 *      is what handles Terminal, iTerm2, Ghostty, WezTerm and VS Code alike,
 *      because in every case the terminal's ancestor chain ends at the bundle
 *      that owns the window. Which of that app's windows to raise then splits:
 *      2a. An editor that reuses a folder's window is simply handed the folder
 *          and picks for itself. Exact, and requires no TCC permission.
 *      2b. Everything else is activated, and the right window found by reading
 *          window titles through System Events — which needs Accessibility.
 *   3. Nothing — say so, and say why, rather than silently succeeding.
 *
 * Step 2a exists because 2b's permission is a genuinely bad dependency: it is
 * granted per-app to whatever launched `osascript` (SwiftBar for a menu click,
 * your terminal otherwise), so it is easy to grant to the wrong one — and when
 * it is missing System Events does not fail, it reports zero windows, which
 * reads exactly like an app with no windows open.
 *
 * Deliberately *not* attempted: focusing a specific pane inside VS Code's
 * integrated terminal. Nothing outside the editor can address it, and pretending
 * otherwise would be worse than landing the user on the right window.
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

export interface FocusResult {
  ok: boolean;
  /** What actually happened, for the user and for `doctor`. */
  detail: string;
}

export interface FocusDeps {
  /** Run a command, returning stdout, or null if it fails or is missing. */
  run: (file: string, args: string[]) => string | null;
  /** True if a pid exists on this machine. */
  pidAlive: (pid: number) => boolean;
  platform: string;
  /** Our own pid — used to name the app whose Accessibility grant is missing. */
  selfPid: number;
  /** For recognising the `~`-relative paths terminals put in window titles. */
  home: string;
}

export function defaultFocusDeps(): FocusDeps {
  return {
    selfPid: process.pid,
    home: homedir(),
    run: (file, args) => {
      try {
        return execFileSync(file, args, {
          encoding: "utf8",
          timeout: 5_000,
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        return null;
      }
    },
    pidAlive: (pid) => {
      try {
        // Signal 0 checks existence and permission without delivering anything.
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    platform: process.platform,
  };
}

/** The pid's ancestry, nearest first, including the pid itself. */
export function ancestry(pid: number, deps: FocusDeps, maxDepth = 24): number[] {
  const chain: number[] = [];
  let current = pid;
  for (let i = 0; i < maxDepth && current > 1; i++) {
    chain.push(current);
    const out = deps.run("ps", ["-o", "ppid=", "-p", String(current)]);
    const parent = out === null ? Number.NaN : Number.parseInt(out.trim(), 10);
    if (!Number.isFinite(parent) || parent <= 1 || chain.includes(parent)) break;
    current = parent;
  }
  return chain;
}

interface Pane {
  panePid: number;
  target: string;
  session: string;
}

function tmuxPanes(deps: FocusDeps): Pane[] {
  const out = deps.run("tmux", [
    "list-panes",
    "-a",
    "-F",
    "#{pane_pid} #{session_name}:#{window_index}.#{pane_index} #{session_name}",
  ]);
  if (out === null) return [];
  const panes: Pane[] = [];
  for (const line of out.split("\n")) {
    const [pidText, target, session] = line.trim().split(" ");
    const panePid = Number.parseInt(pidText ?? "", 10);
    if (Number.isFinite(panePid) && target && session) panes.push({ panePid, target, session });
  }
  return panes;
}

export interface OwningApp {
  /** The outermost `.app` bundle path. */
  bundle: string;
  /** Pid of the top-most process belonging to that bundle — the app itself. */
  pid: number;
}

/**
 * The application owning a process, found by walking up the ancestry.
 *
 * Two details matter, and getting either wrong sends the user to the wrong place
 * with no error:
 *
 * 1. **The outermost bundle, not the innermost.** Electron apps run their work in
 *    a nested helper, so the executable path contains *two* `.app` bundles:
 *    `…/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/…`.
 *    Matching `.app/Contents/MacOS/` finds the helper, and activating a helper
 *    bundle does not raise the editor — it silently lands you on whatever desktop
 *    you were already on.
 * 2. **The top-most matching ancestor.** The helper's parent is the real app
 *    process, and its pid is what lets AppleScript address the app exactly,
 *    rather than guessing a process name from a bundle filename.
 */
function owningApp(chain: number[], deps: FocusDeps): OwningApp | null {
  let found: OwningApp | null = null;
  for (const pid of chain) {
    const out = deps.run("ps", ["-o", "comm=", "-p", String(pid)]);
    if (out === null) continue;
    const path = out.trim();
    const marker = path.indexOf(".app/");
    if (marker === -1) continue;
    // Keep going: later entries are further up the tree, and the last match is
    // the app itself rather than one of its helpers.
    found = { bundle: path.slice(0, marker + 4), pid };
  }
  return found;
}

/** Separator for the window-title list; `,` and `;` both occur in real titles. */
const TITLE_SEP = "|::|";

/** "…/Visual Studio Code - Insiders.app" → "Visual Studio Code - Insiders.app". */
function appName(app: OwningApp): string {
  return app.bundle.split("/").pop() ?? app.bundle;
}

/**
 * Apps where `open -a <bundle> <folder>` means "show me the window already
 * holding this folder" rather than "open another window".
 *
 * This is the one route to the *right* window that needs no Accessibility
 * permission, which makes it the difference between a click that works out of
 * the box and one that works only after a trip through System Settings.
 *
 * The list is deliberately short and conservative. A terminal emulator given a
 * directory opens a brand new window, so a wrong entry here does not degrade —
 * it spawns windows every time the user clicks, which is worse than the problem.
 * Only editors verified to reuse belong here.
 */
const REUSES_FOLDER_WINDOW = [/^Visual Studio Code/, /^VSCodium/, /^Cursor\.app$/, /^Windsurf\.app$/];

function reusesFolderWindow(app: OwningApp): boolean {
  const name = appName(app);
  return REUSES_FOLDER_WINDOW.some((re) => re.test(name));
}

/**
 * Which application must be granted Accessibility.
 *
 * `osascript` inherits the permission of whatever launched it: for a menu-bar
 * click that is SwiftBar, and from a shell it is the terminal. Naming the wrong
 * one sends someone to the wrong row of System Settings, ticks a box that
 * changes nothing, and leaves them believing the feature is broken — so it is
 * worked out from our own ancestry rather than guessed.
 */
function controllingApp(deps: FocusDeps): string {
  const app = owningApp(ancestry(deps.selfPid, deps), deps);
  return app === null ? "the app that launched astir" : appName(app);
}

/**
 * The titles of an application's windows, or `null` when they cannot be read.
 *
 * The empty-vs-null distinction is the whole point. System Events can only see
 * another application's windows with Accessibility permission, and *without* it
 * it does not raise an error — it reports zero windows. An app genuinely showing
 * no windows looks identical. So `null` means "no process", and an empty array
 * means "the process is there and claims no windows", which the caller treats as
 * the permission case because a terminal session always has a window.
 */
export function windowTitles(app: OwningApp, deps: FocusDeps): string[] | null {
  // `name of every window of p` — the bulk property fetch — NOT
  // `repeat with w in windows of p`. Iterating the reference list yields nothing
  // for some apps (observed on Ghostty) while the bulk form returns the titles,
  // and it fails silently rather than erroring, so the caller saw an empty list
  // and concluded the windows were unreadable.
  const script = `
    tell application "System Events"
      set procs to (every process whose unix id is ${app.pid})
      if procs is {} then return "no-process"
      set p to item 1 of procs
      set AppleScript's text item delimiters to "${TITLE_SEP}"
      set out to (name of every window of p) as text
      set AppleScript's text item delimiters to ""
      return out
    end tell`;
  const out = deps.run("osascript", ["-e", script]);
  if (out === null || out.trim() === "no-process") return null;
  return out
    .split(TITLE_SEP)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Which window belongs to this session, as an index into `titles` (1-based, the
 * way AppleScript addresses them). `null` when nothing plausibly matches.
 *
 * A bare substring test is not enough: an editor with several projects open puts
 * the folder name in one window's title and can equally have a *file* called
 * `astir.3s.sh` open in another, and matching the wrong one sends you to the
 * wrong desktop while reporting success. So the folder name has to appear as a
 * whole token — VS Code separates title components with an em dash, so the token
 * boundary is real — and a title that is *only* the folder name wins over one
 * that merely mentions it.
 */
export function pickWindow(titles: string[], cwd: string, home = ""): number | null {
  const folder = cwd.split("/").filter(Boolean).pop() ?? "";
  if (folder === "") return null;

  // Terminals commonly title a window with the path, home-relative: Ghostty
  // shows "✳ Claude Code, ~/Projects/astir". Matching that beats matching the
  // basename, because a basename can appear inside an unrelated path while the
  // full path cannot.
  const tilde = home !== "" && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : null;

  const tokens = (title: string): string[] =>
    title
      .split(/[—–\-|:·,]|\s{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

  let path: number | null = null;
  let token: number | null = null;
  let substring: number | null = null;
  for (let i = 0; i < titles.length; i++) {
    const title = titles[i] ?? "";
    if (title === folder) return i + 1;
    if (path === null && (title.includes(cwd) || (tilde !== null && title.includes(tilde)))) {
      path = i + 1;
    }
    const parts = tokens(title);
    if (token === null && parts.includes(folder)) token = i + 1;
    if (substring === null && title.includes(folder)) substring = i + 1;
  }
  return path ?? token ?? substring;
}

/**
 * Can System Events see ANY window on this machine?
 *
 * Disambiguates the one reading that would otherwise be a guess. An app
 * reporting zero windows means either "we are not allowed to look" or "it
 * genuinely has none open" — a terminal whose window you just closed looks
 * exactly like a missing permission. Across every visible process those two
 * separate cleanly: no permission yields zero everywhere, whereas a machine
 * with a Finder window and a browser open does not.
 */
function anyWindowsVisible(deps: FocusDeps): boolean {
  const out = deps.run("osascript", [
    "-e",
    `tell application "System Events"
       set n to 0
       repeat with p in (every process whose visible is true)
         try
           set n to n + (count of windows of p)
         end try
       end repeat
       return n
     end tell`,
  ]);
  return out !== null && Number.parseInt(out.trim(), 10) > 0;
}

/**
 * Raise one window, switching Spaces if it is fullscreen.
 *
 * `open -a` activates an application but does not reliably follow a fullscreen
 * window onto its own Space, which is exactly the case that matters here — a
 * fullscreen editor on another desktop is the session you are least able to
 * find. `AXRaise` does follow it.
 *
 * Addressing the process by `unix id` avoids guessing its name: the System
 * Events process name is the executable ("Code - Insiders"), which is not the
 * bundle name ("Visual Studio Code - Insiders").
 */
function raiseWindow(app: OwningApp, index: number, deps: FocusDeps): boolean {
  const script = `
    tell application "System Events"
      set procs to (every process whose unix id is ${app.pid})
      if procs is {} then return "no-process"
      set p to item 1 of procs
      set frontmost of p to true
      try
        perform action "AXRaise" of (item ${index} of windows of p)
        return "raised"
      end try
      return "no-raise"
    end tell`;
  return deps.run("osascript", ["-e", script])?.trim() === "raised";
}

export function focusSession(
  session: { sessionId: string; pid: number | null; cwd: string; name: string | null },
  deps: FocusDeps = defaultFocusDeps(),
): FocusResult {
  const pid = session.pid;
  if (pid === null) {
    return {
      ok: false,
      detail:
        "no pid for this session — it is probably running on another machine, " +
        "which this cannot reach. Use the session name to find it there.",
    };
  }
  if (!deps.pidAlive(pid)) {
    return { ok: false, detail: `pid ${pid} is not running on this machine` };
  }

  const chain = ancestry(pid, deps);
  const notes: string[] = [];

  // 1 — tmux. Match a pane whose own pid is anywhere in our ancestry.
  const panes = tmuxPanes(deps);
  const pane = panes.find((p) => chain.includes(p.panePid));
  if (pane) {
    deps.run("tmux", ["select-window", "-t", pane.target]);
    deps.run("tmux", ["select-pane", "-t", pane.target]);
    // Only meaningful when a client is attached to a different session; harmless
    // otherwise, and a failure here must not mask the window selection above.
    deps.run("tmux", ["switch-client", "-t", pane.session]);
    notes.push(`tmux ${pane.target}`);
  }

  // 2 — the window the terminal actually lives in.
  if (deps.platform === "darwin") {
    const app = owningApp(chain, deps);
    if (app !== null) {
      const name = appName(app);

      if (reusesFolderWindow(app)) {
        // Preferred, and deliberately tried BEFORE anything involving System
        // Events: the editor already knows which of its windows holds this
        // folder, so asking it is both exact and free of any TCC permission.
        // The Accessibility route below needs a grant that is easy to give to
        // the wrong app and silently reports zero windows when it is missing.
        const shown = deps.run("open", ["-a", app.bundle, session.cwd]);
        notes.push(shown === null ? `could not activate ${name}` : `${name} (${session.cwd})`);
      } else {
        // Activate first so the app is frontmost even without Accessibility
        // permission, then try to raise the *right* window, which is what
        // follows a fullscreen window onto its own Space.
        const opened = deps.run("open", ["-a", app.bundle]);
        const titles = windowTitles(app, deps);

        if (titles !== null && titles.length === 0) {
          // The app is running and reports no windows, which for a terminal
          // session cannot be true — we are simply not allowed to look.
          //
          // Activating it is still a real outcome, and for a single-window
          // terminal it is exactly the right one, so this is not a failure. What
          // it must not do is claim the *window* was chosen: that was the old
          // lie that sent people to the wrong desktop believing otherwise.
          if (opened === null) {
            return { ok: false, detail: `could not activate ${name}` };
          }
          notes.push(
            anyWindowsVisible(deps)
              ? `${name} — activated it, but it reports no open windows, so there was ` +
                  "nothing to raise (the session may be in a tab of a closed or minimised window)"
              : `${name} — activated the app; astir cannot see any windows because ` +
                  `${controllingApp(deps)} has no Accessibility permission, so if it has ` +
                  "several this may not be the right one",
          );
          return { ok: true, detail: `focused ${notes.join(" → ")}` };
        }

        const index = titles === null ? null : pickWindow(titles, session.cwd, deps.home);
        const raised = index === null ? false : raiseWindow(app, index, deps);

        if (raised && index !== null) {
          notes.push(`${name} (${titles?.[index - 1] ?? ""})`);
        } else if (opened !== null) {
          // Landing on the app but not the specific window is a partial success
          // worth reporting honestly, since the user may end up on another desktop.
          const why =
            titles === null
              ? "could not read its windows"
              : `no window matches ${session.cwd.split("/").filter(Boolean).pop() ?? "this session"}`;
          notes.push(`${name} — ${why}, so this is the app, not necessarily the right window`);
        } else {
          notes.push(`could not activate ${name}`);
        }
      }
    } else if (notes.length === 0) {
      return {
        ok: false,
        detail:
          `pid ${pid} has no owning application — the session is probably in a ` +
          "detached tmux or a bare SSH shell with no window to raise",
      };
    }
  } else if (notes.length === 0) {
    return { ok: false, detail: `window focusing is not implemented for ${deps.platform}` };
  }

  return { ok: true, detail: `focused ${notes.join(" → ")}` };
}
