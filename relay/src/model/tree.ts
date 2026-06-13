import { readdirSync, readFileSync, statSync, lstatSync, realpathSync } from "node:fs";
import { join, relative, sep, posix } from "node:path";
import ignore from "ignore";
import type { Clock } from "./clock.js";
import { FileHeat } from "./heat.js";

export interface LeafNode {
  path: string;      // repo-relative, posix separators
  type: "file";
  loc: number;
  binary: boolean;
  heat: FileHeat;
}

export class RepoTree {
  private leaves = new Map<string, LeafNode>();
  droppedPaths = 0;
  private ig = ignore();

  constructor(private root: string, private clock: Clock, private halfLifeSeconds = 30) {}

  build(): void {
    const gi = join(this.root, ".gitignore");
    try { this.ig = ignore().add(readFileSync(gi, "utf8")); } catch { /* none */ }
    this.scan(this.root, new Set());
  }

  private scan(absDir: string, seen: Set<string>): void {
    let entries: string[];
    try { entries = readdirSync(absDir); } catch { return; }
    for (const name of entries) {
      if (name === ".git") continue;
      const abs = join(absDir, name);
      const rel = this.toRel(abs);
      if (!rel) continue;
      if (this.ig.ignores(rel)) continue;
      let st;
      try { st = lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) {
        // Realpath-resolve; skip if it escapes the repo or loops.
        let real: string;
        try { real = realpathSync(abs); } catch { continue; }
        if (!this.toRel(real) || seen.has(real)) continue;
        try { st = statSync(real); } catch { continue; }
        if (st.isDirectory()) { if (!seen.has(real)) { seen.add(real); this.scan(real, seen); } continue; }
      }
      if (st.isDirectory()) { this.scan(abs, seen); }
      else if (st.isFile()) { this.addLeafFromDisk(rel, abs); }
    }
  }

  /** repo-relative posix path, or null if outside the repo root. */
  private toRel(abs: string): string | null {
    const rel = relative(this.root, abs);
    if (rel === "" || rel.startsWith("..") || rel.includes(`..${sep}`)) return null;
    return rel.split(sep).join(posix.sep);
  }

  private countLoc(content: string): number {
    // Count newlines: "line1\nline2\nline3\n" → 3 newlines → 3 lines.
    // This matches the convention that a file ending with \n has N lines
    // where N equals the number of \n characters.
    const lines = content.split("\n");
    // If the last element is empty (file ends with \n), subtract it.
    return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  }

  private addLeafFromDisk(rel: string, abs: string): void {
    let loc = 0, binary = false;
    try {
      const buf = readFileSync(abs);
      binary = buf.includes(0);
      if (binary) {
        loc = Math.max(1, Math.ceil(buf.length / 80));
      } else {
        const content = buf.toString("utf8");
        loc = this.countLoc(content);
      }
    } catch { /* unreadable: treat as 1-line binary */ binary = true; loc = 1; }
    this.leaves.set(rel, { path: rel, type: "file", loc, binary, heat: new FileHeat(this.clock, this.halfLifeSeconds) });
  }

  getLeaf(rel: string): LeafNode | undefined { return this.leaves.get(this.normalizeIncoming(rel)); }

  private normalizeIncoming(rel: string): string { return rel.split(sep).join(posix.sep); }

  /** Add heat, creating the node on first touch. Out-of-repo paths are counted, not added. */
  touchFile(rel: string, op: import("../contract/types.js").Op, wallTs: number): LeafNode | null {
    if (rel.startsWith("..") || rel.includes(`..${posix.sep}`) || rel.startsWith("/")) { this.droppedPaths++; return null; }
    const key = this.normalizeIncoming(rel);
    let leaf = this.leaves.get(key);
    if (!leaf) {
      leaf = { path: key, type: "file", loc: 1, binary: false, heat: new FileHeat(this.clock, this.halfLifeSeconds) };
      this.leaves.set(key, leaf);
    }
    leaf.heat.touch(op, wallTs);
    if (op === "write" || op === "edit") this.refreshLoc(leaf);
    return leaf;
  }

  removeFile(rel: string): void { this.leaves.delete(this.normalizeIncoming(rel)); }

  private refreshLoc(leaf: LeafNode): void {
    try {
      const buf = readFileSync(join(this.root, leaf.path));
      leaf.binary = buf.includes(0);
      if (leaf.binary) {
        leaf.loc = Math.max(1, Math.ceil(buf.length / 80));
      } else {
        const content = buf.toString("utf8");
        leaf.loc = this.countLoc(content);
      }
    } catch { /* deleted between events — leave prior loc */ }
  }

  maxLeafHeat(): number {
    let max = 0;
    for (const l of this.leaves.values()) { const v = l.heat.value(); if (v > max) max = v; }
    return max;
  }

  allLeaves(): LeafNode[] { return [...this.leaves.values()]; }
}
