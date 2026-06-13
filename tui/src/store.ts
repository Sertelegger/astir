import type { Frame, SnapshotDTO, DirDTO, LeafDTO, AgentRecordDTO, DiscoveryState } from "./protocol.js";
import { isLeaf } from "./protocol.js";

export interface TuiState { tree: DirDTO | null; agents: AgentRecordDTO[]; maxLeafHeat: number; sessionState: DiscoveryState | null; }
export function emptyState(): TuiState { return { tree: null, agents: [], maxLeafHeat: 0, sessionState: null }; }

function maxLeaf(t: DirDTO): number { let m = 0; const w = (n: DirDTO | LeafDTO): void => { if (isLeaf(n)) { if (n.heat > m) m = n.heat; } else n.children.forEach(w); }; w(t); return m; }

export function reduce(state: TuiState, frame: Frame): TuiState {
  if (frame.type === "snapshot" || frame.type === "delta") {
    const s = frame.payload as SnapshotDTO;
    return { tree: s.tree, agents: s.agents, maxLeafHeat: maxLeaf(s.tree), sessionState: s.state };
  }
  if (frame.type === "session-state") return { ...state, sessionState: (frame.payload as { state: DiscoveryState }).state };
  return state;
}
