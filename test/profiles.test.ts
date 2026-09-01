import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { candidateConfigDirs, type ProfileDeps } from "../src/discovery/profiles.js";

// Paths are built with `join`, not written as literals: on Windows it produces
// backslashes, and hard-coded POSIX separators made every assertion here fail
// there while the code under test was perfectly correct.
const HOME = join("/home", "dev");
const at = (name: string) => join(HOME, name);

const deps = (over: Partial<ProfileDeps> = {}): ProfileDeps => ({
  home: HOME,
  entries: () => [],
  isProfile: () => false,
  real: (p) => p,
  ...over,
});

describe("DMN-05 — every profile on the machine, not just the inherited one", () => {
  it("finds a sibling profile nobody configured", () => {
    // The bug: `claude agents --json` is scoped to $CLAUDE_CONFIG_DIR, so a
    // daemon started without one is blind to ~/.claude-nv. Its sessions still
    // arrive (hooks do not care about profiles) but are never enriched — no
    // name, no pid, no `attended`.
    //
    // Auto-detected rather than configured, because the failure is invisible:
    // nobody thinks to tell a daemon about a profile they did not know it was
    // missing.
    const dirs = candidateConfigDirs(
      deps({ entries: () => [".claude", ".claude-nv", ".bashrc"], isProfile: () => true }),
    );
    expect(dirs).toContain(at(".claude-nv"));
    expect(dirs).toContain(at(".claude"));
  });

  it("always includes the default, even when it has never been used", () => {
    // It is where Claude Code looks by default; an empty one costs one fast
    // call that returns nothing.
    expect(candidateConfigDirs(deps())).toEqual([at(".claude")]);
  });

  it("puts the daemon's own CLAUDE_CONFIG_DIR first", () => {
    const dirs = candidateConfigDirs(deps({ configDir: at(".claude-nv") }));
    expect(dirs[0]).toBe(at(".claude-nv"));
  });

  it("ignores directories that are not profiles", () => {
    // `.claude-mem`, `.claude.json`, a stray backup — anything without the
    // per-project session store has no sessions to report.
    const dirs = candidateConfigDirs(
      deps({
        entries: () => [".claude", ".claude-mem", ".claude.json.bak"],
        isProfile: (p) => p === at(".claude"),
      }),
    );
    expect(dirs).toEqual([at(".claude")]);
  });

  it("ignores anything not named .claude*", () => {
    const dirs = candidateConfigDirs(
      deps({ entries: () => ["repos", ".ssh", ".config"], isProfile: () => true }),
    );
    expect(dirs).toEqual([at(".claude")]);
  });

  it("does not poll one directory twice under two names", () => {
    // A symlinked profile would otherwise be listed twice, and every session in
    // it would appear twice on every surface.
    const dirs = candidateConfigDirs(
      deps({
        configDir: at(".claude-link"),
        entries: () => [".claude"],
        isProfile: () => true,
        real: (p) => (p === at(".claude-link") ? at(".claude") : p),
      }),
    );
    expect(dirs).toEqual([at(".claude-link")]);
  });

  it("returns the default when home lists nothing", () => {
    // `defaultProfileDeps` swallows a readdir failure into an empty list, so an
    // unreadable home degrades to "just the default" rather than throwing.
    expect(candidateConfigDirs(deps({ entries: () => [] }))).toEqual([at(".claude")]);
  });
});
