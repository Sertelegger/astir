/**
 * DMN-05 — every Claude Code profile on this machine, not just the one the
 * daemon happened to inherit.
 *
 * `claude agents --json` is scoped to `$CLAUDE_CONFIG_DIR`. A machine running
 * two profiles has two independent session registries — the same repo open in
 * both gets two different session ids — so a daemon that polls one of them is
 * blind to the other.
 *
 * That blindness is not obvious, because HOOKS do not care about profiles: they
 * are configured per profile but POST to the same daemon on the same port. So a
 * session from an unpolled profile arrives, registers, and is then never
 * enriched — no name, no pid, no `attended`. It shows up as a bare folder name,
 * cannot be focused, and cannot be told apart from a background session. Worse,
 * `everDiscovered` stays false, so it is also exempt from pruning and lingers
 * after it ends.
 *
 * This is the fourth time this project has been bitten by the same assumption —
 * SwiftBar's launchd PATH, the SSH poll's non-login shell, `astir pair`'s
 * non-login shell, and now this. The shape is always: **the process assumed the
 * environment it inherited was the whole world.**
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProfileDeps {
  home: string;
  /** `$CLAUDE_CONFIG_DIR`, when the daemon was started with one. */
  configDir?: string | undefined;
  entries: (dir: string) => string[];
  isProfile: (path: string) => boolean;
  /** Resolves links so two names for one directory are not polled twice. */
  real: (path: string) => string;
}

/** A directory is a used profile if it holds the per-project session store. */
export const looksLikeProfile = (path: string): boolean => {
  try {
    return statSync(join(path, "projects")).isDirectory();
  } catch {
    return false;
  }
};

export function defaultProfileDeps(): ProfileDeps {
  return {
    home: homedir(),
    configDir: process.env.CLAUDE_CONFIG_DIR,
    entries: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    isProfile: looksLikeProfile,
    real: (path) => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    },
  };
}

/**
 * Config directories worth polling, most authoritative first.
 *
 * The daemon's own `$CLAUDE_CONFIG_DIR` leads, then the default `~/.claude`,
 * then any sibling `~/.claude*` that has actually been used. Siblings are found
 * rather than configured because the failure this fixes is invisible: nobody
 * thinks to tell a daemon about a profile they did not know it was missing.
 */
export function candidateConfigDirs(deps: ProfileDeps = defaultProfileDeps()): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (path: string): void => {
    const key = deps.real(path);
    if (seen.has(key)) return;
    seen.add(key);
    found.push(path);
  };

  // Always polled, whether or not they look used: the daemon was told about one
  // and the other is where Claude Code looks by default. An empty profile costs
  // one fast call that returns nothing.
  if (deps.configDir !== undefined && deps.configDir.length > 0) add(deps.configDir);
  add(join(deps.home, ".claude"));

  for (const entry of deps.entries(deps.home).sort()) {
    if (!entry.startsWith(".claude")) continue;
    const path = join(deps.home, entry);
    if (deps.isProfile(path)) add(path);
  }
  return found;
}

/** True when this machine runs more than one profile — worth saying out loud. */
export const hasMultipleProfiles = (dirs: readonly string[]): boolean => dirs.length > 1;

export { existsSync };
