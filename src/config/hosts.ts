/**
 * DMN-09 — which machines astir may reach out to.
 *
 * An explicit list, because the alternative is worse in both directions:
 * SSH-ing to every `Host` in `~/.ssh/config` would connect to production boxes,
 * jump hosts and long-dead entries on a timer, while requiring a full `astir
 * pair` would gate the feature on installing astir remotely — and the entire
 * point of the SSH route is that it works when nothing is installed over there.
 *
 * Paired hosts are watched automatically (pairing is already a stronger opt-in),
 * so this file is only needed for the lighter case.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { astirDir } from "./paths.js";

export function hostsPath(home: string = homedir()): string {
  return join(astirDir(home), "hosts");
}

/** One host per line. `#` comments and blank lines are ignored. */
export function parseHosts(contents: string): string[] {
  const out: string[] = [];
  for (const raw of contents.split("\n")) {
    const line = raw.split("#")[0]?.trim() ?? "";
    if (line.length === 0) continue;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

export function readWatchedHosts(home: string = homedir()): string[] {
  const path = hostsPath(home);
  if (!existsSync(path)) return [];
  try {
    return parseHosts(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

export interface WatchResult {
  ok: boolean;
  added: boolean;
  path: string;
}

export function addWatchedHost(host: string, home: string = homedir()): WatchResult {
  const path = hostsPath(home);
  const existing = readWatchedHosts(home);
  if (existing.includes(host)) return { ok: true, added: false, path };

  mkdirSync(astirDir(home), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${[...existing, host].join("\n")}\n`);
  return { ok: true, added: true, path };
}

export function removeWatchedHost(host: string, home: string = homedir()): WatchResult {
  const path = hostsPath(home);
  const existing = readWatchedHosts(home);
  if (!existing.includes(host)) return { ok: true, added: false, path };

  writeFileSync(path, `${existing.filter((h) => h !== host).join("\n")}\n`);
  return { ok: true, added: false, path };
}
