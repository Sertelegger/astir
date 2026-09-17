/**
 * Which astir plugin is installed — and why the answer is a list.
 *
 * The hooks run from a cached copy of the plugin; the binary runs from wherever
 * it was built. Bumping `marketplace.json` announces a new version rather than
 * installing it, so the two drift silently. Measured on a real machine after a
 * release AND a plugin update that appeared to have worked:
 *
 *   ~/.claude-nv  user     0.2.0
 *   ~/.claude-nv  project  0.1.0
 *   ~/.claude     user     0.1.0
 *
 * One of three. Any function answering with a single "installed version" would
 * have been wrong twice, and confidently — which is what these pin.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describePlugins, installedPlugins, pluginDrift } from "../src/config/plugin.js";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A config profile holding an `installed_plugins.json`. */
function profile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "astir-profile-"));
  made.push(dir);
  mkdirSync(join(dir, "plugins"), { recursive: true });
  writeFileSync(join(dir, "plugins", "installed_plugins.json"), JSON.stringify(contents));
  return dir;
}

const entry = (over: Record<string, unknown> = {}) => ({
  scope: "user",
  version: "0.2.0",
  installPath: "/nonexistent",
  ...over,
});

/** Every installPath exists, unless a test says otherwise. */
const allPresent = () => true;

describe("every install is reported, because there is rarely one", () => {
  it("finds the same plugin at two scopes under one key", () => {
    // The real shape: `installed_plugins.json` maps one key to an ARRAY, and a
    // reader taking [0] sees `user` and never learns `project` is two releases
    // behind. That is the bug this exists for.
    const dir = profile({
      plugins: {
        "astir@astir-marketplace": [
          entry({ scope: "user", version: "0.2.0" }),
          entry({ scope: "project", version: "0.1.0" }),
        ],
      },
    });

    const got = installedPlugins([dir], allPresent);
    expect(got.map((p) => `${p.scope}:${p.version}`)).toEqual(["user:0.2.0", "project:0.1.0"]);
  });

  it("finds installs across separate profiles", () => {
    const a = profile({ plugins: { "astir@astir-marketplace": [entry({ version: "0.2.0" })] } });
    const b = profile({ plugins: { "astir@astir-marketplace": [entry({ version: "0.1.0" })] } });

    const got = installedPlugins([a, b], allPresent);
    expect(got.map((p) => p.version)).toEqual(["0.2.0", "0.1.0"]);
    // The profile has to come back, or a per-profile fix cannot be named.
    expect(got.map((p) => p.profile)).toEqual([a, b]);
  });

  it("matches on the plugin name, not the marketplace it came from", () => {
    // A fork, a rename or a local checkout registers under a different
    // marketplace. Matching the full `astir@astir-marketplace` key would report
    // "not installed" for a plugin that is installed and running.
    const dir = profile({
      plugins: { "astir@my-local-checkout": [entry({ version: "0.3.0" })] },
    });
    expect(installedPlugins([dir], allPresent).map((p) => p.version)).toEqual(["0.3.0"]);
  });

  it("ignores other people's plugins", () => {
    const dir = profile({
      plugins: {
        "claude-mem@claude-mem-local": [entry()],
        "astirling@somewhere": [entry({ version: "9.9.9" })],
      },
    });
    // `astirling` starts with "astir" as a STRING but is a different plugin —
    // the boundary is the `@`, not a prefix.
    expect(installedPlugins([dir], allPresent)).toEqual([]);
  });
});

describe("an unusual setup makes it say less, never throw", () => {
  it("skips a profile with no plugins file at all", () => {
    const empty = mkdtempSync(join(tmpdir(), "astir-empty-"));
    made.push(empty);
    expect(installedPlugins([empty], allPresent)).toEqual([]);
  });

  it("skips a file that is not JSON rather than failing the whole diagnosis", () => {
    // `astir doctor` exists to explain a broken setup. Crashing on one is the
    // one outcome it must not have.
    const dir = mkdtempSync(join(tmpdir(), "astir-bad-"));
    made.push(dir);
    mkdirSync(join(dir, "plugins"), { recursive: true });
    writeFileSync(join(dir, "plugins", "installed_plugins.json"), "{ not json");
    expect(() => installedPlugins([dir], allPresent)).not.toThrow();
  });

  it("keeps reading later profiles after a broken one", () => {
    // A single unreadable profile must not hide every install behind it.
    const bad = mkdtempSync(join(tmpdir(), "astir-bad-"));
    made.push(bad);
    mkdirSync(join(bad, "plugins"), { recursive: true });
    writeFileSync(join(bad, "plugins", "installed_plugins.json"), "{ not json");
    const good = profile({ plugins: { "astir@m": [entry({ version: "0.2.0" })] } });

    expect(installedPlugins([bad, good], allPresent).map((p) => p.version)).toEqual(["0.2.0"]);
  });

  it("reports a version it cannot read as null rather than inventing one", () => {
    const dir = profile({ plugins: { "astir@m": [entry({ version: 7 })] } });
    expect(installedPlugins([dir], allPresent)[0]?.version).toBeNull();
  });
});

