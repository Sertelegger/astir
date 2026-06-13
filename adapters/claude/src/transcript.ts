/** Extract the assistant's latest reasoning text from one Claude transcript JSONL line, or null. */
export function extractReasoning(jsonlLine: string): string | null {
  let obj: unknown;
  try { obj = JSON.parse(jsonlLine); } catch { return null; }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (o.type !== "assistant") return null;
  const msg = o.message as Record<string, unknown> | undefined;
  const content = msg?.content;
  if (!Array.isArray(content)) return null;
  let text: string | null = null;
  let thinking: string | null = null;
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === "text" && typeof block.text === "string") text = block.text;
    else if (block.type === "thinking" && typeof block.text === "string") thinking = block.text;
  }
  return text ?? thinking;
}
