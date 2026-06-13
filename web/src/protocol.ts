// Wire types mirroring the FROZEN §11 relay contract. clide-web is a separate
// package; these structurally match relay's SnapshotDTO/Frame and are the contract boundary.
export type Provider = "claude" | "codex";
export type AgentState = "idle" | "thinking" | "tool-running" | "waiting" | "done" | "error";
export type NowSource = "reasoning" | "model" | "template";
export type DiscoveryState = "live" | "ended" | "unreachable";

export interface LeafDTO {
  path: string; type: "file"; loc: number; binary: boolean;
  heat: number; reads: number; edits: number; agents: string[];
  pulse?: boolean; synthetic?: boolean; count?: number;
}
export interface DirDTO { path: string; type: "dir"; heat: number; children: Array<DirDTO | LeafDTO>; }
export interface AgentRecordDTO {
  id: string; provider: Provider; name: string; agentType: string | null;
  parentId: string | null; parentInferred: boolean; state: AgentState;
  now: string; nowSource: NowSource; color: string; currentFiles: string[];
}
export interface SnapshotDTO {
  provider: Provider; sessionId: string; state: DiscoveryState;
  tree: DirDTO; agents: AgentRecordDTO[];
}
export interface SpecPayload { path: string; changeKind: "created" | "updated" | "deleted"; }
export interface SessionStatePayload { state: DiscoveryState; }

export type FrameType = "snapshot" | "delta" | "spec" | "session-state";
export interface Frame<T = unknown> { type: FrameType; sessionId: string; ts: number; payload: T; }

export function isLeaf(n: DirDTO | LeafDTO): n is LeafDTO { return n.type === "file"; }
