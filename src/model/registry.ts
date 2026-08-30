/** MOD-04/05/06 — session + agent state, and the active-vs-blocked accounting. */

import type { AstirEvent, ParentSource, Provider } from "../contract/event.js";
import type { DiscoveredSession } from "../discovery/sessions.js";
import { RepoMap } from "./map.js";

export type AgentState = "thinking" | "tool-running" | "waiting" | "blocked" | "idle" | "done" | "error";

/** States that mean "a human is the bottleneck" — the whole point of G1. */
const HUMAN_BLOCKING = new Set<AgentState>(["blocked"]);
const TERMINAL = new Set<AgentState>(["done", "error"]);

/**
 * The only states in which the agent is actually doing work.
 *
 * Time is banked against this set rather than against "everything except
 * terminal and idle", which silently counted `waiting` as active — so the
 * minutes a human spent deciding what to type next were recorded as agent
 * working time, inflating the one number G4 exists to keep honest.
 *
 * `waiting` cannot simply join HUMAN_BLOCKING instead: that set drives
 * `blockedAgents()` and the notifier, so every finished turn would raise a
 * "waiting on you" alert.
 */
const WORKING_STATES = new Set<AgentState>(["thinking", "tool-running"]);
/** MOD-04: `waiting` and `blocked` are informative and MUST NOT decay to idle. */
const IDLE_EXEMPT = new Set<AgentState>(["waiting", "blocked", "done", "error", "idle"]);

/** States that mean the agent has given the human the floor back. */
const TURN_END = new Set<AgentState>(["waiting", "idle"]);

/**
 * Provider statuses that mean the session is doing something.
 *
 * Measured from `claude agents --json`: a session running a tool reports
 * `busy`, and remote ones have been seen reporting `running`. Anything else —
 * including a session that reports nothing at all — is treated as no evidence
 * rather than as evidence of idleness.
 */
const PROVIDER_BUSY = new Set(["busy", "running", "working"]);

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
  /**
   * G4 — working time since the human last handed over.
   *
   * `activeMs` is the whole session's total, which answers a different question:
   * "how much work has this session done" rather than "how long has it been
   * going since I asked". A turn ends when the agent hands control back — it
   * goes `waiting` or `idle` — and being blocked on a permission prompt is NOT
   * a turn boundary, because the turn resumes on approval. The prompt's duration
   * is excluded from this all the same: time spent waiting on a human is not
   * time spent doing something, which is the whole distinction G4 exists for.
   */
  turnMs: number;
  /**
   * Wall ms at which the current state was *entered*. Only a real state change
   * moves it, so "blocked since" is the true start of the wait rather than the
   * time of the last event that happened to reconfirm the state.
   */
  stateSince: number;
  /**
   * Wall ms of the last applied event, on the daemon's own clock. Distinct from
   * `stateSince` because idle decay measures silence, not time-in-state — an
   * agent thinking hard for a minute is emitting events and is not idle.
   */
  lastActivityMs: number;
  /** Why this agent is blocked, e.g. `permission_prompt`. Null when not blocked. */
  blockedReason: string | null;
  /**
   * What this agent was sent to do, from the sidecar. Set once at spawn and
   * never cleared — it is the agent's standing brief, not its current state.
   *
   * Always null for the main agent: sidecars exist per subagent. That is not a
   * gap to be filled with a guess; "what is the main session doing" is answered
   * by `tool` below, and by the human who typed the prompt.
   */
  description: string | null;
  /**
   * The tool running RIGHT NOW, and the path it is working on. Both null the
   * moment the tool returns.
   *
   * Cleared rather than left showing the last tool, because a stale "Edit"
   * beside a "thinking" chip reads as a claim about the present. The state
   * already says what phase the agent is in; this says what it is doing in it,
   * or nothing.
   *
   * The tool NAME and a repo-relative path only, never the argument body. NG1
   * forbids retaining tool arguments; paths are carved out because MOD-02 grows
   * the map from them, but a Bash command line is not a path and does not
   * belong in memory or on screen.
   */
  tool: string | null;
  toolPath: string | null;
  /**
   * PSH-10 — wall ms at which the human said "I have seen this", or null.
   *
   * Acknowledgement silences reminders and clears the badge without pretending
   * the agent is unblocked: it stays visible, marked, in the dropdown. Cleared on
   * any state change, so an agent that blocks again is a fresh interruption.
   */
  acknowledgedAt: number | null;
}

