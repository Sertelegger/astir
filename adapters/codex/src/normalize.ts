import { relative, sep, posix } from "node:path";
import type { ClideEvent, Kind } from "./contract.js";
import { newEventId } from "./contract.js";
import { classifyCodexTool } from "./classify.js";

// Codex has NO SessionEnd: turn-end is `Stop` (→ stop / waiting); session end is inferred by relay reap (REQ-001/006).
const KIND_BY_HOOK: Record<string, Kind> = {
  SessionStart: "session_start", PreToolUse: "pre_tool", PostToolUse: "post_tool",
  SubagentStart: "subagent_start", SubagentStop: "subagent_stop", Stop: "stop",
};

function toRel(cwd: string, p: string): string { return relative(cwd, p).split(sep).join(posix.sep); }

export function normalizeCodexHook(payload: unknown, ts: number): ClideEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const sessionId = p.session_id;
  const hookName = p.hook_event_name;
  if (typeof sessionId !== "string" || typeof hookName !== "string") return null;
  const kind = KIND_BY_HOOK[hookName];
  if (!kind) return null; // includes SessionEnd → Codex never emits session_end (relay reap infers it)

  const cwd = typeof p.cwd === "string" ? p.cwd : "";
  const agentId = (typeof p.agent_id === "string" ? p.agent_id : null) ?? sessionId;
  const agentType = typeof p.agent_type === "string" ? p.agent_type : null;

  let op: ClideEvent["op"] = null, paths: string[] = [], tool: string | null = null;
  if (kind === "pre_tool" || kind === "post_tool") {
    tool = typeof p.tool_name === "string" ? p.tool_name : null;
    const c = classifyCodexTool(tool ?? "", p.tool_input);
    op = c.op;
    paths = cwd ? c.rawPaths.map((ap) => (ap.startsWith("/") ? toRel(cwd, ap) : ap)) : c.rawPaths;
  }
  const event: ClideEvent = { v: 1, eventId: newEventId(), provider: "codex", sessionId, ts, kind, agentId, agentType, tool, paths, op };
  if (kind === "post_tool") event.ok = true;
  if (kind === "subagent_start") event.parentInferred = false;
  return event;
}
