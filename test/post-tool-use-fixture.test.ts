/**
 * §9 — fixtures are captured, never invented.
 *
 * One fixture existed (`subagent-start.json`) and `PostToolUse` — the event
 * that carries every path the map is built from — had none. So the adapter's
 * busiest branch was exercised only against payloads written from memory by the
 * person who also wrote the code reading them.
 *
 * Capturing one settled an open question immediately: the result field is
 * `tool_response`, and both spec A2 and the comment beside the code said
 * `tool_output`. Nothing read it — `ok` comes from the event kind — so the
 * error was documentation rather than behaviour. That is the kind of thing only
 * a real payload tells you.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeClaudeHook } from "../src/adapters/claude/normalize.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "claude", "post-tool-use.json");
const payload = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
const deps = {
  readSidecar: () => null,
  newId: () => "e1",
  realpath: (p: string) => p,
  now: () => 1_787_000_000,
};

describe("the fixture is a capture, not a construction", () => {
  it("records where it came from", () => {
    // Without this the file is indistinguishable from something typed out, and
    // a fixture nobody can trace is one nobody can re-capture when it drifts.
    const cap = payload._capture as Record<string, string>;
    expect(cap.provider).toBe("claude");
    expect(cap.cliVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(cap.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("carries the result field under the name the provider actually uses", () => {
    // THE finding. Asserted on the observed NAME rather than on anything astir
    // consumes, so a re-capture that renames it fails here loudly instead of
    // silently agreeing with a stale document.
    expect(payload).toHaveProperty("tool_response");
    expect(payload).not.toHaveProperty("tool_output");
  });

  it("shows Bash carrying no path key, which is why CAP-06 exists", () => {
    // `classifyTool` reads `file_path`, `notebook_path` and `path`. Bash has
    // none of them, so every shell-driven write is invisible without
    // `FileChanged` — this fixture is the evidence for that claim.
    const input = payload.tool_input as Record<string, unknown>;
    expect(payload.tool_name).toBe("Bash");
    expect(Object.keys(input).sort()).toEqual(["command", "description"]);
  });
});

describe("the adapter reads it", () => {
  const result = normalizeClaudeHook(payload, deps as never);

  it("normalizes to a post_tool event", () => {
    expect(result.event?.kind).toBe("post_tool");
  });

  it("derives ok from the event kind, not from the result field", () => {
    // Which is why naming that field wrongly for months cost nothing.
    expect(result.event?.ok).toBe(true);
  });

  it("extracts no paths from a Bash call", () => {
    expect(result.event?.paths).toEqual([]);
  });

  it("attributes it to the session that sent it", () => {
    expect(result.event?.sessionId).toBe(payload.session_id);
  });
});
