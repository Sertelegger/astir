import type { Provider, DiscoveryState, Kind } from "../contract/types.js";
import type { Clock } from "./clock.js";
import { validateEvent, type ClideEvent } from "../contract/event.js";
import { RepoTree, type LeafNode } from "./tree.js";
import { AgentModel } from "./agents.js";
import { ReasoningStore, condense, templatePhrase, passesNowGate } from "./reasoning.js";
import type { Summarizer, SummarizerEvent } from "../relay/summarizer.js";
import { matchesSpec, SpecTracker, type SpecChange } from "../relay/spec-watch.js";

export interface SessionStateOpts {
  sessionId: string; provider: Provider; cwd: string; clock: Clock;
  halfLifeSeconds?: number; maxNodes?: number;
  summarizer?: Summarizer; onNowUpdate?: (agentId: string) => void;
  specGlobs?: string[]; onSpec?: (path: string, changeKind: SpecChange) => void;
  /** Fired once per accepted (non-duplicate) event — lets the relay drive Lifecycle. */
  onIngest?: (kind: Kind) => void;
}

const NOW_TERMINAL = new Set(["done", "error"]);
export interface DirDTO { path: string; type: "dir"; heat: number; children: Array<DirDTO | LeafDTO>; }
export interface LeafDTO { path: string; type: "file"; loc: number; binary: boolean; heat: number; reads: number; edits: number; agents: string[]; synthetic?: boolean; count?: number; pulse?: boolean; }
export interface SnapshotDTO { provider: Provider; sessionId: string; state: DiscoveryState; tree: DirDTO; agents: ReturnType<AgentModel["all"]>; specs: string[]; }

export class SessionState {
  readonly tree: RepoTree;
  readonly agents: AgentModel;
  readonly reasoning = new ReasoningStore();
  state: DiscoveryState = "live";
  private seen = new Set<string>();
  private lastOp = new Map<string, { op: ClideEvent["op"]; path?: string }>();
  private maxNodes: number;
  private recent = new Map<string, SummarizerEvent[]>();
  private specTracker = new SpecTracker();
  private surfaced: string[] = [];
  private specGlobs: string[];

  constructor(private opts: SessionStateOpts) {
    this.tree = new RepoTree(opts.cwd, opts.clock, opts.halfLifeSeconds);
    this.agents = new AgentModel(opts.sessionId, opts.provider);
    this.maxNodes = opts.maxNodes ?? 2000;
    this.specGlobs = opts.specGlobs ?? [];
  }

  get sessionId(): string { return this.opts.sessionId; }

  build(): void {
    this.tree.build();
    this.specTracker.seed(this.tree.allLeaves().map((l) => l.path).filter((p) => matchesSpec(p, this.specGlobs)));
  }

  /** Idempotent, order-independent (REQ-016). Returns touched leaves for delta/pulse. */
  apply(raw: unknown): LeafNode[] {
    const v = validateEvent(raw);
    if (!v.ok) return [];
    const e = v.event;
    if (this.seen.has(e.eventId)) return [];
    this.seen.add(e.eventId);
    const r = this.recent.get(e.agentId) ?? [];
    r.push({ kind: e.kind, tool: e.tool ?? null, op: e.op, paths: e.paths });
    if (r.length > 8) r.shift();
    this.recent.set(e.agentId, r);
    // REQ-096: drop ingest while ENDED — except a session_start, which REVIVES the
    // session. Without this, a resumed session reusing this id would discover a
    // live-but-deaf relay (it holds the discovery file yet ignores every event).
    if (this.state === "ended") {
      if (e.kind !== "session_start") return [];
      this.state = "live";
    }
    const touched: LeafNode[] = [];
    switch (e.kind) {
      case "session_start": this.agents.onSessionStart(e.ts); break;
      case "pre_tool": this.agents.onPreTool(e.agentId, e.tool ?? "", e.ts); break;
      case "post_tool": {
        this.agents.onPostTool(e.agentId, e.paths, e.ts);
        if (e.op) { for (const p of e.paths) { const leaf = this.tree.touchFile(p, e.op, e.ts); if (leaf) touched.push(leaf); }
          this.lastOp.set(e.agentId, { op: e.op, path: e.paths[0] }); }
        if (this.specGlobs.length > 0 && this.opts.onSpec && (e.op === "write" || e.op === "edit")) {
          for (const p of e.paths) {
            if (!matchesSpec(p, this.specGlobs)) continue;
            const kind = this.specTracker.onWrite(p);
            if (!this.specTracker.shouldEmit(p)) continue;
            this.surfaced = [p, ...this.surfaced.filter((x) => x !== p)].slice(0, 20);
            this.opts.onSpec(p, kind);
          }
        }
        break;
      }
      case "stop": this.agents.onStop(e.agentId, e.ts); break;
      case "subagent_start": this.agents.onSubagentStart(e.agentId, e.agentType ?? "", this.opts.sessionId, e.parentInferred ?? false, e.ts); break;
      case "subagent_stop": this.agents.onSubagentStop(e.agentId, e.ok ?? true, e.ts); break;
      case "session_end": this.agents.onSessionEnd(e.ts); this.state = "ended"; break;
    }
    this.refreshNow(e.agentId);
    try { this.opts.onIngest?.(e.kind); } catch { /* a throwing observer must never corrupt the reducer */ }
    return touched;
  }

