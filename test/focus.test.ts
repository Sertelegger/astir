import { getEventListeners } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ancestry, type FocusDeps, focusSession, pickWindow, runBounded } from "../src/status/focus.js";

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
  name: "astir-ac",
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
    expect(pickWindow(["other", "astir", "astir.3s.sh — scratch"], "/Users/x/astir")).toBe(2);
  });

  it("matches the folder as a title component, not a bare substring", () => {
    // The bug behind "it opened a VS Code window, just not the right one": an
    // editor with several projects open can have a *file* called astir.3s.sh in
    // an unrelated window, and that window's title contains "astir" too.
    expect(pickWindow(["astir.3s.sh — other-project", "main.ts — astir"], "/Users/x/astir")).toBe(2);
  });

  it("falls back to a substring rather than giving up", () => {
    expect(pickWindow(["myastir-stuff"], "/Users/x/astir")).toBe(1);
  });

  it("returns null when nothing mentions the folder at all", () => {
    expect(pickWindow(["mail", "calendar"], "/Users/x/astir")).toBe(null);
  });

  it("handles a cwd with a trailing slash", () => {
    expect(pickWindow(["astir"], "/Users/x/astir/")).toBe(1);
  });

  it("prefers a home-relative path over a basename match elsewhere", () => {
    // Ghostty titles a window "✳ Claude Code, ~/Projects/astir". A full path
    // cannot appear inside an unrelated project the way a basename can.
    expect(
      pickWindow(
        ["astir.3s.sh — other", "✳ Claude Code, ~/Projects/astir"],
        "/home/u/Projects/astir",
        "/home/u",
      ),
    ).toBe(2);
  });

  it("matches an absolute path in the title too", () => {
    expect(pickWindow(["zsh — /home/u/Projects/astir"], "/home/u/Projects/astir", "/home/u")).toBe(1);
  });

  it("still works when the cwd is not under home", () => {
    expect(pickWindow(["x", "astir"], "/opt/astir", "/home/u")).toBe(2);
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

/**
 * #80 — what `status --line --json` runs to decide `focusable`, on a host's
 * five-second loop. It must end when the line's budget does: a wedged tmux
 * once held it for the full 5s of an `execFileSync`, past astir-tui's 3s kill,
 * and each kill orphaned another `tmux list-panes`. These spawn real children —
 * node itself, never tmux or a notifier — because "killed" is the claim.
 */
describe("runBounded — a command the caller's budget can kill", () => {
  const node = process.execPath;
  const live = (): AbortSignal => new AbortController().signal;

  it("answers with what the command printed", async () => {
    expect(await runBounded(node, ["-e", "process.stdout.write('80\\n555\\n')"], live())).toBe("80\n555\n");
  });

  it("leaves nothing listening on the caller's signal once it has answered", async () => {
    // The probe runs two commands under one signal; a caller with a longer-lived
    // one should not collect a listener per command.
    const signal = live();
    await runBounded(node, ["-e", "process.stdout.write('80')"], signal);
    await runBounded(node, ["-e", "process.exit(3)"], signal);
    expect(getEventListeners(signal, "abort")).toEqual([]);
  });

  it("is null for a command that fails, or is not there — never a rejection", async () => {
    expect(await runBounded(node, ["-e", "process.exit(3)"], live())).toBeNull();
    expect(await runBounded("astir-no-such-command-for-a-test", [], live())).toBeNull();
    // Refused before anything starts: spawn throws for this rather than reporting it.
    expect(await runBounded(node, ["-e", "1", "a\0b"], live())).toBeNull();
  });

  it("answers null at once when the budget is already spent", async () => {
    const stop = new AbortController();
    stop.abort();
    const started = Date.now();
    expect(await runBounded(node, ["-e", "setTimeout(() => {}, 10_000)"], stop.signal)).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("starts nothing once the budget is spent — the answer is there before any process could be", async () => {
    // A command spawned under a spent signal is killed at once, so the answer
    // alone cannot tell. When it comes can: a process has to start and be
    // reaped before it says anything, and this answer is already settled.
    const stop = new AbortController();
    stop.abort();
    const pending = runBounded(node, ["-e", "setTimeout(() => {}, 10_000)"], stop.signal);
    expect(await Promise.race([pending, Promise.resolve("started")])).toBeNull();
  });

  it("is null for a command that prints past 4 MB, which it kills rather than waits on", async () => {
    // No process table or pane list is that big: whatever is printing it is
    // not the command that was asked.
    const MB4 = 4 * 1024 * 1024;
    expect(await runBounded(node, ["-e", `process.stdout.write("x".repeat(${MB4}))`], live())).toHaveLength(
      MB4,
    );
    const stop = new AbortController();
    try {
      const pending = runBounded(
        node,
        ["-e", `process.stdout.write("x".repeat(${MB4 + 1})); setTimeout(() => {}, 30_000)`],
        stop.signal,
      );
      expect(await within(pending, 5_000)).toBeNull();
    } finally {
      stop.abort();
    }
  }, 10_000);

  it("kills the command when the budget runs out, rather than waiting on it", async () => {
    const stop = new AbortController();
    const pending = runBounded(node, ["-e", "setTimeout(() => {}, 10_000)"], stop.signal);
    setTimeout(() => stop.abort(), 50);
    const started = Date.now();
    expect(await pending).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("kills even a STOPPED command — a SIGTERM would wait for it to be continued", async () => {
    // The harshest wedge: a process that is not running at all. Only SIGKILL
    // ends it, and the answer waits on its exit, so a softer signal hangs here.
    const stop = new AbortController();
    const pending = runBounded(node, ["-e", "process.kill(process.pid, 'SIGSTOP')"], stop.signal);
    setTimeout(() => stop.abort(), 200);
    expect(await pending).toBeNull();
  }, 5_000);

  /**
   * A tmux client hands its stdout to the tmux server. A wedged server never
   * reads it, so once the client is killed the pipe is STILL open — the
   * server holds the other end — and a `close` that waits for the pipe never
   * comes. The line printed at the budget and then the process did not exit,
   * so astir-tui's 3s kill read `astir unreachable` on every tick. These stand
   * in for the server with a process the command starts, which inherits its
   * stdout and outlives it — no tmux needed.
   */
  describe("when something the command started still holds its output", () => {
    let dir = "";
    const strays: number[] = [];
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "astir-bounded-"));
    });
    afterEach(() => {
      for (const pid of strays.splice(0)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      rmSync(dir, { recursive: true, force: true });
    });

    /** What the holder does by default: hold the pipe, and print nothing. */
    const HOLDS = "setTimeout(() => {}, 10000)";

    /**
     * Starts a holder — a process that inherits stdout, outlives the command,
     * runs `holder` with the command's pid as `process.argv[1]` — and writes
     * "<command pid> <holder pid>" to `ready` once it exists; then waits,
     * exits 0, or exits 3.
     */
    const sharing = (ready: string, then: "waits" | "exits" | "fails", holder = HOLDS): string[] => [
      "-e",
      [
        "const fs = require('node:fs');",
        "const c = require('node:child_process').spawn(process.execPath,",
        `  ['-e', ${JSON.stringify(holder)}, String(process.pid)], { stdio: ['ignore', 'inherit', 'ignore'] });`,
        `fs.writeFileSync(${JSON.stringify(`${ready}.tmp`)}, process.pid + ' ' + c.pid);`,
        `fs.renameSync(${JSON.stringify(`${ready}.tmp`)}, ${JSON.stringify(ready)});`,
        { waits: "setTimeout(() => {}, 10000);", exits: "process.exit(0);", fails: "process.exit(3);" }[then],
      ].join("\n"),
    ];

    /**
     * The pids `sharing` wrote, once it has. The holder is killed after the
     * test; both give up on their own after 10s if a run is cut short.
     */
    const started = async (ready: string): Promise<{ command: number; holder: number }> => {
      for (const deadline = Date.now() + 5_000; Date.now() < deadline; ) {
        try {
          const [command, holder] = readFileSync(ready, "utf8").split(" ").map(Number);
          strays.push(holder as number);
          return { command: command as number, holder: holder as number };
        } catch {
          await pause(10);
        }
      }
      throw new Error("the command never started its holder");
    };

    /**
     * Pipes this process has open. Only its own: the line resolving is not the
     * line's process exiting, and an open pipe keeps node's event loop alive
     * for as long as whatever holds the other end lives.
     */
    const pipes = (): number => process.getActiveResourcesInfo().filter((r) => r === "PipeWrap").length;

    /** Pipes open now, once anything an earlier test let go of has finished closing. */
    const baseline = async (): Promise<number> => {
      await pause(20);
      return pipes();
    };

    /** Waits for the open pipes to come back down to `n`, and says how many there are. */
    const settled = async (n: number): Promise<number> => {
      for (const deadline = Date.now() + 1_000; pipes() > n && Date.now() < deadline; ) await pause(10);
      return pipes();
    };

    it("answers when the budget runs out, not when the pipe closes — and lets go of the pipe", async () => {
      const before = await baseline();
      const ready = join(dir, "ready");
      const stop = new AbortController();
      const pending = runBounded(node, sharing(ready, "waits"), stop.signal);
      await started(ready);
      expect(pipes()).toBe(before + 1);
      stop.abort();
      expect(await within(pending, 2_000)).toBeNull();
      expect(await settled(before)).toBe(before);
    }, 10_000);

    it("answers when the budget runs out after the command itself has exited", async () => {
      // Node stops listening to the signal once the child exits, so this
      // abort reaches nothing of node's: only runBounded can hear it.
      const before = await baseline();
      const ready = join(dir, "ready");
      const stop = new AbortController();
      const pending = runBounded(node, sharing(ready, "exits"), stop.signal);
      const { command } = await started(ready);
      // Gone and reaped: signal 0 still reaches a zombie.
      for (const deadline = Date.now() + 5_000; alive(command) && Date.now() < deadline; ) await pause(10);
      expect(alive(command)).toBe(false);
      stop.abort();
      expect(await within(pending, 2_000)).toBeNull();
      expect(await settled(before)).toBe(before);
    }, 10_000);

    it("is null at once, reading no further, when what the command left behind prints past 4 MB", async () => {
      // The limit bounds what is read, not only what the command prints: once
      // the command has exited there is nothing to kill, and reading on until
      // the holder stops would let it fill this process's memory.
      const floods = [
        "const command = Number(process.argv[1]);",
        "const gone = () => { try { process.kill(command, 0); return false; } catch { return true; } };",
        // Only once the command has been reaped, so the flood always comes after its exit.
        "const t = setInterval(() => { if (!gone()) return; clearInterval(t);",
        `  process.stdout.write("x".repeat(${4 * 1024 * 1024 + 1})); setTimeout(() => {}, 10000); }, 10);`,
      ].join("\n");
      const before = await baseline();
      const ready = join(dir, "ready");
      const stop = new AbortController();
      try {
        const pending = runBounded(node, sharing(ready, "exits", floods), stop.signal);
        await started(ready);
        expect(await within(pending, 2_000)).toBeNull();
        expect(await settled(before)).toBe(before);
      } finally {
        stop.abort();
      }
    }, 10_000);

    it("answers a command that failed at once, without waiting for the pipe or the budget", async () => {
      // Its answer is null whatever else it printed, so there is nothing to wait for.
      const before = await baseline();
      const ready = join(dir, "ready");
      const stop = new AbortController();
      try {
        const pending = runBounded(node, sharing(ready, "fails"), stop.signal);
        await started(ready);
        expect(await within(pending, 2_000)).toBeNull();
        expect(await settled(before)).toBe(before);
      } finally {
        stop.abort();
      }
    }, 10_000);
  });
});

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `p`'s answer, or "still waiting" if it has none within `ms` — so a hang fails, not times out. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | "still waiting"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"still waiting">((resolve) => {
    timer = setTimeout(() => resolve("still waiting"), ms);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
