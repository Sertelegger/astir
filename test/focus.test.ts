import { describe, expect, it } from "vitest";
import { ancestry, type FocusDeps, focusSession, pickWindow } from "../src/status/focus.js";

/**
 * A fake process table. `tree` maps pid → parent pid, `comm` maps pid → its
 * executable path, so a test can describe any nesting of shells, tmux servers
 * and app bundles without touching the real machine.
 */
function deps(over: {
  tree?: Record<number, number>;
  comm?: Record<number, string>;
  panes?: string;
  alive?: boolean;
  platform?: string;
  failOpen?: boolean;
  failRaise?: boolean;
  /** Window titles System Events reports. `[]` is the no-permission case. */
  windows?: string[];
  /** The process is gone between listing and raising. */
  failTitles?: boolean;
  /** Windows System Events can see machine-wide; 0 means no Accessibility. */
  machineWindows?: number;
}): FocusDeps & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    // Resolves to no bundle, so the permission hint stays deterministic.
    selfPid: 900,
    home: "/home/u",
    platform: over.platform ?? "darwin",
    pidAlive: () => over.alive ?? true,
    run: (file, args) => {
      calls.push([file, ...args]);
      if (file === "ps" && args[1] === "ppid=") {
        const pid = Number(args[3]);
        const parent = over.tree?.[pid];
        return parent === undefined ? null : `${parent}\n`;
      }
      if (file === "ps" && args[1] === "comm=") {
        const pid = Number(args[3]);
        return over.comm?.[pid] ?? "/bin/zsh";
      }
      if (file === "tmux" && args[0] === "list-panes") return over.panes ?? null;
      if (file === "tmux") return "";
      if (file === "open") return over.failOpen === true ? null : "";
      if (file === "osascript") {
        const script = args[1] ?? "";
        if (script.includes("AXRaise")) return over.failRaise === true ? null : "raised";
        // The cross-app probe that separates "not allowed to look" from
        // "genuinely has no windows".
        if (script.includes("every process whose visible")) {
          return String(over.machineWindows ?? 0);
        }
        if (over.failTitles === true) return null;
        return (over.windows ?? ["repo"]).map((t) => `${t}|::|`).join("");
      }
      return null;
    },
  };
}

const session = (pid: number | null) => ({
  sessionId: "s1",
  pid,
  cwd: "/repo",
  name: "clide-ac",
});

describe("process ancestry", () => {
  it("walks up to the root and stops", () => {
    const d = deps({ tree: { 100: 90, 90: 80, 80: 1 } });
    expect(ancestry(100, d)).toEqual([100, 90, 80]);
  });

  it("does not loop forever on a cycle", () => {
    const d = deps({ tree: { 100: 90, 90: 100 } });
    expect(ancestry(100, d)).toEqual([100, 90]);
  });
});

describe("choosing which window", () => {
  it("prefers the window whose title is exactly the folder", () => {
    expect(pickWindow(["other", "clide", "clide.3s.sh — scratch"], "/Users/x/clide")).toBe(2);
  });

  it("matches the folder as a title component, not a bare substring", () => {
    // The bug behind "it opened a VS Code window, just not the right one": an
    // editor with several projects open can have a *file* called clide.3s.sh in
    // an unrelated window, and that window's title contains "clide" too.
    expect(pickWindow(["clide.3s.sh — other-project", "main.ts — clide"], "/Users/x/clide")).toBe(2);
  });

  it("falls back to a substring rather than giving up", () => {
    expect(pickWindow(["myclide-stuff"], "/Users/x/clide")).toBe(1);
  });

  it("returns null when nothing mentions the folder at all", () => {
    expect(pickWindow(["mail", "calendar"], "/Users/x/clide")).toBe(null);
  });

  it("handles a cwd with a trailing slash", () => {
    expect(pickWindow(["clide"], "/Users/x/clide/")).toBe(1);
  });

  it("prefers a home-relative path over a basename match elsewhere", () => {
    // Ghostty titles a window "✳ Claude Code, ~/Projects/clide". A full path
    // cannot appear inside an unrelated project the way a basename can.
    expect(
      pickWindow(
        ["clide.3s.sh — other", "✳ Claude Code, ~/Projects/clide"],
        "/home/u/Projects/clide",
        "/home/u",
      ),
    ).toBe(2);
  });

  it("matches an absolute path in the title too", () => {
    expect(pickWindow(["zsh — /home/u/Projects/clide"], "/home/u/Projects/clide", "/home/u")).toBe(1);
  });

  it("still works when the cwd is not under home", () => {
    expect(pickWindow(["x", "clide"], "/opt/clide", "/home/u")).toBe(2);
  });
});

