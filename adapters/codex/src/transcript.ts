/** Extract reasoning text from one Codex rollout JSONL line (OV6 fallback: reasoning item or agent_message). */
export function extractCodexReasoning(jsonlLine: string): string | null {
  let obj: unknown;
  try { obj = JSON.parse(jsonlLine); } catch { return null; }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const item = o.item as Record<string, unknown> | undefined;
  if (o.type === "response_item" && item?.type === "reasoning" && typeof item.text === "string") return item.text;
  const msg = o.msg as Record<string, unknown> | undefined;
  if (o.type === "event_msg" && msg?.type === "agent_message" && typeof msg.message === "string") return msg.message;
  return null;
}
