/**
 * CAP-06 — shell-driven writes become visible.
 *
 * `classifyTool` reads paths from exactly three keys of `tool_input` —
 * `file_path`, `notebook_path`, `path` — and Bash's input is
 * `{command, description}`. So a `sed -i`, a formatter, a build step or a
 * `git checkout` contributes nothing to the map. Measured over every transcript
 * on the machine this was written on: 56,190 Bash calls against 1,217
 * path-bearing edit calls, ~5,500 of the Bash calls carrying a write-capable
 * construct. Astir saw roughly a fifth of plausibly file-mutating work.
 *
 * `FileChanged` closes that, and the hook was real all along — Claude Code
 * 2.1.278 carries it in its event enum with a `file_path` and an
 * `event: change | add | unlink`. astir simply never registered it, so its
 * normalizer branch was unreachable in production.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeClaudeHook } from "../src/adapters/claude/normalize.js";
import { MAX_WATCH_PATHS, watchPathsFor } from "../src/adapters/claude/watch.js";

const dir = (name: string) => ({ name, isDirectory: true });
const file = (name: string) => ({ name, isDirectory: false });
const pick = (entries: Array<{ name: string; isDirectory: boolean }>) =>
  watchPathsFor("/repo", entries, (a, b) => `${a}/${b}`);

describe("which paths are handed to the watcher", () => {
  it("watches source directories", () => {
    expect(pick([dir("src"), dir("test")]).paths).toEqual(["/repo/src", "/repo/test"]);
  });

  it("never hands over node_modules, .git or a build directory", () => {
    // The watcher is constructed with NO `ignored` option, so a directory given
    // to it is followed recursively with nothing excluded. There is no filter
    // to pass — the only control is which paths are handed over. On astir's own
    // checkout, the repo root is 966 directories and 5,641 files, of which 141
    // are not node_modules/.git/dist; one `npm install` would fire thousands of
    // POSTs at a daemon whose per-hook timeout is five seconds.
    const got = pick([dir("src"), dir("node_modules"), dir(".git"), dir("dist"), dir("target")]);
    expect(got.paths).toEqual(["/repo/src"]);
  });

  it("skips dotfile directories, which are tool state rather than work", () => {
    expect(pick([dir(".cache"), dir(".idea"), dir("lib")]).paths).toEqual(["/repo/lib"]);
  });

  it("keeps .github, because a workflow edited by a script is real work", () => {
    // Named explicitly rather than swept up by the dot rule — the exception is
    // deliberate and would otherwise look like an oversight.
    expect(pick([dir(".github"), dir(".cache")]).paths).toEqual(["/repo/.github"]);
  });

  it("watches directories only, never a top-level file", () => {
    // A watcher for one path costs the same as one for a tree, and the files
    // that matter at a repo root are edited through tools astir already sees.
    expect(pick([file("package.json"), file("README.md"), dir("src")]).paths).toEqual(["/repo/src"]);
  });

  it("caps the list, and reports how much it dropped", () => {
    // A monorepo with ninety packages would otherwise watch ninety trees, and
    // the cost lands on the editor rather than on astir. Silent truncation is
    // the failure this project exists downstream of, so the remainder is
    // returned rather than discarded.
    const many = Array.from({ length: MAX_WATCH_PATHS + 5 }, (_, i) =>
      dir(`pkg${String(i).padStart(3, "0")}`),
    );
    const got = pick(many);
    expect(got.paths).toHaveLength(MAX_WATCH_PATHS);
    expect(got.truncated).toBe(5);
  });

  it("reports nothing to watch as an empty list, not as an error", () => {
    expect(pick([dir("node_modules")]).paths).toEqual([]);
    expect(pick([]).truncated).toBe(0);
  });
});

describe("the event kind is honoured, not assumed", () => {
  const deps = {
    readSidecar: () => null,
    newId: () => "e1",
    realpath: (p: string) => p,
    now: () => 1_787_000_000,
  };
  const fire = (event: string) =>
    normalizeClaudeHook(
      { hook_event_name: "FileChanged", session_id: "s1", cwd: "/repo", file_path: "/repo/src/a.ts", event },
      deps as never,
    );

  it("records a change as an edit on that path", () => {
    const r = fire("change");
    expect(r.event?.op).toBe("edit");
    expect(r.event?.paths).toEqual(["src/a.ts"]);
  });

  it("records an add as an edit too", () => {
    expect(fire("add").event?.op).toBe("edit");
  });

  it("does NOT record a deletion as an edit", () => {
    // Heat on a path that no longer exists is a tile that can never cool,
    // because nothing will ever touch it again — on a map whose entire claim is
    // that brightness means recent work.
    const r = fire("unlink");
    expect(r.event?.op).not.toBe("edit");
    expect(r.event?.paths).toEqual([]);
  });

  it("treats a missing event field as a change rather than failing", () => {
    const r = normalizeClaudeHook(
      { hook_event_name: "FileChanged", session_id: "s1", cwd: "/repo", file_path: "/repo/src/a.ts" },
      deps as never,
    );
    expect(r.event?.op).toBe("edit");
  });
});

describe("the hook is actually registered", () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname ?? ".", "..", "hooks", "hooks.json"), "utf8"),
  ) as { hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> };

  it("subscribes FileChanged, or the normalizer branch is dead in production", () => {
    // It was mapped, commented and unreachable for exactly this reason.
    expect(Object.keys(manifest.hooks)).toContain("FileChanged");
  });

  it("carries the token the same way every other capture hook does", () => {
    // Omitting `allowedEnvVars` makes the header interpolate to EMPTY, so every
    // event 401s, `unauthorizedIngest` climbs, and the daemon reports that the
    // hooks are misconfigured while the other nine work perfectly. The first
    // draft of this entry did exactly that.
    const entry = manifest.hooks.FileChanged?.[0]?.hooks[0];
    expect(entry?.allowedEnvVars).toEqual(["ASTIR_TOKEN"]);
    expect(entry?.type).toBe("http");
  });

  it("sets no matcher, so it fires for every watched change", () => {
    // `matcher` does double duty: it supplies watch paths AND is compiled to a
    // regex tested against the changed file's BASENAME. One naming directories
    // would therefore also filter events to files whose names contain those
    // words. Paths come from the SessionStart response instead.
    expect(manifest.hooks.FileChanged?.[0]).not.toHaveProperty("matcher");
  });
});
