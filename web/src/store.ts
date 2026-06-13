import type { Frame, SnapshotDTO, DirDTO, LeafDTO, AgentRecordDTO, SpecPayload, SessionStatePayload, DiscoveryState } from "./protocol.js";
import { isLeaf } from "./protocol.js";

export interface ClientState {
  provider: string | null;
  sessionId: string | null;        // null until a sessionId-verified snapshot arrives
  tree: DirDTO | null;
  agents: AgentRecordDTO[];
  specs: string[];                 // most-recent first
  sessionState: DiscoveryState | null;
  maxLeafHeat: number;
}

function maxLeaf(tree: DirDTO): number {
  let max = 0;
  const walk = (n: DirDTO | LeafDTO): void => {
    if (isLeaf(n)) { if (n.heat > max) max = n.heat; } else n.children.forEach(walk);
  };
  walk(tree);
  return max;
}

/** Reduces relay frames into client state. Verifies snapshot.sessionId (REQ-040). */
export class Store {
  state: ClientState = { provider: null, sessionId: null, tree: null, agents: [], specs: [], sessionState: null, maxLeafHeat: 0 };
  constructor(private expectedSessionId: string, private specMax = 20) {}

  apply(frame: Frame): void {
    switch (frame.type) {
      case "snapshot":
      case "delta": {
        const snap = frame.payload as SnapshotDTO;
        if (frame.sessionId !== this.expectedSessionId || snap.sessionId !== this.expectedSessionId) return; // untrusted
        this.state.provider = snap.provider;
        this.state.sessionId = snap.sessionId;
        this.state.tree = snap.tree;
        this.state.agents = snap.agents;
        this.state.sessionState = snap.state;
        this.state.maxLeafHeat = maxLeaf(snap.tree);
        if (Array.isArray(snap.specs)) this.state.specs = snap.specs.slice(0, this.specMax);
        break;
      }
      case "spec": {
        const p = frame.payload as SpecPayload;
        this.state.specs = this.state.specs.filter((x) => x !== p.path);
        if (p.changeKind !== "deleted") this.state.specs.unshift(p.path);
        this.state.specs = this.state.specs.slice(0, this.specMax);
        break;
      }
      case "session-state": {
        this.state.sessionState = (frame.payload as SessionStatePayload).state;
        break;
      }
    }
  }
}
