/**
 * CAP-01 — register astir's plugin with each agent CLI, without the user
 * hand-editing anything or typing slash commands.
 *
 * Deliberately invoked from an explicit `astir install`, never from an npm
 * `postinstall`. Reaching into another tool's configuration as a side effect of
 * `npm install` is the behaviour the ecosystem treats as hostile, and it would
 * fire under `npm ci` in CI, inside Docker builds, and for transitive installs
 * where nobody asked for any of this.
 */

import { execFileSync } from "node:child_process";

export interface PluginCli {
  /** What the user calls it, for the lines `astir install` prints. */
  name: string;
  bin: string;
  marketplaceAdd: (root: string) => string[];
  install: string[];
}

export const CLAUDE_CLI: PluginCli = {
  name: "Claude Code",
  bin: "claude",
  marketplaceAdd: (root) => ["plugin", "marketplace", "add", root],
  install: ["plugin", "install", "astir@astir-marketplace", "--yes"],
};

/**
 * Codex reads the same `.claude-plugin/marketplace.json`, then the plugin's
 * `.codex-plugin/plugin.json`, which points it at `hooks/codex-hooks.json`.
 * Neither command prompts. `plugin add` has no already-installed check — it
 * re-copies — so running it again is how an install is refreshed.
 */
export const CODEX_CLI: PluginCli = {
  name: "Codex",
  bin: "codex",
  marketplaceAdd: (root) => ["plugin", "marketplace", "add", root],
  install: ["plugin", "add", "astir@astir-marketplace"],
};

export type Run = (
  bin: string,
  args: string[],
) => { ok: true; detail: string } | { ok: false; detail: string; absent: boolean };

export const defaultRun: Run = (bin, args) => {
  try {
    const stdout = execFileSync(bin, args, {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, detail: stdout.trim() };
  } catch (err) {
    const e = err as { code?: string; stderr?: Buffer | string; message?: string };
    const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString();
    return { ok: false, detail: (stderr || e.message || "failed").trim(), absent: e.code === "ENOENT" };
  }
};

/**
 * `absent` when the CLI is not installed at all — not a failure, since nobody
 * has to use both — so the caller can say nothing rather than print a fix for
 * a tool the user does not have.
 */
export function registerPlugin(
  cli: PluginCli,
  root: string,
  out: (line: string) => void,
  run: Run = defaultRun,
): "ok" | "failed" | "absent" {
  const market = run(cli.bin, cli.marketplaceAdd(root));
  if (!market.ok && market.absent) return "absent";
  // Adding a marketplace that is already known is a success for our purposes.
  if (!market.ok && !/already/i.test(market.detail)) {
    out(`  could not add the marketplace: ${market.detail}`);
    return "failed";
  }

  const install = run(cli.bin, cli.install);
  if (!install.ok && !/already/i.test(install.detail)) {
    out(`  could not install the plugin: ${install.detail}`);
    return "failed";
  }
  return "ok";
}