describe("PSH-11 — focus a session", () => {
  it("selects the tmux pane the session runs in", () => {
    const d = deps({
      tree: { 500: 400, 400: 300, 300: 1 },
      comm: { 300: "/Applications/Ghostty.app/Contents/MacOS/ghostty" },
      panes: "400 work:2.1 work\n999 other:0.0 other\n",
    });

    const r = focusSession(session(500), d);

    expect(r.ok).toBe(true);
    // The pane pid is the session's *grandparent*, not the pid itself — matching
    // only on an exact pid would miss every session running under a shell.
    expect(d.calls).toContainEqual(["tmux", "select-window", "-t", "work:2.1"]);
    expect(d.calls).toContainEqual(["tmux", "switch-client", "-t", "work"]);
  });

  it("raises the owning application, recovering the bundle from the exe path", () => {
    const d = deps({
      tree: { 500: 400, 400: 1 },
      comm: {
        500: "/bin/zsh",
        400: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
      },
    });

    const r = focusSession(session(500), d);

    expect(r.ok).toBe(true);
    expect(d.calls).toContainEqual(["open", "-a", "/Applications/Visual Studio Code.app", "/repo"]);
    expect(r.detail).toContain("Visual Studio Code.app");
  });

  it("picks the OUTERMOST bundle, not the Electron helper inside it", () => {
    // Regression, and a silent one: activating a helper bundle does not raise the
    // editor, it just leaves you on whichever desktop you were already on.
    const d = deps({
      tree: { 500: 450, 450: 400, 400: 1 },
      comm: {
        500: "/bin/zsh",
        450:
          "/Applications/Visual Studio Code - Insiders.app/Contents/Frameworks/" +
          "Code - Insiders Helper.app/Contents/MacOS/Code - Insiders Helper",
        400: "/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Code - Insiders",
      },
    });

    focusSession(session(500), d);

    expect(d.calls).toContainEqual([
      "open",
      "-a",
      "/Applications/Visual Studio Code - Insiders.app",
      "/repo",
    ]);
    expect(d.calls.some((c) => c[0] === "open" && (c[2] ?? "").includes("Helper"))).toBe(false);
  });

  it("addresses the app process by unix id and raises the matching window", () => {
    const d = deps({
      tree: { 500: 450, 450: 400, 400: 1 },
      comm: {
        500: "/bin/zsh",
        450: "/Applications/Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Helper",
        400: "/Applications/Code.app/Contents/MacOS/Code",
      },
    });

    focusSession(session(500), d);

    const script = d.calls.filter((c) => c[0] === "osascript").at(-1)?.[2] ?? "";
    // 400 is the app itself; 450 is its helper. Addressing the helper would raise
    // nothing, and a fullscreen window would never come forward.
    expect(script).toContain("unix id is 400");
    expect(script).toContain("AXRaise");
  });

  it("lets an editor pick its own window, without asking for any permission", () => {
    // `open -a <editor> <folder>` means "show the window already holding this
    // folder". It is exact and needs no TCC grant, which is why it is preferred
    // over System Events rather than kept as a fallback.
    const d = deps({
      tree: { 500: 400, 400: 1 },
      comm: {
        500: "/bin/zsh",
        400: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
      },
    });

    const r = focusSession(session(500), d);
    expect(r.ok).toBe(true);
    expect(d.calls).toContainEqual(["open", "-a", "/Applications/Visual Studio Code.app", "/repo"]);
    // The point of the exercise: System Events is never consulted at all.
    expect(d.calls.some((c) => c[0] === "osascript")).toBe(false);
  });

  it("does NOT hand a folder to an app that would open a new window for it", () => {
    // A terminal emulator given a directory opens another window, so guessing
    // wrong here does not degrade — it spawns a window on every click.
    const d = deps({
      tree: { 500: 400, 400: 1 },
      comm: { 500: "/bin/zsh", 400: "/Applications/Ghostty.app/Contents/MacOS/ghostty" },
      windows: [],
    });

    const r = focusSession(session(500), d);
    // Activating is still a real outcome, so this is not a failure — it just
    // must not pretend a window was chosen.
    expect(r.ok).toBe(true);
    expect(d.calls.some((c) => c[0] === "open" && c[3] === "/repo")).toBe(false);
  });

  it("refuses to claim success when it cannot see any window", () => {
    // THE regression this rewrite exists for. Without Accessibility permission
    // System Events does not error — it reports zero windows. The old code only
    // checked that osascript *ran*, so it reported "focused <app> (repo)" while
    // actually raising whatever was last in front, on whatever desktop that was.
    const d = deps({
      tree: { 500: 400, 400: 1 },
      comm: { 500: "/bin/zsh", 400: "/Applications/Code.app/Contents/MacOS/Code" },
      windows: [],
    });

    const r = focusSession(session(500), d);
    // Activating the app IS the right outcome for a single-window terminal, so
    // this succeeds — what it must never do is claim the window was chosen.
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("Accessibility");
    expect(r.detail).toContain("may not be the right one");
    // And it must not attempt a raise it had no window for.
    expect(d.calls.some((c) => (c[2] ?? "").includes("AXRaise"))).toBe(false);
  });

  it("reads window names in bulk, not by iterating the reference list", () => {
    // Regression, and a silent one: `repeat with w in windows of p` yields
    // nothing for some apps (observed on Ghostty) while `name of every window of
    // p` returns them. It does not error, so the caller saw an empty list and
    // concluded the windows were unreadable — reporting a permission problem
    // that did not exist.
    const d = deps({
      tree: { 500: 400, 400: 1 },
      comm: { 500: "/bin/zsh", 400: "/Applications/Ghostty.app/Contents/MacOS/ghostty" },
    });
    focusSession(session(500), d);
    const listing = d.calls.filter((c) => c[0] === "osascript").map((c) => c[2] ?? "");
    const titles = listing.find((c) => !c.includes("AXRaise") && !c.includes("visible is true"));
    expect(titles).toContain("name of every window of p");
    expect(titles).not.toContain("repeat with w in windows of p");
  });

  it("does not blame Accessibility when the app simply has no windows open", () => {
    // A terminal whose window you just closed reports zero windows exactly like
    // a missing permission does. Blaming the grant there sends someone to
    // System Settings to fix something that is not broken.
    const d = deps({
      tree: { 500: 400, 400: 1 },
      comm: { 500: "/bin/zsh", 400: "/Applications/Ghostty.app/Contents/MacOS/ghostty" },
      windows: [],
      machineWindows: 12,
    });

    const r = focusSession(session(500), d);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("no open windows");
    expect(r.detail).not.toContain("Accessibility");
  });

  it("reports the app-only outcome when no window matches the session", () => {
    const d = deps({
      tree: { 500: 400, 400: 1 },
      comm: { 500: "/bin/zsh", 400: "/Applications/Code.app/Contents/MacOS/Code" },
      windows: ["something else", "unrelated project"],
    });

    const r = focusSession(session(500), d);
    expect(r.detail).toContain("not necessarily the right window");
  });

  it("says plainly that a remote session cannot be focused", () => {
    // The multi-machine case: a doorbell arrived from another host, so there is
    // no local window to raise. Claiming success would be a lie.
    const r = focusSession(session(null), deps({}));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("another machine");
  });

  it("reports a dead pid rather than silently doing nothing", () => {
    const r = focusSession(session(999), deps({ alive: false }));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("not running");
  });

  it("reports when there is no window at all — a detached tmux or bare ssh", () => {
    const d = deps({ tree: { 500: 1 }, comm: { 500: "/bin/zsh" } });
    const r = focusSession(session(500), d);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("no owning application");
  });

  it("still counts as focused if tmux worked but no GUI app exists", () => {
    // A detached-but-selectable pane is a real, useful outcome: attach later and
    // you land in the right window.
    const d = deps({
      tree: { 500: 400, 400: 1 },
      comm: { 500: "/bin/zsh", 400: "/usr/bin/tmux" },
      panes: "400 work:1.0 work\n",
    });
    const r = focusSession(session(500), d);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("work:1.0");
  });
});
