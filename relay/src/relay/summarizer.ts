import { basename } from "node:path";
import type { Kind, Op } from "../contract/types.js";

export interface SummarizerEvent { kind: Kind; tool: string | null; op: Op | null; paths: string[]; }

/** The ONLY fields permitted to leave the machine when summarizer=auto (REQ-036). */
export function egressFields(events: SummarizerEvent[]): Array<{ kind: Kind; tool: string | null; op: Op | null; basenames: string[] }> {
  return events.slice(-8).map((e) => ({ kind: e.kind, tool: e.tool, op: e.op, basenames: e.paths.map((p) => basename(p)) }));
}

export interface Summarizer {
  /** Return a friendly phrase (<=80 chars) or null to fall back to template. */
  summarize(agentId: string, events: SummarizerEvent[]): Promise<string | null>;
}

/** clide.summarizer = "off" — guarantees no network egress (REQ-034). The P5 plan adds the real model-backed implementation behind this same interface. */
export class OffSummarizer implements Summarizer {
  async summarize(): Promise<string | null> { return null; }
}