/** A currently-blocked agent, with the context a notification envelope needs. */
export interface BlockedAgent {
  sessionId: string;
  agentId: string;
  cwd: string;
  reason: string;
  /**
   * How long it has been blocked.
   *
   * A permission event is not proof a human is needed. Under `defaultMode:
   * auto` the classifier resolves some of them with nobody looking, so the
   * agent enters `blocked` and leaves again in well under a second — and an
   * alert fired in that window interrupts someone about a decision that was
   * never theirs to make. The caller uses this to wait for the block to prove
   * it is real.
   */
  blockedForMs: number;
}

export interface SessionRecord {
  sessionId: string;
  provider: Provider;
  cwd: string;
  agents: Map<string, AgentRecord>;
  /**
   * MOD-01/MOD-08 — where work is happening in this session's repo, grown from
   * the paths events carry rather than by scanning anything.
   */
  map: RepoMap;
  /** Enriched from provider discovery (DMN-05); null until first seen there. */
  status: string | null;
  name: string | null;
  /**
   * Wall ms when `session_end` arrived, or null while live. This — not discovery
   * presence — is the primary end-of-life signal: it is immediate and exact,
   * whereas discovery is polled and a short-lived session can slip between polls
   * entirely. Retained briefly after ending so "what just finished" is still
   * answerable.
   */
  endedAt: number | null;
  /**
   * Whether discovery has ever reported this session. Pruning is gated on this:
   * a session that fired events but has not yet appeared in discovery is new,
   * not gone. Without this the first events of every session would be dropped —
   * which is precisely how v1 lost every `session_start`.
   */
  everDiscovered: boolean;
  /** Wall ms of the most recent event, for the undiscovered-session sweep below. */
  lastEventTs: number;
  /**
   * VIEW-06 — what this SESSION could not record, kept per session rather than
   * per daemon.
   *
   * A daemon-wide total attributed to one session is the same dishonesty as
   * hiding it: a session that dropped nothing renders a warning about work it
   * never lost, and once a surface has cried wolf about that it has spent the
   * credibility it needs for a real gap.
   *
   * `pathsOutsideRepo` is not a malfunction. It counts paths CAP-04 refused
   * because they resolve outside the repo root — reading `~/.zshrc` from a
   * session rooted in a project is the ordinary cause. A repo map genuinely
   * cannot place them, which is worth saying plainly and not worth alarming
   * anyone about. `invalidEvents` is the one that means something broke.
   */
  pathsOutsideRepo: number;
  invalidEvents: number;
  /** OS pid, enriched from discovery — what `astir focus` needs to find a window. */
  pid: number | null;
  /** DMN-11 — false when no human is sitting at it (a plugin or script drives it). */
  attended?: boolean;
}

export interface RegistryOpts {
  /** Injectable per §9 so time-dependent behaviour is testable. */
  nowMs: () => number;
  /**
   * How long to wait before calling an agent idle once the PROVIDER also
   * reports the session as not busy. Only a convergence delay, since by then
   * both sources agree.
   */
  idleAfterMs?: number;
  /**
   * How long to wait when the provider says nothing at all. Deliberately long:
   * the only thing being overridden is what the hooks last told us, and a build
   * that outlives this is rarer than discovery being briefly unavailable.
   */
  stalledAfterMs?: number;
  /** How long an ended session stays visible before being dropped. */
  endedGraceMs?: number;
  /**
   * How long a session that discovery has NEVER vouched for may sit silent
   * before being dropped. Closes the one gap both other prune paths miss: a
   * session that never sends `session_end` and never appears in discovery is
   * unreachable by either, and lingers in the badge forever.
   */
  undiscoveredTtlMs?: number;
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
  private readonly stalledAfterMs: number;
  private readonly endedGraceMs: number;
  private readonly undiscoveredTtlMs: number;
  private readonly maxSeen: number;
  /**
   * Whether discovery has ever produced a usable answer. The undiscovered sweep
   * is gated on it: with no working discovery, "never discovered" is evidence
   * about our own setup, not about the session, and pruning on it would delete
   * live sessions on any machine without `claude` on PATH.
   */
  private discoveryEverWorked = false;
  /** Discovered sessions we have never received an event from — see `silent()`. */
  private silentSessions: DiscoveredSession[] = [];

