import { describe, expect, it } from "vitest";
import { ancestry, type FocusDeps, focusSession } from "../src/status/focus.js";

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
}): FocusDeps & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
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
      if (file === "osascript") return over.failRaise === true ? null : "raised";
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
    expect(d.calls).toContainEqual(["open", "-a", "/Applications/Visual Studio Code.app"]);
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

    expect(d.calls).toContainEqual(["open", "-a", "/Applications/Visual Studio Code - Insiders.app"]);
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

    const script = d.calls.find((c) => c[0] === "osascript")?.[2] ?? "";
    // 400 is the app itself; 450 is its helper. Addressing the helper would raise
    // nothing, and a fullscreen window would never come forward.
    expect(script).toContain("unix id is 400");
    expect(script).toContain("AXRaise");
    // The repo name disambiguates which project window to raise.
    expect(script).toContain('"repo"');
  });

  it("says so when the window cannot be raised, instead of claiming success", () => {
    // Without Accessibility permission the app comes forward but the specific
    // window does not — which on a fullscreen Space means the wrong desktop.
    const d = deps({
      tree: { 500: 400, 400: 1 },
      comm: { 500: "/bin/zsh", 400: "/Applications/Code.app/Contents/MacOS/Code" },
      failRaise: true,
    });

    const r = focusSession(session(500), d);
    expect(r.detail).toContain("Accessibility");
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
