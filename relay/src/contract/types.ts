export type Provider = "claude" | "codex";
export type Op = "read" | "write" | "edit" | "other";
export type Kind =
  | "session_start" | "pre_tool" | "post_tool"
  | "subagent_start" | "subagent_stop" | "stop" | "session_end";
export type NowSource = "reasoning" | "model" | "template";
export type AgentState = "thinking" | "tool-running" | "waiting" | "idle" | "done" | "error";
export type RelayLifecycle = "STARTING" | "LIVE" | "ENDED" | "SHUTDOWN";
export type DiscoveryState = "live" | "ended" | "unreachable";
export const CONTRACT_VERSION = 1 as const;
