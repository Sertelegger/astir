import { relative, sep, posix } from "node:path";
import type { ClideEvent, Kind } from "./contract.js";
import { newEventId } from "./contract.js";
import { classifyTool } from "./classify.js";

const KIND_BY_HOOK: Record<string, Kind> = {
  SessionStart: "session_start", PreToolUse: "pre_tool", PostToolUse: "post_tool",
  SubagentStart: "subagent_start", SubagentStop: "subagent_stop", Stop: "stop", SessionEnd: "session_end",
};

function toRepoRel(cwd: string, abs: string): string {
  const rel = relative(cwd, abs);
  return rel.split(sep).join(posix.sep);
}

/** Claude hook payload → normalized §11 event, or null if unmapped/invalid. REQ-006/007. */
export function normalizeClaudeHook(payload: unknown, ts: number): ClideEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const sessionId = p.session_id;
  const hookName = p.hook_event_name;
  if (typeof sessionId !== "string" || typeof hookName !== "string") return null;
  const kind = KIND_BY_HOOK[hookName];
  if (!kind) return null;

  const cwd = typeof p.cwd === "string" ? p.cwd : "";
  const agentIdField = typeof p.agent_id === "string" ? p.agent_id : null;
  const agentType = typeof p.agent_type === "string" ? p.agent_type : null;
  // main agent's id == session_id; a subagent context carries agent_id (REQ-030/006).
  const agentId = agentIdField ?? sessionId;

  let op: ClideEvent["op"] = null;
  let paths: string[] = [];
  let tool: string | null = null;
  if (kind === "pre_tool" || kind === "post_tool") {
    tool = typeof p.tool_name === "string" ? p.tool_name : null;
    const c = classifyTool(tool ?? "", p.tool_input);
    op = c.op;
    paths = cwd ? c.rawPaths.map((ap) => toRepoRel(cwd, ap)) : c.rawPaths;
  }

  const event: ClideEvent = {
    v: 1, eventId: newEventId(), provider: "claude", sessionId, ts, kind,
    agentId, agentType, tool, paths, op,
  };
  if (kind === "post_tool") event.ok = p.tool_output !== undefined ? true : undefined;
  if (kind === "subagent_start") event.parentInferred = false; // parent derivation lives in the relay (REQ-006)
  return event;
}