describe("an entry pointing at a directory that is gone", () => {
  it("is reported, not skipped", () => {
    // Claude Code will still try to load it, and that failure is more confusing
    // than a stale version. Silence here would be the worse answer.
    const dir = profile({ plugins: { "astir@m": [entry({ installPath: "/gone" })] } });
    const got = installedPlugins([dir], () => false);
    expect(got).toHaveLength(1);
    expect(got[0]?.dangling).toBe(true);
  });

  it("counts as drift even when its version matches", () => {
    // Matching on paper and absent on disk is not "current" — the check would
    // otherwise report a healthy plugin that cannot load.
    const p = { profile: "/p", scope: "user", version: "0.2.0", installPath: "/gone", dangling: true };
    expect(pluginDrift([p], "0.2.0").stale).toEqual([p]);
    expect(pluginDrift([p], "0.2.0").matching).toEqual([]);
  });
});

describe("drift against the running binary", () => {
  const at = (version: string | null, dangling = false) => ({
    profile: "/p",
    scope: "user",
    version,
    installPath: "/p/cache",
    dangling,
  });

  it("separates the current install from the ones left behind", () => {
    const { stale, matching } = pluginDrift([at("0.2.0"), at("0.1.0")], "0.2.0");
    expect(matching.map((p) => p.version)).toEqual(["0.2.0"]);
    expect(stale.map((p) => p.version)).toEqual(["0.1.0"]);
  });

  it("treats a NEWER plugin as drift too", () => {
    // The binary is the stale one here. Reporting only "older" would stay quiet
    // in exactly the case where the hooks have moved ahead of the daemon.
    expect(pluginDrift([at("0.3.0")], "0.2.0").stale.map((p) => p.version)).toEqual(["0.3.0"]);
  });

  it("treats an unreadable version as drift rather than assuming it is fine", () => {
    expect(pluginDrift([at(null)], "0.2.0").stale).toHaveLength(1);
  });
});

describe("what doctor actually prints", () => {
  const at = (version: string | null, scope = "user", profile = "/home/u/.claude", dangling = false) => ({
    profile,
    scope,
    version,
    installPath: `${profile}/cache`,
    dangling,
  });

  it("names every install, so updating one cannot look like updating all", () => {
    // The exact state this was built for, measured on a real machine.
    const lines = describePlugins(
      [
        at("0.2.0", "user", "/home/u/.claude-nv"),
        at("0.1.0", "project", "/home/u/.claude-nv"),
        at("0.1.0", "user", "/home/u/.claude"),
      ],
      "0.2.0",
    );
    expect(lines.filter((l) => l.includes("0.1.0"))).toHaveLength(2);
    expect(lines.some((l) => l.includes("0.2.0") && l.includes("current"))).toBe(true);
    expect(lines.some((l) => l.includes("claude plugin update"))).toBe(true);
  });

  it("says nothing to fix when every install is current", () => {
    // Advice that appears when nothing is wrong is advice nobody reads.
    const lines = describePlugins([at("0.2.0"), at("0.2.0", "project")], "0.2.0");
    expect(lines.some((l) => l.includes("claude plugin update"))).toBe(false);
    expect(lines.every((l) => l.includes("current"))).toBe(true);
  });

  it("offers the fix once, not once per stale install", () => {
    const lines = describePlugins([at("0.1.0"), at("0.1.0", "project")], "0.2.0");
    expect(lines.filter((l) => l.includes("claude plugin update"))).toHaveLength(1);
  });

  it("does not grade a machine with no plugin install", () => {
    // `astir install --no-plugin` is supported; so is wiring hooks by hand.
    const lines = describePlugins([], "0.2.0");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("not installed as a plugin");
    expect(lines[0]).not.toContain("update");
  });

  it("distinguishes an install that is gone from one that is merely old", () => {
    const lines = describePlugins([at("0.2.0", "user", "/home/u/.claude", true)], "0.2.0");
    expect(lines[0]).toContain("MISSING from disk");
    // And it still counts as something to fix, despite matching on paper.
    expect(lines.some((l) => l.includes("claude plugin update"))).toBe(true);
  });

  it("labels only the first row, and aligns the rest to it", () => {
    // Every other row in the report puts its value at one column. A block that
    // drifts a space left reads as a different kind of line.
    //
    // The CURRENT install is deliberately not first. Profile order decides
    // which install leads, and nothing guarantees it is the updated one — so a
    // fixture with `current` at index 0 cannot tell "label the first row" from
    // "label every current row", and a mutation doing the latter survived it.
    const lines = describePlugins([at("0.1.0", "project"), at("0.2.0")], "0.2.0");
    expect(lines[1], "the current install is the one being checked here").toContain("current");
    expect(lines[0]).toMatch(/^ {2}plugin {10}\S/);
    for (const line of lines.slice(1)) {
      expect(line, `"${line}" should align at the same column`).toMatch(/^ {18}\S/);
      expect(line).not.toContain("plugin  ");
    }
  });
});
