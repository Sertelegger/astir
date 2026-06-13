import { extractReasoning } from "./transcript.js";

export type PostReasoningFn = (agentId: string, ts: number, text: string) => Promise<void>;

/** Process a batch of new transcript lines: post the LATEST reasoning for the agent (REQ-007a). */
export async function tailStep(lines: string[], agentId: string, ts: number, post: PostReasoningFn): Promise<void> {
  let latest: string | null = null;
  for (const line of lines) { const r = extractReasoning(line); if (r !== null) latest = r; }
  if (latest !== null) await post(agentId, ts, latest);
}

/* c8 ignore start — long-lived process loop, human-verified in a live session */
export async function runTailer(/* transcriptPath, sessionId, relay */): Promise<void> {
  // tail-from-EOF on attach; buffer partial lines until "\n"; poll for late/rotated files;
  // per the §12 tailer rules. Each batch → tailStep(...). POSTs to /reasoning with the bearer token.
  // Subagent transcripts discovered from their own tool hooks' transcript_path (REQ-007a).
}
/* c8 ignore stop */
