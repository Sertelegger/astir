import { basename } from "node:path";
import type { Op } from "../contract/types.js";

const TOOL_CALL_RE = /\b\w+\([^)]*\)/; // e.g. Edit(...) — forbidden in a Now line
const VERBISH_RE = /\b\w+(ing|ed|s)\b/i;

export function passesNowGate(s: string): boolean {
  if (s.length === 0 || s.length > 80) return false;
  if (TOOL_CALL_RE.test(s)) return false;
  if (s.includes("{") || s.includes("}")) return false;
  return VERBISH_RE.test(s);
}

/** First meaningful sentence, markdown stripped, <=80 chars. REQ-033(a)/(b). */
export function condense(text: string): string {
  const stripped = text
    .replace(/[*_`#>]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const firstSentence = stripped.split(/(?<=[.!?])\s/)[0] ?? stripped;
  const noTrailingPunct = firstSentence.replace(/[.!?]+$/, "").trim();
  return noTrailingPunct.slice(0, 80);
}

const OP_VERB: Record<Op, string> = { edit: "Editing", write: "Writing", read: "Reading", other: "Working on" };

export function templatePhrase(op: Op | null, path?: string): string {
  const verb = OP_VERB[op ?? "other"];
  const target = path ? basename(path) : "the repo";
  return `${verb} ${target}`;
}

/** Latest-by-ts reasoning text per agentId, bounded (REQ-012a). */
export class ReasoningStore {
  private map = new Map<string, { ts: number; text: string }>();
  constructor(private maxEntries = 256) {}

  put(agentId: string, ts: number, text: string): void {
    const cur = this.map.get(agentId);
    if (cur && ts <= cur.ts) return;             // highest-ts wins
    this.map.delete(agentId);                    // re-insert to keep LRU order
    this.map.set(agentId, { ts, text });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get(agentId: string): string | undefined { return this.map.get(agentId)?.text; }
  drop(agentId: string): void { this.map.delete(agentId); }
  size(): number { return this.map.size; }
}
