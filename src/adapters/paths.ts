/**
 * CAP-03/04 — the path handling every adapter shares.
 *
 * These lived in the Claude adapter, so a second provider had to import from
 * `adapters/claude/` to make a path repo-relative — the same boundary problem
 * `types.ts` was extracted to fix. Nothing here knows any provider's wire
 * format: it is "which keys name a path" and "where is that path in the repo".
 */

import { homedir } from "node:os";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

/**
 * Keys that name a path in a tool's input, across providers.
 *
 * Read from EVERY tool, recognised or not — CAP-03 keeps paths even for an
 * `other` op, because MCP filesystem tools carry real ones and v1 threw them
 * away.
 */
const PATH_KEYS = ["file_path", "notebook_path", "path"] as const;

/** The non-empty path arguments of a tool's input, in key order. */
export function pathArgs(input: unknown): string[] {
  const out: string[] = [];
  if (typeof input !== "object" || input === null) return out;
  const o = input as Record<string, unknown>;
  for (const k of PATH_KEYS) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) out.push(v);
  }
  return out;
}

/**
 * CAP-04 — repo-relative, posix-normalized, resolved once at the boundary.
 * Returns null for anything that escapes the root; callers count the drop.
 */
export function toRepoRelative(cwd: string, raw: string, realpath: (p: string) => string): string | null {
  if (raw.length === 0) return null;
  let abs = raw.startsWith("~") ? resolve(homedir(), raw.slice(1).replace(/^[/\\]/, "")) : raw;
  if (!isAbsolute(abs)) abs = resolve(cwd, abs);
  // Resolve symlinks so a linked repo root does not produce `../..` paths that the
  // model then silently drops. Falls back to the literal path when the file does
  // not exist yet, which is the normal case for a Write.
  const realCwd = realpath(cwd);
  const realAbs = realpath(abs);
  const rel = relative(realCwd, realAbs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join(posix.sep);
}
