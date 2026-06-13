import type { AggDiscovery } from "./discovery.js";
import type { Frame, SnapshotDTO } from "./protocol.js";

export type AggStatus = "connecting" | "live" | "unreachable" | "ended";
export interface SessionEntry { sessionId: string; provider: string; cwd: string; status: AggStatus; snapshot: SnapshotDTO | null; }

export interface AggDeps {
  scan: () => AggDiscovery[];
  /** Subscribe to a relay's SSE; return an unsubscribe fn. The subscriber owns snapshot-timeout → onStatus("unreachable"). */
  subscribe: (d: AggDiscovery, onFrame: (f: Frame) => void, onStatus: (s: string) => void) => () => void;
}

interface Entry { d: AggDiscovery; status: AggStatus; snapshot: SnapshotDTO | null; unsub: () => void; }

/** Read-only union of all live sessions (REQ-081/082). */
export class Aggregator {
  private entries = new Map<string, Entry>();
  constructor(private deps: AggDeps) {}

  /** Re-scan discovery; add new sessions, drop+unsubscribe vanished ones (churn-tolerant). */
  refresh(): void {
    const found = new Map(this.deps.scan().map((d) => [d.sessionId, d]));
    for (const [id, e] of [...this.entries]) if (!found.has(id)) { e.unsub(); this.entries.delete(id); }
    for (const [id, disc] of found) {
      if (this.entries.has(id)) continue;
      const entry: Entry = { d: disc, status: "connecting", snapshot: null, unsub: () => {} };
      this.entries.set(id, entry);
      entry.unsub = this.deps.subscribe(disc, (f) => this.onFrame(id, f), (s) => { if (s === "unreachable") entry.status = "unreachable"; });
    }
  }

  private onFrame(id: string, f: Frame): void {
    const e = this.entries.get(id);
    if (!e) return;
    if (f.type === "snapshot" || f.type === "delta") {
      const snap = f.payload as SnapshotDTO;
      if (f.sessionId !== id || snap.sessionId !== id) return; // verify (REQ-082)
      e.snapshot = snap;
      e.status = snap.state === "ended" ? "ended" : snap.state === "unreachable" ? "unreachable" : "live";
    } else if (f.type === "session-state") {
      const st = (f.payload as { state: string }).state;
      e.status = st === "ended" ? "ended" : st === "unreachable" ? "unreachable" : "live";
    }
  }

  sessions(): SessionEntry[] {
    return [...this.entries.values()].map((e) => ({ sessionId: e.d.sessionId, provider: e.d.provider, cwd: e.d.cwd, status: e.status, snapshot: e.snapshot }));
  }

  stopAll(): void { for (const e of this.entries.values()) e.unsub(); this.entries.clear(); }
}
