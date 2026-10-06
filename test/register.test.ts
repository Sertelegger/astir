/**
 * CAP-01 — `astir install` registers the plugin with each agent CLI.
 *
 * This shelled out with nothing asserting the arguments, so a typo in a
 * subcommand would have surfaced as "could not install" on someone's machine
 * and nowhere else.
 */

import { describe, expect, it } from "vitest";
import { CLAUDE_CLI, CODEX_CLI, type Run, registerPlugin } from "../src/config/register.js";

function recorder(answers: Array<ReturnType<Run>> = []) {
  const calls: string[][] = [];
  const run: Run = (bin, args) => {
    calls.push([bin, ...args]);
    return answers.shift() ?? { ok: true, detail: "" };
  };
  return { calls, run };
}

describe("registerPlugin", () => {
  it("adds the marketplace from this checkout, then installs astir — Claude", () => {
    const r = recorder();
    expect(registerPlugin(CLAUDE_CLI, "/src/astir", () => {}, r.run)).toBe("ok");
    expect(r.calls).toEqual([
      ["claude", "plugin", "marketplace", "add", "/src/astir"],
      ["claude", "plugin", "install", "astir@astir-marketplace", "--yes"],
    ]);
  });

  it("does the same through Codex's own commands", () => {
    // Codex reads the same marketplace.json; its install verb is `add` and it
    // takes no --yes (verified against codex-rs/cli at rust-v0.154.0).
    const r = recorder();
    expect(registerPlugin(CODEX_CLI, "/src/astir", () => {}, r.run)).toBe("ok");
    expect(r.calls).toEqual([
      ["codex", "plugin", "marketplace", "add", "/src/astir"],
      ["codex", "plugin", "add", "astir@astir-marketplace"],
    ]);
  });

  it("treats a marketplace that is already added as success", () => {
    const r = recorder([
      {
        ok: false,
        detail: "Marketplace `astir-marketplace` is already added from /src/astir",
        absent: false,
      },
    ]);
    expect(registerPlugin(CODEX_CLI, "/src/astir", () => {}, r.run)).toBe("ok");
    expect(r.calls).toHaveLength(2);
  });

  it("says nothing and installs nothing when the CLI is not there", () => {
    // Most people use one agent. A fix for a tool they do not have is noise.
    const lines: string[] = [];
    const r = recorder([{ ok: false, detail: "spawnSync codex ENOENT", absent: true }]);
    expect(registerPlugin(CODEX_CLI, "/src/astir", (l) => lines.push(l), r.run)).toBe("absent");
    expect(r.calls).toHaveLength(1);
    expect(lines).toEqual([]);
  });

  it("reports a real failure with the CLI's own words", () => {
    const lines: string[] = [];
    const r = recorder([
      { ok: true, detail: "" },
      { ok: false, detail: "plugin not found", absent: false },
    ]);
    expect(registerPlugin(CODEX_CLI, "/src/astir", (l) => lines.push(l), r.run)).toBe("failed");
    expect(lines).toEqual(["  could not install the plugin: plugin not found"]);
  });
});
