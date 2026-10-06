/**
 * CAP-02/03 — Codex hook payload → §10.1 event.
 *
 * Written against `test/fixtures/codex/capture.json`, captured from codex-cli
 * 0.154.0, never against the published schemas: those give the declared shape,
 * and a capture gives the shape a session actually sends.
 *
 * ## What Codex does not say, and what that costs
 *
 * **No reads.** Codex reads files through its shell — `cat`, `sed`, `rg` — so
 * the only path-bearing tool is `apply_patch`. A Codex session's map shows what
 * it wrote, never what it looked at. Guessing paths out of a command line would
 * put tiles on the map for words that merely look like files.
 *
 * **Three events are mapped from Codex's declared schema, not a capture.**
 * `Interrupt`, `SubagentStart` and `SubagentStop` never occurred in a captured
 * session, but leaving them unmapped is worse than §14's risk: without
 * `Interrupt`, Esc at an approval prompt leaves the agent "blocked" and
 * reminding you forever; without `agent_id`, a subagent's events land on the
 * root agent and clear its real block. So they read only the fields the
 * rust-v0.154.0 schema declares REQUIRED (`fixtures/codex/declared.json`
 * cites the lines), and they are the first thing to re-check against a capture.
 *
 * **No parentage.** Every agent in a Codex tree shares the root's
 * `session_id`, and the hooks name a subagent but not its parent, so every
 * subagent is attached to the root and marked inferred (CAP-05 route 3).
 *
 * ## SEC-01
 *
 * `UserPromptSubmit` carries the prompt and `Stop` carries the model's last
 * reply. The relay strips both before they leave Codex, and this file never
 * reads either — the second line of defence is not reading a field at all.
 */

import { CONTRACT_VERSION, type Kind, type Op } from "../../contract/event.js";
import { pathArgs, toRepoRelative } from "../paths.js";
import type { NormalizeDeps, NormalizeResult } from "../types.js";

/**
 * Deliberately unmapped: `UserPromptSubmit` (it carries the prompt and nothing
 * else astir uses) and `PreCompact`/`PostCompact` (bookkeeping, not activity).
 */
const KIND_BY_HOOK: Record<string, Kind> = {
  SessionStart: "session_start",
  PreToolUse: "pre_tool",
  PostToolUse: "post_tool",
  PermissionRequest: "notification",
  Stop: "stop",
  // A turn the user cut short ended as surely as one that finished — and Esc
  // at an approval prompt fires this, never Stop and never PostToolUse.
  Interrupt: "stop",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  SessionEnd: "session_end",
};

/**
 * One `apply_patch` directive. The grammar also has `*** Begin Patch`,
 * `*** End Patch` and `*** End of File`, none of which name a file.
 */
const DIRECTIVE = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/;

/**
 * The files an `apply_patch` call leaves behind, and what it did to them.
 *
 * Paths are where the work ENDS UP, because that is what the map shows:
 *
 * - a moved file is recorded at its destination — the source no longer exists,
 *   and heat on it would be a tile nothing can ever touch again;
 * - a deleted file is not recorded at all, for the same reason a `FileChanged`
 *   unlink is not (see the Claude adapter).
 *
 * The op is the strongest thing the patch did. One event carries one op, and a
 * patch that both creates and edits files is an edit with a new file in it.
 */
export function patchTargets(patch: string): { op: Op; rawPaths: string[] } {
  const updated: string[] = [];
  const added: string[] = [];
  let previous: string | null = null;
  for (const line of patch.split("\n")) {
    const m = DIRECTIVE.exec(line.trimEnd());
    if (m === null) continue;
    const [, verb, path] = m as unknown as [string, string, string];
    if (verb === "Update File") updated.push(path);
    else if (verb === "Add File") added.push(path);
    // A move belongs to the `Update File` directly above it, and to nothing
    // else — after an `Add File` it would rename the wrong file.
    else if (verb === "Move to" && previous === "Update File") updated[updated.length - 1] = path;
    previous = verb;
  }
  const op: Op = updated.length > 0 ? "edit" : added.length > 0 ? "write" : "other";
  return { op, rawPaths: [...updated, ...added] };
}

/** CAP-03 for Codex's tool names. Unknown tools are `other`, never dropped. */
export function classifyCodexTool(tool: string, input: unknown): { op: Op; rawPaths: string[] } {
  if (tool === "apply_patch") {
    const command = (input as { command?: unknown } | null)?.command;
    return typeof command === "string" ? patchTargets(command) : { op: "other", rawPaths: [] };
  }
  // `Bash` carries a command line and nothing else; MCP tools may carry a
  // `path`, and CAP-03 keeps it.
  return { op: "other", rawPaths: pathArgs(input) };
}

export function normalizeCodexHook(payload: unknown, deps: NormalizeDeps): NormalizeResult {
  let droppedPaths = 0;
  const raw = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
  const claimedSessionId = typeof raw?.session_id === "string" ? raw.session_id : null;
  const cwd = typeof raw?.cwd === "string" ? raw.cwd : "";
  const nothing = (): NormalizeResult => ({ event: null, droppedPaths, claimedSessionId, cwd });

  if (raw === null || claimedSessionId === null || typeof raw.hook_event_name !== "string") return nothing();
  const kind = KIND_BY_HOOK[raw.hook_event_name];
  if (kind === undefined) return nothing();

  // Set only on a subagent's events. The root agent's id IS the session id,
  // the same convention as Claude.
  const agentId = typeof raw.agent_id === "string" ? raw.agent_id : claimedSessionId;
  const agentType = typeof raw.agent_type === "string" ? raw.agent_type : null;
  const subagentStart = kind === "subagent_start";

  let op: Op | null = null;
  const paths: string[] = [];
  let tool: string | null = null;
  let ok: boolean | null = null;

  if (kind === "pre_tool" || kind === "post_tool") {
    tool = typeof raw.tool_name === "string" ? raw.tool_name : null;
    const c = classifyCodexTool(tool ?? "", raw.tool_input);
    op = c.op;
    if (cwd) {
      for (const rp of c.rawPaths) {
        const rel = toRepoRelative(cwd, rp, deps.realpath);
        if (rel === null) droppedPaths++;
        else paths.push(rel);
      }
    }
    // Codex has no failure event: a failed command is still a `PostToolUse`,
    // and its result is a free-text string. So `ok` says "the tool ran", the
    // same thing it says for Claude's `PostToolUse`.
    ok = kind === "post_tool" ? true : null;
  }

  return {
    droppedPaths,
    claimedSessionId,
    cwd,
    event: {
      v: CONTRACT_VERSION,
      eventId: deps.newId(),
      provider: "codex",
      sessionId: claimedSessionId,
      ts: deps.now(),
      kind,
      agentId,
      agentType,
      parentAgentId: null,
      // SubagentStop carries no success signal either, so `ok` stays null and
      // the agent ends `done`, never `error`.
      parentSource: subagentStart ? "inferred" : null,
      tool,
      description: null,
      paths,
      op,
      ok,
      // A PermissionRequest is the ONLY human-blocking signal Codex sends.
      // There is no idle prompt and no Notification event to tell kinds apart.
      notificationKind: kind === "notification" ? "permission_prompt" : null,
    },
  };
}
