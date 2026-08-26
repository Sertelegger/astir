/** Where Astir keeps its little bit of local state. Nothing here is session content. */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_PORT = 47_000;

export function astirDir(home: string = homedir()): string {
  return join(home, ".astir");
}

export function tokenPath(home: string = homedir()): string {
  return join(astirDir(home), "token");
}

/**
 * DMN-07 — write atomically and with a restrictive mode.
 *
 * `writeFileSync`'s `mode` is the *creation* mode: POSIX ignores it when the file
 * already exists, so a leftover 0644 file would silently keep its permissions and
 * leave the token world-readable. Write to a temp file, chmod it explicitly, then
 * rename — which also makes the swap atomic for a concurrent reader.
 */
export function writeSecret(path: string, contents: string, opts: { requireDir?: boolean } = {}): void {
  // Callers writing outside ~/.astir (INS-04 writes Claude Code's settings.json)
  // have no guarantee the directory exists yet.
  if (opts.requireDir === true) mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/**
 * The daemon's bearer token, stable across restarts so a hook configuration
 * written once keeps working. Created on first use.
 */
export function readOrCreateToken(home: string = homedir()): string {
  const dir = astirDir(home);
  const path = tokenPath(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 32) {
      // Re-assert the mode: an older version, a restore, or a stray umask could
      // have left it readable.
      chmodSync(path, 0o600);
      return existing;
    }
  }

  const token = randomBytes(32).toString("hex");
  writeSecret(path, `${token}\n`);
  return token;
}

export function readTokenIfPresent(home: string = homedir()): string | null {
  const path = tokenPath(home);
  if (!existsSync(path)) return null;
  const t = readFileSync(path, "utf8").trim();
  return t.length >= 32 ? t : null;
}
