import { spawn } from "node:child_process";
import type { ModelFn, EgressFields } from "./auto-summarizer.js";

export function buildPrompt(fields: EgressFields): string {
  return `In 8 words or fewer, describe what a coding agent is doing right now, based on these recent tool actions (filenames only, no file contents): ${JSON.stringify(fields)}. Reply with only the phrase, no preamble.`;
}

export function buildClaudeArgs(prompt: string, model = "haiku"): string[] {
  return ["-p", prompt, "--model", model, "--bare", "--output-format", "text"];
}

export function buildCodexArgs(prompt: string, model?: string): string[] {
  const base = ["exec", "--sandbox", "read-only", "--ask-for-approval", "never"];
  return model ? [...base, "-m", model, prompt] : [...base, prompt];
}

/* c8 ignore start — spawns the provider CLI; reuses the user's subscription login; verified manually */
function run(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ""; let done = false;
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], env: process.env });
    const timer = setTimeout(() => { if (!done) { done = true; child.kill("SIGKILL"); resolve(null); } }, timeoutMs);
    child.stdout.on("data", (d) => { out += String(d); });
    child.on("error", () => { if (!done) { done = true; clearTimeout(timer); resolve(null); } });
    child.on("close", (code) => { if (done) return; done = true; clearTimeout(timer); resolve(code === 0 ? out.trim() || null : null); });
  });
}

/** A ModelFn that reuses the installed, already-logged-in CLI (subscription) — no API key. */
export function cliModelFn(provider: "claude" | "codex", opts: { model?: string; timeoutMs?: number } = {}): ModelFn {
  const timeout = opts.timeoutMs ?? 15_000;
  return async (fields) => {
    const prompt = buildPrompt(fields);
    if (provider === "codex") return run("codex", buildCodexArgs(prompt, opts.model), timeout);
    return run("claude", buildClaudeArgs(prompt, opts.model ?? "haiku"), timeout);
  };
}
/* c8 ignore stop */
