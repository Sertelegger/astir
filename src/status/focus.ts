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
 *   2. GUI app — walk the process ancestry until an `.app` bundle appears and
 *      activate it. This is what handles Terminal, iTerm2, Ghostty, WezTerm and
 *      VS Code alike, because in every case the terminal's ancestor chain ends at
 *      the bundle that owns the window.
 *   3. Nothing — say so, and say why, rather than silently succeeding.
 *
 * Deliberately *not* attempted: focusing a specific pane inside VS Code's
 * integrated terminal. Nothing outside the editor can address it, and pretending
 * otherwise would be worse than landing the user on the right window.
 */

import { execFileSync } from "node:child_process";

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
}

export function defaultFocusDeps(): FocusDeps {
  return {
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

/**
 * The `.app` bundle owning a process, found by walking up. The executable of a
 * bundled app lives at `<Bundle>.app/Contents/MacOS/<name>`, so the bundle path
 * is recoverable from the executable path alone.
 */
function bundleFor(chain: number[], deps: FocusDeps): string | null {
  for (const pid of chain) {
    const out = deps.run("ps", ["-o", "comm=", "-p", String(pid)]);
    if (out === null) continue;
    const path = out.trim();
    const marker = path.indexOf(".app/Contents/MacOS/");
    if (marker !== -1) return path.slice(0, marker + 4);
  }
  return null;
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
    const bundle = bundleFor(chain, deps);
    if (bundle !== null) {
      const opened = deps.run("open", ["-a", bundle]);
      if (opened !== null) {
        notes.push(bundle.split("/").pop() ?? bundle);
      } else {
        notes.push(`could not activate ${bundle}`);
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
