import { extractCodexReasoning } from "./transcript.js";

export type PostReasoningFn = (agentId: string, ts: number, text: string) => Promise<void>;

/** Process a batch of new rollout JSONL lines: post the LATEST reasoning for the agent (REQ-007a). */
export async function tailStep(lines: string[], agentId: string, ts: number, post: PostReasoningFn): Promise<void> {
  let latest: string | null = null;
  for (const line of lines) { const r = extractCodexReasoning(line); if (r !== null) latest = r; }
  if (latest !== null) await post(agentId, ts, latest);
}

