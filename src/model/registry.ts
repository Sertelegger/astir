/** MOD-04/05/06 — session + agent state, and the active-vs-blocked accounting. */

import type { ClideEvent, ParentSource, Provider } from "../contract/event.js";

export type AgentState = "thinking" | "tool-running" | "waiting" | "blocked" | "idle" | "done" | "error";

/** States that mean "a human is the bottleneck" — the whole point of G1. */
const HUMAN_BLOCKING = new Set<AgentState>(["blocked"]);
const TERMINAL = new Set<AgentState>(["done", "error"]);
/** MOD-04: `waiting` and `blocked` are informative and MUST NOT decay to idle. */
const IDLE_EXEMPT = new Set<AgentState>(["waiting", "blocked", "done", "error", "idle"]);

export interface AgentRecord {
  id: string;
  provider: Provider;
  agentType: string | null;
  parentId: string | null;
  parentSource: ParentSource | null;
  state: AgentState;
  lastEventTs: number;
  /** MOD-05 — cumulative, in ms. */
  activeMs: number;
  blockedMs: number;
  /** Wall ms at which the current state was entered, for the accounting above. */
  stateSince: number;
}

export interface SessionRecord {
  sessionId: string;
  provider: Provider;
  cwd: string;
  agents: Map<string, AgentRecord>;
}

export interface RegistryOpts {
  /** Injectable per §9 so time-dependent behaviour is testable. */
  nowMs: () => number;
  idleAfterMs?: number;
  /** DMN-06 — the dedupe set is bounded; this is the replay window it covers. */
  maxSeenEvents?: number;
}

export interface IngestResult {
  applied: boolean;
  reason?: string;
  /** Set when this event moved an agent into a human-blocking state (PSH-01). */
  becameBlocked?: { sessionId: string; agentId: string; kind: string };
}

export class Registry {
  private sessions = new Map<string, SessionRecord>();
  /** Insertion-ordered, trimmed from the front — a bounded LRU by arrival. */
  private seen = new Set<string>();
  private readonly nowMs: () => number;
  private readonly idleAfterMs: number;
  private readonly maxSeen: number;

  constructor(opts: RegistryOpts) {
    this.nowMs = opts.nowMs;
    this.idleAfterMs = opts.idleAfterMs ?? 10_000;
    this.maxSeen = opts.maxSeenEvents ?? 10_000;
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  /** Count of agents currently blocked on a human, across all sessions (PSH-08). */
  blockedCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      for (const a of s.agents.values()) if (HUMAN_BLOCKING.has(a.state)) n++;
    }
    return n;
  }

  apply(event: ClideEvent, cwd: string): IngestResult {
    if (this.seen.has(event.eventId)) return { applied: false, reason: "duplicate" };
    this.seen.add(event.eventId);
    while (this.seen.size > this.maxSeen) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }

    const session = this.ensureSession(event.sessionId, event.provider, cwd);
    const agent = this.ensureAgent(session, event);

    // MOD-06 — timestamp-monotonic. A stale event never rewrites state.
    if (event.ts < agent.lastEventTs) return { applied: false, reason: "stale" };
    agent.lastEventTs = event.ts;

    if (TERMINAL.has(agent.state) && event.kind !== "session_start") {
      return { applied: false, reason: "terminal" };
    }

    const next = this.nextState(event, agent.state);
    const becameBlocked =
      next !== agent.state && HUMAN_BLOCKING.has(next)
        ? { sessionId: session.sessionId, agentId: agent.id, kind: event.notificationKind ?? "blocked" }
        : undefined;

    this.transition(agent, next);

    return becameBlocked ? { applied: true, becameBlocked } : { applied: true };
  }

  /** Advance wall-clock-derived transitions. Must be called periodically. */
  tick(): void {
    const now = this.nowMs();
    for (const s of this.sessions.values()) {
      for (const a of s.agents.values()) {
        if (IDLE_EXEMPT.has(a.state)) continue;
        if (now - a.stateSince >= this.idleAfterMs) this.transition(a, "idle");
      }
    }
  }

  private nextState(event: ClideEvent, current: AgentState): AgentState {
    switch (event.kind) {
      case "session_start":
        return "thinking";
      case "pre_tool":
        return "tool-running";
      case "post_tool":
      case "tool_failed":
      case "file_changed":
        return "thinking";
      case "subagent_start":
        return "thinking";
      case "subagent_stop":
        return event.ok === false ? "error" : "done";
      case "stop":
        return "waiting";
      case "session_end":
        return "done";
      case "notification":
        // Only the "come look" kinds are human-blocking.
        return event.notificationKind === "permission_prompt" ||
          event.notificationKind === "agent_needs_input" ||
          event.notificationKind === "worker_permission_prompt"
          ? "blocked"
          : current;
      default:
        return current;
    }
  }

  /** MOD-05 — bank the time spent in the state we are leaving. */
  private transition(agent: AgentRecord, next: AgentState): void {
    const now = this.nowMs();
    const elapsed = Math.max(0, now - agent.stateSince);
    if (HUMAN_BLOCKING.has(agent.state)) agent.blockedMs += elapsed;
    else if (!TERMINAL.has(agent.state) && agent.state !== "idle") agent.activeMs += elapsed;

    agent.state = next;
    agent.stateSince = now;
  }

  private ensureSession(sessionId: string, provider: Provider, cwd: string): SessionRecord {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { sessionId, provider, cwd, agents: new Map() };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  private ensureAgent(session: SessionRecord, event: ClideEvent): AgentRecord {
    let a = session.agents.get(event.agentId);
    if (!a) {
      a = {
        id: event.agentId,
        provider: event.provider,
        agentType: event.agentType,
        parentId: event.agentId === session.sessionId ? null : event.parentAgentId,
        parentSource: event.agentId === session.sessionId ? null : event.parentSource,
        state: "thinking",
        lastEventTs: 0,
        activeMs: 0,
        blockedMs: 0,
        stateSince: this.nowMs(),
      };
      session.agents.set(event.agentId, a);
      return a;
    }
    // Upsert identity fields that only some events carry, so an out-of-order
    // subagent_stop before subagent_start cannot strand an agent with a null type.
    if (a.agentType === null && event.agentType !== null) a.agentType = event.agentType;
    if (a.parentSource === null && event.parentSource !== null) {
      a.parentId = event.parentAgentId;
      a.parentSource = event.parentSource;
    }
    return a;
  }
}