  constructor(opts: RegistryOpts) {
    this.nowMs = opts.nowMs;
    this.idleAfterMs = opts.idleAfterMs ?? 30_000;
    this.stalledAfterMs = opts.stalledAfterMs ?? 15 * 60_000;
    this.endedGraceMs = opts.endedGraceMs ?? 60_000;
    this.undiscoveredTtlMs = opts.undiscoveredTtlMs ?? 10 * 60_000;
    this.maxSeen = opts.maxSeenEvents ?? 10_000;
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * VIEW-06 — record what this session could not record.
   *
   * Takes a session id rather than a record so the daemon can call it for a
   * payload that never became a valid event: the session is often still
   * identifiable when the event is not, and losing the attribution is how a
   * count ends up daemon-wide and misleading.
   *
   * Deliberately does NOT create a session. A count for a session we have never
   * heard from has nowhere honest to appear, and inventing a record to hold it
   * would put a phantom row in every surface.
   */
  noteGaps(sessionId: string, gaps: { pathsOutsideRepo?: number; invalidEvents?: number }): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    session.pathsOutsideRepo += gaps.pathsOutsideRepo ?? 0;
    session.invalidEvents += gaps.invalidEvents ?? 0;
  }

  /**
   * Every agent currently blocked on a human. Reminders (PSH-02) have no
   * triggering event, so the notification loop polls this rather than relying
   * only on transitions.
   */
  blockedAgents(): BlockedAgent[] {
    const out: BlockedAgent[] = [];
    for (const s of this.sessions.values()) {
      for (const a of s.agents.values()) {
        // Acknowledged agents are still blocked, but the human has already been
        // told and chose to defer. Re-notifying would be nagging, not alerting.
        if (HUMAN_BLOCKING.has(a.state) && a.acknowledgedAt === null) {
          out.push({
            sessionId: s.sessionId,
            agentId: a.id,
            cwd: s.cwd,
            reason: a.blockedReason ?? "blocked",
            blockedForMs: Math.max(0, this.nowMs() - a.stateSince),
          });
        }
      }
    }
    return out;
  }

