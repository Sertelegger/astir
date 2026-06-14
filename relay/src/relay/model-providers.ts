import type { ModelFn } from "./auto-summarizer.js";
import { AutoSummarizer } from "./auto-summarizer.js";
import { OffSummarizer, type Summarizer } from "./summarizer.js";
import { cliModelFn } from "./cli-model.js";

export interface SummarizerConfig { mode: "auto" | "off"; provider: "claude" | "codex"; model?: string; transport?: "cli" | "api"; }

/** Fixed per-provider egress endpoints (REQ-092) — clide.summarizer.model MUST NOT redirect to an arbitrary host. */
const ENDPOINTS = { claude: "https://api.anthropic.com/v1/messages", codex: "https://api.openai.com/v1/chat/completions" } as const;

/* c8 ignore start — real HTTP model calls; verified manually with an API key */
const claudeModelFn: ModelFn = async (fields) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const res = await fetch(ENDPOINTS.claude, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 32, messages: [{ role: "user", content: `In <=8 words, describe what a coding agent is doing now, given these recent tool actions (no file contents): ${JSON.stringify(fields)}. Reply with only the phrase.` }] }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const body = (await res.json()) as { content?: Array<{ text?: string }> };
  return body.content?.[0]?.text ?? null;
};
const codexModelFn: ModelFn = async (fields) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const res = await fetch(ENDPOINTS.codex, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 32, messages: [{ role: "user", content: `In <=8 words, describe what a coding agent is doing now: ${JSON.stringify(fields)}. Only the phrase.` }] }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content ?? null;
};
/* c8 ignore stop */

export function makeSummarizer(config: SummarizerConfig): Summarizer {
  if (config.mode === "off") return new OffSummarizer();
  if (config.transport === "api") {
    const fn: ModelFn = config.provider === "codex" ? codexModelFn : claudeModelFn;
    return new AutoSummarizer(fn);
  }
  // Default: "cli" transport — reuses subscription login, no API key needed
  return new AutoSummarizer(cliModelFn(config.provider, { model: config.model }));
}
