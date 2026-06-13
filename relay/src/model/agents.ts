import type { AgentState, NowSource, Provider } from "../contract/types.js";

export interface AgentRecord {
  id: string;
  provider: Provider;
  name: string;
  agentType: string | null;
  parentId: string | null;
  parentInferred: boolean;
  state: AgentState;
  now: string;
  nowSource: NowSource;
  color: string;
  currentFiles: string[];
  lastEventTs: number;
  terminalSince: number | null; // wall ts when it became done/error
}

export interface AgentModelOpts {
  idleSeconds?: number;
  currentFilesWindowSeconds?: number;
  terminalRetentionSeconds?: number;
}

const SUBAGENT_PALETTE = ["#e879f9", "#a3e635", "#38bdf8", "#fbbf24", "#fb7185", "#34d399"];
const MAIN_COLOR = "#60a5fa";
const TERMINAL = new Set<AgentState>(["done", "error"]);

export class AgentModel {
  private agents = new Map<string, AgentRecord>();
  private fileTouchTs = new Map<string, Map<string, number>>(); // agentId -> path -> wallTs
  private nextColor = 0;
  private idleSeconds: number;
  private windowSeconds: number;
  private retentionSeconds: number;

  constructor(private sessionId: string, private provider: Provider, opts: AgentModelOpts = {}) {
    this.idleSeconds = opts.idleSeconds ?? 10;
    this.windowSeconds = opts.currentFilesWindowSeconds ?? 10;
    this.retentionSeconds = opts.terminalRetentionSeconds ?? 60;
  }

  get(id: string): AgentRecord | undefined { return this.agents.get(id); }
  all(): AgentRecord[] { return [...this.agents.values()]; }

  private ensure(id: string, parentId: string | null, agentType: string | null, parentInferred = false): AgentRecord {
    let a = this.agents.get(id);
    if (!a) {
      const isMain = id === this.sessionId;
      a = {
        id, provider: this.provider, name: agentType ?? (isMain ? "main" : id),
        agentType, parentId: isMain ? null : parentId, parentInferred,
        state: "thinking", now: "", nowSource: "template",
        color: isMain ? MAIN_COLOR : SUBAGENT_PALETTE[this.nextColor++ % SUBAGENT_PALETTE.length]!,
        currentFiles: [], lastEventTs: 0, terminalSince: null,
      };
      this.agents.set(id, a);
    }
    return a;
  }

  /** Guard: ignore an event that would move a terminal agent back to a live state. */
  private live(a: AgentRecord, ts: number): boolean {
    if (TERMINAL.has(a.state)) return false;
    if (ts < a.lastEventTs) return false; // stale / out-of-order — do not regress agent state (REQ-016)
    a.lastEventTs = ts;
    return true;
  }

  onSessionStart(ts: number): void { const a = this.ensure(this.sessionId, null, null); if (this.live(a, ts)) a.state = "thinking"; }

  onPreTool(agentId: string, _tool: string, ts: number): void {
    const a = this.ensure(agentId, this.sessionId, null);
    if (this.live(a, ts)) a.state = "tool-running";
  }

  onPostTool(agentId: string, paths: string[], ts: number): void {
    const a = this.ensure(agentId, this.sessionId, null);
    if (!this.live(a, ts)) return;
    a.state = "thinking";
    const m = this.fileTouchTs.get(agentId) ?? new Map<string, number>();
    for (const p of paths) m.set(p, ts);
    this.fileTouchTs.set(agentId, m);
    this.recomputeCurrentFiles(a, ts);
  }

  onStop(agentId: string, ts: number): void {
    if (agentId !== this.sessionId) return; // spec: Stop affects the main agent only
    const a = this.ensure(agentId, null, null);
    if (this.live(a, ts)) a.state = "waiting";
  }

  onSubagentStart(agentId: string, agentType: string, parentId: string, parentInferred: boolean, ts: number): void {
    const a = this.ensure(agentId, parentId, agentType, parentInferred);
    if (this.live(a, ts)) a.state = "thinking";
  }

  onSubagentStop(agentId: string, ok: boolean, ts: number): void {
    const a = this.ensure(agentId, this.sessionId, null);
    if (TERMINAL.has(a.state)) return;
    a.lastEventTs = Math.max(a.lastEventTs, ts);
    a.state = ok ? "done" : "error";
    a.terminalSince = ts;
  }

  onSessionEnd(ts: number): void {
    for (const a of this.agents.values()) {
      if (!TERMINAL.has(a.state)) { a.state = "done"; a.terminalSince = ts; }
    }
  }

  private recomputeCurrentFiles(a: AgentRecord, now: number): void {
    const m = this.fileTouchTs.get(a.id);
    if (!m) { a.currentFiles = []; return; }
    a.currentFiles = [...m.entries()].filter(([, t]) => now - t <= this.windowSeconds).map(([p]) => p);
  }

  /** Advance wall-clock-derived transitions: idle + currentFiles expiry + terminal pruning. */
  tick(now: number): void {
    for (const a of [...this.agents.values()]) {
      if (a.terminalSince !== null && now - a.terminalSince >= this.retentionSeconds && a.id !== this.sessionId) {
        this.agents.delete(a.id); this.fileTouchTs.delete(a.id); continue;
      }
      if (!TERMINAL.has(a.state) && a.state !== "idle" && now - a.lastEventTs >= this.idleSeconds) {
        a.state = "idle";
      }
      this.recomputeCurrentFiles(a, now);
    }
  }
}