  /** Count of agents blocked on a human and not yet acknowledged (PSH-08). */
  blockedCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      for (const a of s.agents.values()) {
        if (HUMAN_BLOCKING.has(a.state) && a.acknowledgedAt === null) n++;
      }
    }
    return n;
  }

  /**
   * PSH-10 — "I have seen this." Silences the badge and reminders for every
   * currently-blocked agent, in one session or everywhere.
   *
   * Returns the number of agents affected so the caller can tell the user
   * whether anything actually happened.
   */
  acknowledge(sessionId?: string): number {
    const now = this.nowMs();
    let n = 0;
    for (const s of this.sessions.values()) {
      if (sessionId !== undefined && s.sessionId !== sessionId) continue;
      for (const a of s.agents.values()) {
        if (HUMAN_BLOCKING.has(a.state) && a.acknowledgedAt === null) {
          a.acknowledgedAt = now;
          n++;
        }
      }
    }
    return n;
  }

  /**
   * Drop a session outright. The escape hatch for a record that should not be
   * there at all — a synthetic test session, or one whose process died in a way
   * that left no end-of-life signal.
   */
  forget(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * `silentSessions` is a snapshot taken at each discovery poll, so between
   * polls a session that has just started speaking is in BOTH lists — the menu
   * bar then shows the same repo twice, once live and once "not connected".
   * Retiring it here rather than waiting for the next reconcile closes that
   * window at the moment the evidence arrives.
   */
  private heard(sessionId: string): void {
    if (this.silentSessions.length === 0) return;
    this.silentSessions = this.silentSessions.filter((d) => d.sessionId !== sessionId);
  }

  apply(event: AstirEvent, cwd: string): IngestResult {
    if (this.seen.has(event.eventId)) return { applied: false, reason: "duplicate" };
    this.seen.add(event.eventId);
    while (this.seen.size > this.maxSeen) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }

    const session = this.ensureSession(event.sessionId, event.provider, cwd);
    this.heard(event.sessionId);
    const agent = this.ensureAgent(session, event);
    if (agent.description === null && event.description !== null) {
      agent.description = event.description;
    }

    // MOD-06 — timestamp-monotonic. A stale event never rewrites state.
    if (event.ts < agent.lastEventTs) return { applied: false, reason: "stale" };
    agent.lastEventTs = event.ts;
    agent.lastActivityMs = this.nowMs();

    // MOD-01/MOD-02 — the map grows from paths the adapter already normalised
    // and scoped to the repo (CAP-04). Deliberately after both guards above:
    // the eventId dedup at the top of this method is what stops a redelivered
    // event double-counting heat, and a stale event must not add any.
    if (event.paths.length > 0) session.map.touch(event.paths);
    session.lastEventTs = agent.lastActivityMs;

    if (TERMINAL.has(agent.state) && event.kind !== "session_start") {
      return { applied: false, reason: "terminal" };
    }

    if (event.kind === "session_end") session.endedAt = this.nowMs();
    else if (event.kind === "session_start") session.endedAt = null; // resumed

    const next = this.nextState(event, agent.state);
    const becameBlocked =
      next !== agent.state && HUMAN_BLOCKING.has(next)
        ? { sessionId: session.sessionId, agentId: agent.id, kind: event.notificationKind ?? "blocked" }
        : undefined;

    if (HUMAN_BLOCKING.has(next)) agent.blockedReason = event.notificationKind ?? "blocked";
    else agent.blockedReason = null;

    // What it is doing, for as long as it is doing it. `pre_tool` opens the
    // action and anything else closes it — including `notification`, because an
    // agent blocked on a permission prompt mid-Edit is waiting on a human, not
    // editing, and saying "Edit" there would describe the wrong thing.
    if (event.kind === "pre_tool") {
      agent.tool = event.tool;
      agent.toolPath = event.paths[0] ?? null;
    } else if (agent.tool !== null) {
      agent.tool = null;
      agent.toolPath = null;
    }

    this.transition(agent, next);

    return becameBlocked ? { applied: true, becameBlocked } : { applied: true };
  }

  /** Advance wall-clock-derived transitions. Must be called periodically. */
  tick(): void {
    const now = this.nowMs();
    for (const [id, s] of [...this.sessions]) {
      // An ended session lingers briefly so "what just finished" is answerable,
      // then goes. This is the deterministic path; discovery pruning is only a
      // backstop for sessions that die without sending session_end.
      if (s.endedAt !== null && now - s.endedAt >= this.endedGraceMs) {
        this.sessions.delete(id);
        continue;
      }

      // The third prune path, and the only one that catches a session which
      // neither ends cleanly nor is ever vouched for by discovery — an injected
      // or orphaned record. Without it such a session is immortal: `endedAt`
      // stays null so the branch above never fires, and `everDiscovered` stays
      // false so `reconcile` refuses to touch it. Gated on discovery having
      // worked at least once, so a machine with no `claude` on PATH does not
      // silently delete every live session it knows about.
      if (this.discoveryEverWorked && !s.everDiscovered && now - s.lastEventTs >= this.undiscoveredTtlMs) {
        this.sessions.delete(id);
        continue;
      }

      // The idle timer exists to catch a session that stopped without telling
      // us. It must not fire on one that is simply BUSY — and it did, constantly:
      // `lastActivityMs` only moves when an event arrives, and between
      // `PreToolUse` and `PostToolUse` there are none. Any tool call longer than
      // the timeout — a build, a test run, a subagent — flipped a working agent
      // to idle, which is precisely the lie this project exists to prevent, and
      // the default was ten seconds.
      //
      // Discovery already answers this authoritatively, every five seconds, and
      // its answer was being ignored here.
      const providerBusy = s.status !== null && PROVIDER_BUSY.has(s.status);
      for (const a of s.agents.values()) {
        if (IDLE_EXEMPT.has(a.state)) continue;
        // Positive evidence that it is working. Do not contradict it.
        if (providerBusy) continue;
        // With no word from the provider there is nothing to corroborate, so
        // wait far longer before overriding what the hooks last told us — a
        // long build must not be declared idle just because discovery is
        // unavailable.
        const limit = s.status === null ? this.stalledAfterMs : this.idleAfterMs;
        if (now - a.lastActivityMs >= limit) this.transition(a, "idle");
      }
    }
  }

  private nextState(event: AstirEvent, current: AgentState): AgentState {
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
    if (agent.state === next) return; // not a transition; banking would double-count

    const elapsed = Math.max(0, now - agent.stateSince);
    if (HUMAN_BLOCKING.has(agent.state)) {
      agent.blockedMs += elapsed;
    } else if (WORKING_STATES.has(agent.state)) {
      agent.activeMs += elapsed;
      agent.turnMs += elapsed;
    }

    // Handing control back to the human ends the turn. `blocked` deliberately
    // does not: the agent is mid-turn and resumes the moment you answer.
    if (TURN_END.has(next)) agent.turnMs = 0;

    agent.state = next;
    agent.stateSince = now;
    // A new state is a new situation: whatever the human dismissed is over.
    agent.acknowledgedAt = null;
  }

  private ensureSession(sessionId: string, provider: Provider, cwd: string): SessionRecord {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        sessionId,
        provider,
        cwd,
        agents: new Map(),
        map: new RepoMap(),
        status: null,
        name: null,
        endedAt: null,
        everDiscovered: false,
        lastEventTs: this.nowMs(),
        pathsOutsideRepo: 0,
        invalidEvents: 0,
        pid: null,
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /**
   * DMN-05 — fold provider discovery into what we already know.
   *
   * Deliberately NOT a gate on ingest. Gating would drop the opening events of
   * every session while discovery caught up, reintroducing v1's bootstrap race in
   * a new place. Discovery enriches and prunes; events are the source of truth for
   * a session existing.
   *
   * `null` means discovery could not run (no `claude` on PATH, a timeout). In that
   * case nothing is pruned — otherwise a missing binary would read as every session
   * having ended.
   */
  reconcile(discovered: DiscoveredSession[] | null): { enriched: number; pruned: number } {
    if (discovered === null) return { enriched: 0, pruned: 0 };
    this.discoveryEverWorked = true;

    const live = new Set<string>();
    let enriched = 0;
    const silent: DiscoveredSession[] = [];
    for (const d of discovered) {
      live.add(d.sessionId);
      const s = this.sessions.get(d.sessionId);
      if (!s) {
        // Known to the provider, but it has sent us nothing. Either it has only
        // just started, or — far more likely once it persists — its hooks are not
        // wired up at all. Recorded rather than skipped, because "I am receiving
        // nothing" and "nothing is running" are completely different situations
        // and a surface that renders them identically is lying to the user.
        silent.push(d);
        continue;
      }
      s.everDiscovered = true;
      s.status = d.status;
      s.name = d.name;
      s.pid = d.pid;
      if (d.attended !== undefined) s.attended = d.attended;
      if (d.cwd) s.cwd = d.cwd;
      enriched++;
    }

    let pruned = 0;
    for (const [id, s] of [...this.sessions]) {
      // Only prune something discovery has previously vouched for. A session we
      // have events from but discovery has never listed is new, not dead.
      if (s.everDiscovered && !live.has(id)) {
        this.sessions.delete(id);
        pruned++;
      }
    }
    this.silentSessions = silent;
    return { enriched, pruned };
  }

  /**
   * Sessions the provider reports as running that have never sent us an event.
   *
   * This is the "astir is deaf" signal. A session appears here when its hooks are
   * not registered — most commonly because it was started before the plugin was
   * installed, since hooks bind at session start and are never picked up
   * mid-session.
   */
  silent(): DiscoveredSession[] {
    return [...this.silentSessions];
  }

  private ensureAgent(session: SessionRecord, event: AstirEvent): AgentRecord {
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
        turnMs: 0,
        stateSince: this.nowMs(),
        lastActivityMs: this.nowMs(),
        acknowledgedAt: null,
        blockedReason: null,
        description: null,
        tool: null,
        toolPath: null,
      };
      session.agents.set(event.agentId, a);
      return a;
    }
    // Upsert identity fields that only some events carry, so an out-of-order
    // subagent_stop before subagent_start cannot strand an agent with a null type.
    if (a.agentType === null && event.agentType !== null) a.agentType = event.agentType;
    // Same reason as agentType: only `subagent_start` carries it, and it may
    // arrive after an event that created the record.
    if (a.description === null && event.description !== null) a.description = event.description;
    if (a.parentSource === null && event.parentSource !== null) {
      a.parentId = event.parentAgentId;
      a.parentSource = event.parentSource;
    }
    return a;
  }
}