  /** REQ-012a: store reasoning; never create an agent record from it. */
  applyReasoning(agentId: string, ts: number, text: string): void {
    this.reasoning.put(agentId, ts, text);
    if (this.agents.get(agentId)) this.refreshNow(agentId);
  }

  /** "Now" pipeline (REQ-033) — synchronous reasoning→template here; the model step is the Task-10 seam. */
  refreshNow(agentId: string): void {
    const a = this.agents.get(agentId);
    if (!a) return;
    const reasoning = this.reasoning.get(agentId);
    if (reasoning !== undefined) {
      const c = condense(reasoning);
      if (passesNowGate(c)) { a.now = c; a.nowSource = "reasoning"; return; }
    }
    const last = this.lastOp.get(agentId);
    a.now = templatePhrase(last?.op ?? null, last?.path);
    a.nowSource = "template";
    const sum = this.opts.summarizer;
    if (sum && !NOW_TERMINAL.has(a.state)) {
      const events = (this.recent.get(agentId) ?? []).filter((e) => e.op !== null || e.tool !== null);
      if (events.length === 0) return;
      void sum.summarize(agentId, events).then((phrase) => {
        if (!phrase) return;
        const cur = this.agents.get(agentId);
        if (cur && !NOW_TERMINAL.has(cur.state)) { cur.now = phrase; cur.nowSource = "model"; this.opts.onNowUpdate?.(agentId); }
      }).catch(() => { /* never throw from the Now pipeline */ });
    }
  }

  tick(now: number): void { this.agents.tick(now); }

  /** Most-recently-touching agent first, so the web can colour the ring by recency (REQ-032). */
  private leafAgents(path: string): string[] {
    return this.agents.all()
      .filter((a) => a.currentFiles.includes(path))
      .sort((a, b) => (this.agents.lastTouchOf(b.id, path) ?? -Infinity) - (this.agents.lastTouchOf(a.id, path) ?? -Infinity))
      .map((a) => a.id);
  }

  snapshot(pulsePaths?: Set<string>): SnapshotDTO {
    return { provider: this.opts.provider, sessionId: this.opts.sessionId, state: this.state, tree: this.buildTreeDTO(pulsePaths), agents: this.agents.all(), specs: [...this.surfaced] };
  }

  /** Build nested dirs with rolled-up heat (REQ-025); aggregate smallest leaves when over maxNodes (REQ-048). */
  private buildTreeDTO(pulsePaths?: Set<string>): DirDTO {
    let leaves = this.tree.allLeaves();
    if (leaves.length > this.maxNodes) leaves = this.aggregate(leaves);
    const root: DirDTO = { path: "", type: "dir", heat: 0, children: [] };
    const dirIndex = new Map<string, DirDTO>([["", root]]);
    const ensureDir = (path: string): DirDTO => {
      let d = dirIndex.get(path);
      if (d) return d;
      const slash = path.lastIndexOf("/");
      const parentPath = slash === -1 ? "" : path.slice(0, slash);
      const parent = ensureDir(parentPath);
      d = { path, type: "dir", heat: 0, children: [] };
      dirIndex.set(path, d); parent.children.push(d);
      return d;
    };
    for (const l of leaves) {
      const slash = l.path.lastIndexOf("/");
      const dir = ensureDir(slash === -1 ? "" : l.path.slice(0, slash));
      const heat = l.heat.value();
      dir.children.push({ path: l.path, type: "file", loc: l.loc, binary: l.binary, heat, reads: l.heat.reads, edits: l.heat.edits, agents: this.leafAgents(l.path), ...(pulsePaths?.has(l.path) ? { pulse: true } : {}) });
      let p: string | undefined = dir.path; // roll heat up to all ancestors
      for (let cur: DirDTO | undefined = dir; cur; cur = p === undefined ? undefined : dirIndex.get(p)) {
        cur.heat += heat;
        if (cur.path === "") break;
        const s = cur.path.lastIndexOf("/"); p = s === -1 ? "" : cur.path.slice(0, s);
      }
    }
    return root;
  }

  private aggregate(leaves: LeafNode[]): LeafNode[] {
    const sorted = [...leaves].sort((a, b) => (b.heat.value() - a.heat.value()) || (b.loc - a.loc));
    return sorted.slice(0, this.maxNodes);
  }
}
