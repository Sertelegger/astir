import ignore from "ignore";

export type SpecChange = "created" | "updated" | "deleted";
export const DEFAULT_SPEC_GLOBS = ["docs/**/*.md", "**/specs/**/*.md", "**/plans/**/*.md"];

/** True if a repo-relative path matches any spec/plan glob (gitignore-glob semantics via `ignore`). */
export function matchesSpec(path: string, globs: string[]): boolean {
  if (globs.length === 0) return false;
  return ignore().add(globs).ignores(path);
}

export interface SpecTrackerOpts { debounceMs?: number; now?: () => number; }

/** Tracks known specs (created vs updated) and per-path emit debounce (REQ-070/071). */
export class SpecTracker {
  private known = new Set<string>();
  private lastEmit = new Map<string, number>();
  private readonly debounceMs: number;
  private readonly now: () => number;
  constructor(opts: SpecTrackerOpts = {}) {
    this.debounceMs = opts.debounceMs ?? 300;
    this.now = opts.now ?? (() => Date.now());
  }
  seed(paths: string[]): void { for (const p of paths) this.known.add(p); }
  onWrite(path: string): SpecChange { if (this.known.has(path)) return "updated"; this.known.add(path); return "created"; }
  onDelete(path: string): SpecChange { this.known.delete(path); return "deleted"; }
  /** Per-path debounce: true if enough time has elapsed since the last emit for this path. */
  shouldEmit(path: string): boolean {
    const t = this.now();
    const last = this.lastEmit.get(path) ?? -Infinity;
    if (t - last < this.debounceMs) return false;
    this.lastEmit.set(path, t);
    return true;
  }
}
