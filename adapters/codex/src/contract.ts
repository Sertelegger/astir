import { randomUUID } from "node:crypto";
export type Provider = "claude" | "codex";
export type Op = "read" | "write" | "edit" | "other";
export type Kind = "session_start" | "pre_tool" | "post_tool" | "subagent_start" | "subagent_stop" | "stop" | "session_end";
export interface ClideEvent {
  v: 1; eventId: string; provider: Provider; sessionId: string; ts: number; kind: Kind;
  agentId: string; agentType?: string | null; tool?: string | null; paths: string[];
  op: Op | null; ok?: boolean; linesChanged?: number; parentInferred?: boolean;
}
export function newEventId(): string { return randomUUID(); }
