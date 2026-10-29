/** MOD-04/05/06 — session + agent state, and the active-vs-blocked accounting. */

import { CAPABILITIES } from "../contract/capabilities.js";
import type { AstirEvent, ParentSource, Provider } from "../contract/event.js";
import type { DiscoveredSession, SessionScreen } from "../discovery/sessions.js";
import { debug } from "../obs/debug.js";
import { RepoMap } from "./map.js";
import { identityMatches, SNAPSHOT_VERSION, type Snapshot, type SnapshotSession } from "./snapshot.js";

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

/**
 * #86 — how long after a dialog was claimed a listing must have STARTED before
 * its `idle` is believed.
 *
 * The listing is a child process that takes its time, so its answer can
 * describe the session from before the hook that claimed the dialog arrived.
 * A poll begun a second after the claim cannot: the dialog is up by then
 * (measured: visible ~0.4 s after `PermissionRequest`, and `waiting` from the
 * first poll).
 */
const LISTING_SETTLE_MS = 1_000;

/**
 * #86 — how long a claimed dialog (`PermissionRequest`) waits to be seen
 * before the claim is dropped, and how far back a block seen from it can be
 * dated.
 *
 * A dialog that is on screen is seen well inside it, by measurement:
 * Claude's listing reads `waiting` / `"permission prompt"` from the first poll
 * begun once it is up (~0.4 s after the claim), and polls begin every 5 s, so
 * even when the first one after the claim began too early to see it, the next
 * begins ~6 s in at the latest; the `permission_prompt` Notification comes
 * ~6.2–6.6 s after the claim (the fixture; #86's table). Ten seconds covers
 * both, with room for a poll to start late or a hook to arrive late.
 *
 * Not much longer, because a claim that outlives its dialog — approved before
 * any poll saw it, or a background ask Claude denied itself — is exactly what
 * a sighting of some OTHER dialog can be mistaken for. Inside the window that
 * is bounded (a sighting blocks only the newest claim, see
 * `settleFromListing`); past it, never. The Notification can come later than
 * this — Claude sends it once the user has been idle at the dialog for 6 s,
 * checked every 6 s — but only for a user who was touching the terminal while
 * the dialog was up, and then the listing will have seen it first; such a
 * late Notification blocks from when it arrives.
 *
 * A claim a sighting passed over — it was not the newest, or a block already
 * standing explained the sighting — may still be a dialog on screen, queued
 * or simply older than a claim with none behind it. Its window runs from the
 * last such sighting (`dialogHeldAt`) rather than from the claim, so it cannot
 * lapse while the screen keeps showing a dialog that could be its own.
 */
export const CLAIM_WINDOW_MS = 10_000;

/**
 * #86 verification — how long a dialog must have been claimed before a
 * `permission_prompt` Notification can be about it.
 *
 * Claude sends the Notification once the dialog has been up 6 s (an interval
 * of 6 s from when the dialog opens, read from 2.1.312), and the dialog opens
 * as it is claimed: measured 6.17 s and 6.37 s after `PermissionRequest`. So a
 * claim younger than that is another dialog — a queued one, or one Claude
 * denied itself — and a Notification taken for it took the dialog that was
 * really on screen with it. A second under the measured gap, for a hook that
 * lands late.
 */
const NOTICE_MIN_AGE_MS = 5_000;

/**
 * #86 — the events that are an agent's own progress, and so the only ones
 * that end its block or its claimed dialog.
 *
 * It ran a tool, finished or failed one, ended its turn, its session or
 * itself, or its session (re)started — a dialog survives none of these.
 * Everything else says nothing about whether a human answered: a
 * `file_changed` names no agent (Claude builds it with no agent context) and
 * fires for any write to a watched path, the user's editor's included; a
 * notification is the session telling you something, and a blocking one is a
 * reason to stay blocked; `subagent_start` is a new agent's first event. The
 * listing ends a Claude block too (`settleFromListing`).
 */
const OWN_PROGRESS = new Set<AstirEvent["kind"]>([
  "session_start",
  "pre_tool",
  "post_tool",
  "tool_failed",
  "stop",
  "session_end",
  "subagent_stop",
]);

/** The notification kinds that mean "come look": they block. */
const BLOCKING_NOTIFICATIONS = new Set([
  "permission_prompt",
  "agent_needs_input",
  "worker_permission_prompt",
]);

/**
 * #86 — the block reasons a provider's listing has been measured to end.
 *
 * Only Claude's own permission dialog — a tool's and `AskUserQuestion`'s
 * both arrive as `permission_prompt`. `agent_needs_input` is a session telling
 * you about ANOTHER agent (Claude's text is "<agent> needs your input"), so
 * this session's `idle` says nothing about whether that need is met, and
 * nobody has measured what the listing shows for a worker's prompt. Those keep
 * ending the way they always have, on the agent's next event. Nor do they take
 * over a block the listing can end (`apply`): the agent is waiting on its own
 * dialog either way, and a reason the listing cannot end would leave it
 * blocked, and reminding, after Esc.
 */
const LISTING_ENDS = new Set(["permission_prompt"]);

/**
 * #86 — whether an open claim's window has run out at `at`: CLAIM_WINDOW_MS
 * from the claim, or from the last sighting that held it.
 */
function claimLapsed(a: AgentRecord, at: number): boolean {
  if (a.dialogSince === null) return false;
  return at - Math.max(a.dialogSince, a.dialogHeldAt ?? a.dialogSince) >= CLAIM_WINDOW_MS;
}

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
   * #86 — wall ms at which Claude last claimed a permission dialog for this
   * agent (`PermissionRequest`), or null.
   *
   * While the agent is not blocked it is an open claim: nothing has seen that
   * dialog on screen yet. A claim is not a block. Claude fires
   * `PermissionRequest` for asks that can never show a dialog — a background
   * agent's, a headless session's — and denies them itself, so blocking on it
   * alone alerted about prompts nobody could see. The agent blocks once the
   * dialog is SEEN — the listing says a permission dialog is on screen, or the
   * Notification arrives — and the block is dated from here, so PSH-16's
   * dwell counts from the moment the dialog opened rather than from the
   * sighting. An open claim lasts CLAIM_WINDOW_MS from the claim, or from the
   * last sighting that held it (`dialogHeldAt`): past that, nothing can see it.
   *
   * While the agent is blocked it is the claim the block came from (the newest,
   * if the agent asked again). It is what a later Notification — which names no
   * agent — and a later sighting are matched against, so one dialog never
   * blocks two agents.
   *
   * Only the agent's own progress ends it (OWN_PROGRESS), or the listing
   * finding the session idle, or the block it became ending. Never persisted,
   * and on no surface.
   */
  dialogSince: number | null;
  /**
   * #86 verification — when the latest poll STARTED that saw a permission
   * dialog this open claim could have been, but that went to another: a newer
   * claim, or a block already standing. Null until one has; reset by a new
   * claim. Only meaningful while the claim is open.
   *
   * The listing says a dialog is up, not whose, so a sighting takes one claim
   * and passes the rest over. One it passed over may be the very dialog on
   * screen — older than a claim Claude denied itself, or queued behind a
   * block's — and must not lapse while the screen still shows a dialog; once
   * the block that took the sighting ends, the next sighting is its. Never
   * persisted, and on no surface.
   */
  dialogHeldAt: number | null;
  /**
   * #86 — when the latest discovery poll that found a permission dialog on
   * screen STARTED during this agent's
   * block; null when none has, or when the agent has claimed another dialog
   * since.
   *
   * It is what makes a later `busy` mean "answered": a dialog was open, and
   * now the session is working. A `busy` with none before it proves nothing,
   * because the listing can lag the hook (`AskUserQuestion` read `busy` a
   * second into its dialog). Per agent, not per session: a dialog another agent
   * claims afterwards is not this one, so it cannot make this one's sighting
   * stale. Cleared by every state change. Never persisted, and not on any
   * surface: it is evidence, not state.
   */
  dialogSeenAt: number | null;
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
  /**
   * #80 — wall ms at which the notify loop first sent `blocked` for this
   * block, or null.
   *
   * The loop is the one place that decides a block has proved itself (PSH-16,
   * with each provider's dwell — CAP-02), so it records the decision here and
   * every in-terminal surface counts only announced blocks rather than
   * re-deriving the dwell and disagreeing with the desktop. Set through
   * `markAnnounced`, cleared by `clearAnnounced` and by any state change: a new
   * block is a new interruption and must be announced afresh.
   *
   * Never persisted (DMN-06): a restored block has not proved itself to the
   * daemon now running, so it restores as null and earns it again.
   */
  announcedAt: number | null;
}

/** A currently-blocked agent, with the context a notification envelope needs. */
export interface BlockedAgent {
  sessionId: string;
  agentId: string;
  /** PSH-16 — how long a block must last before it is real depends on who sent it. */
  provider: Provider;
  cwd: string;
  reason: string;
  /**
   * DMN-06 — this block came off the crash-recovery snapshot, unconfirmed.
   *
   * `blockedForMs` is then a duration that ACCRUED BEFORE the daemon died, so
   * it sails past PSH-16's dwell the instant the daemon comes back. That is
   * PSH-16's own failure arriving from the other direction: the dwell exists to
   * prove a block is real, and this one proves only that it was real earlier.
   */
  restored: boolean;
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
  /**
   * #80 — `AgentRecord.announcedAt` for THIS block, or null.
   *
   * The loop's own memory of what it announced is keyed by agent, and an agent
   * can be answered and block again between two pulses without the loop ever
   * seeing it leave `blocked`. The registry clears this on that state change,
   * so a key the loop holds with this null means the block it announced is
   * over and the one in front of it has not proved itself yet.
   */
  announcedAt: number | null;
}

/**
 * A session whose liveness can be checked from its pid alone. See
 * `discovery/pids.ts`: the provider that needs this has no session listing.
 */
export interface PidCandidate {
  sessionId: string;
  cwd: string;
  pid: number;
  /** When the process at `pid` started, once something has looked. */
  startedAt: number | null;
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
  /**
   * Epoch ms the provider says this session started, when it reports one.
   *
   * Enriched from discovery like `pid`. Part of the identity a crash-recovery
   * snapshot is checked against: a sessionId outlives a process and a pid is
   * recycled, so neither alone proves the session on disk is the one running.
   */
  startedAt: number | null;
  /** DMN-11 — false when no human is sitting at it (a plugin or script drives it). */
  attended?: boolean;
  /**
   * This state came from the crash-recovery snapshot, not from an event.
   *
   * Worth saying out loud rather than presenting as ordinary: the guard proves
   * the SESSION is still alive, not that its agent state is current. An agent
   * that was blocked when the daemon died may have been unblocked while it was
   * down, and astir would have no way to know until the session next acts.
   * Cleared by the first event, which is the moment the state stops being a
   * memory and starts being an observation.
   */
  restored?: boolean;
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

/** Keep what an incomplete poll could not re-confirm, prefer what it did see. */
function mergeSilent(previous: DiscoveredSession[], fresh: DiscoveredSession[]): DiscoveredSession[] {
  const byId = new Map(previous.map((d) => [d.sessionId, d]));
  for (const d of fresh) byId.set(d.sessionId, d);
  return [...byId.values()];
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
  /**
   * Providers whose discovery has answered at least once.
   *
   * Per provider, not global: the undiscovered-session sweep uses this to
   * decide that a record discovery has never vouched for is dead. One global
   * flag means Claude's discovery working makes astir willing to reap CODEX
   * sessions it has never been able to see — and a blocked Codex session emits
   * nothing, so its `lastEventTs` stalls and the sweep is exactly what reaches
   * it first.
   */
  private discoveryEverWorked = new Set<Provider>();
  /** Discovered sessions we have never received an event from — see `silent()`. */
  /**
   * Silent sessions, by the provider that reported them.
   *
   * A flat list could only be REPLACED wholesale, and a complete answer from
   * one provider says nothing about another's — so replacing on it dropped
   * every silent session belonging to anyone else.
   */
  private silentByProvider = new Map<Provider, DiscoveredSession[]>();
  /** Saved sessions awaiting a provider's confirmation. See `stageRestore`. */
  private pendingRestore = new Map<string, SnapshotSession>();
  /** OBS-01 — blocks begun, by any path. See `blocksBegun`. */
  private blocks = 0;

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
            provider: s.provider,
            cwd: s.cwd,
            reason: a.blockedReason ?? "blocked",
            blockedForMs: Math.max(0, this.nowMs() - a.stateSince),
            restored: s.restored === true,
            announcedAt: a.announcedAt,
          });
        }
      }
    }
    return out;
  }

  /**
   * OBS-01 — how many times an agent has begun to wait on a human, whatever
   * began it: an event (`apply`), or Claude's session listing seeing a claimed
   * dialog (`reconcile`, #86). Counted where every state change is made
   * (`transition`), so no path can miss it; a restored block is not a new one.
   */
  blocksBegun(): number {
    return this.blocks;
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
   * #80 — the notify loop sent `blocked` for this agent at `atMs`.
   *
   * Keeps the FIRST time: a reminder is not a new announcement, and "oldest
   * 3m" means three minutes since the user was first told. Ignored for an
   * agent that is not blocked, so a late call can never mark a block that
   * ended while the doorbell was in flight. Unknown ids are a no-op — the
   * session may have been forgotten under the loop.
   *
   * And ignored for a block that began AFTER `atMs`. The loop reads every
   * blocked agent once, at the start of a pulse, then awaits each delivery in
   * turn; while a slow path holds one agent's doorbell, a sibling can be
   * answered and block again. Marking that new block with the pulse's older
   * clock would vouch for a block of age zero — PSH-16's dwell skipped — and
   * date it before it existed, overstating "oldest".
   */
  markAnnounced(sessionId: string, agentId: string, atMs: number): void {
    const a = this.sessions.get(sessionId)?.agents.get(agentId);
    if (a === undefined || !HUMAN_BLOCKING.has(a.state) || a.announcedAt !== null) return;
    if (atMs < a.stateSince) return;
    a.announcedAt = atMs;
  }

  /** #80 — the loop has resolved or forgotten this agent's block. */
  clearAnnounced(sessionId: string, agentId: string): void {
    const a = this.sessions.get(sessionId)?.agents.get(agentId);
    if (a !== undefined) a.announcedAt = null;
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
   * The silent list is a snapshot taken at each discovery poll, so between
   * polls a session that has just started speaking is in BOTH lists — the menu
   * bar then shows the same repo twice, once live and once "not connected".
   * Retiring it here rather than waiting for the next reconcile closes that
   * window at the moment the evidence arrives.
   *
   * Swept across every provider: the session just spoke, so whichever list it
   * is in is now wrong, and we do not need to know which one that was.
   */
  private heard(sessionId: string): void {
    for (const [provider, list] of this.silentByProvider) {
      if (list.some((d) => d.sessionId === sessionId)) {
        this.silentByProvider.set(
          provider,
          list.filter((d) => d.sessionId !== sessionId),
        );
      }
    }
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
    // The state has stopped being a memory and started being an observation.
    // Also the point at which a restored `blocked` that had since resolved is
    // corrected — which is why the flag says "restored" rather than nothing.
    session.restored = false;
    this.heard(event.sessionId);
    // #86 — before anything is recorded against an agent: a Notification that
    // named none may be another agent's.
    const ev = this.attributeDialogNotice(session, event);
    const agent = this.ensureAgent(session, ev);
    if (agent.description === null && ev.description !== null) {
      agent.description = ev.description;
    }

    // MOD-06 — timestamp-monotonic. A stale event never rewrites state.
    if (ev.ts < agent.lastEventTs) return { applied: false, reason: "stale" };
    agent.lastEventTs = ev.ts;
    agent.lastActivityMs = this.nowMs();

    // MOD-01/MOD-02 — the map grows from paths the adapter already normalised
    // and scoped to the repo (CAP-04). Deliberately after both guards above:
    // the eventId dedup at the top of this method is what stops a redelivered
    // event double-counting heat, and a stale event must not add any.
    if (ev.paths.length > 0) session.map.touch(ev.paths);
    session.lastEventTs = agent.lastActivityMs;

    if (TERMINAL.has(agent.state) && ev.kind !== "session_start") {
      return { applied: false, reason: "terminal" };
    }

    if (ev.kind === "session_end") session.endedAt = this.nowMs();
    else if (ev.kind === "session_start") session.endedAt = null; // resumed

    // #86 — a claim, not a block (`AgentRecord.dialogSince`). Nothing else
    // about the agent changes: it is still running the tool it asked for, as
    // far as anyone has seen. An agent already blocked keeps its block and its
    // date, but this dialog is a new one nobody has seen, so a sighting from
    // before it cannot make a later `busy` its answer. Another agent's
    // sighting is untouched: the dialog it saw is not this one.
    if (ev.notificationKind === "permission_request") {
      agent.dialogSince = this.nowMs();
      agent.dialogHeldAt = null;
      agent.dialogSeenAt = null;
      return { applied: true };
    }

    // #86 — an open claim lasts CLAIM_WINDOW_MS; past it, it is gone.
    const blocked = HUMAN_BLOCKING.has(agent.state);
    if (!blocked && claimLapsed(agent, this.nowMs())) agent.dialogSince = null;
    // #86 — an event that is not the agent's own progress says nothing about a
    // dialog it is blocked on or has claimed, so it changes nothing about the
    // agent: not its state, its reason, its date or its claim. A FileChanged
    // names no agent and lands on the main agent for anyone's write; a
    // notification that blocks nothing is the session saying something else.
    // A blocking one goes on, to block or to stay blocked.
    const blocking = ev.kind === "notification" && BLOCKING_NOTIFICATIONS.has(ev.notificationKind ?? "");
    if ((blocked || agent.dialogSince !== null) && !OWN_PROGRESS.has(ev.kind) && !blocking) {
      return { applied: true };
    }
    // #86 verification — nor does a blocking one the listing cannot end, on
    // an agent blocked on a dialog it can (LISTING_ENDS). `agent_needs_input`
    // is about another agent, a worker's prompt is a worker's; this agent is
    // waiting on its own dialog either way. Taking over the reason swapped a
    // block Esc ends for one only the agent's next event does, and reminded
    // about the wrong thing until then.
    if (
      blocked &&
      blocking &&
      LISTING_ENDS.has(agent.blockedReason ?? "") &&
      !LISTING_ENDS.has(ev.notificationKind ?? "")
    ) {
      return { applied: true };
    }
    if (ev.notificationKind === "permission_prompt") this.retractYoungerBlocks(session, agent);

    const next = this.nextState(ev, agent.state);
    const becameBlocked =
      next !== agent.state && HUMAN_BLOCKING.has(next)
        ? { sessionId: session.sessionId, agentId: agent.id, kind: ev.notificationKind ?? "blocked" }
        : undefined;
    // #86 — the Notification sees a dialog that was claimed: the block began at
    // the claim, and keeps it (`dialogSince`). The agent's own progress ends
    // the claim — it answered, moved on, or was never going to show a dialog —
    // and a block that is about something else is not the claim's.
    const sighted = becameBlocked && ev.notificationKind === "permission_prompt" ? agent.dialogSince : null;
    if (OWN_PROGRESS.has(ev.kind) || (becameBlocked && sighted === null)) agent.dialogSince = null;

    if (HUMAN_BLOCKING.has(next)) agent.blockedReason = ev.notificationKind ?? "blocked";
    else agent.blockedReason = null;

    // What it is doing, for as long as it is doing it. `pre_tool` opens the
    // action and anything else closes it — including `notification`, because an
    // agent blocked on a permission prompt mid-Edit is waiting on a human, not
    // editing, and saying "Edit" there would describe the wrong thing.
    if (ev.kind === "pre_tool") {
      agent.tool = ev.tool;
      agent.toolPath = ev.paths[0] ?? null;
    } else if (agent.tool !== null) {
      agent.tool = null;
      agent.toolPath = null;
    }

    this.transition(agent, next, sighted ?? undefined);

    return becameBlocked ? { applied: true, becameBlocked } : { applied: true };
  }

  /**
   * #86 — whose dialog a `permission_prompt` notification that names no agent
   * is about.
   *
   * Claude builds its Notification hook input with no agent context (2.1.312:
   * `lf(e,Ug())`, where PermissionRequest gets `lf(…,s)`), so it never carries
   * an `agent_id` and normalizes to the main agent — while a subagent's dialog
   * is claimed by that subagent. Taken at its word, a subagent's dialog blocked
   * the main agent too: two alerts for one dialog, and a parent stuck blocked
   * long after the approval.
   *
   * So it goes to the agent with the newest claim in the session that is old
   * enough to be its dialog (`noticeOwner`): one still open (inside its
   * window) or one a sighting already turned into a block, which it then
   * merely confirms. Old enough, because Claude sends it once the dialog has
   * been up 6 s (NOTICE_MIN_AGE_MS): a claim made since is some other dialog,
   * and taking it for this one lost the one on screen. Newest of those,
   * because a claim that outlived its dialog — approved before anything saw
   * it — is older than the one on screen, and the same rule picks the dialog a
   * listing saw (`settleFromListing`). With no such claim it is the main
   * agent's, as it always was: a session that sends no claims (one started
   * before `PermissionRequest` was registered, or a provider that has none),
   * or a dialog that sends none (plan approval), is untouched.
   *
   * Only an event that landed on the main agent by default is moved, and the
   * identity it carries is dropped: it was the main agent's, and a subagent's
   * parentage is not the main agent's to overwrite.
   */
  private attributeDialogNotice(session: SessionRecord, event: AstirEvent): AstirEvent {
    if (event.notificationKind !== "permission_prompt" || event.agentId !== event.sessionId) return event;
    const owner = this.noticeOwner(session, this.nowMs());
    if (owner === null || owner.id === event.agentId) return event;
    return {
      ...event,
      agentId: owner.id,
      agentType: null,
      parentAgentId: null,
      parentSource: null,
      description: null,
    };
  }

  /**
   * #86 verification — a `permission_prompt` Notification says which dialog
   * has been on screen these last 6 s (NOTICE_MIN_AGE_MS): `owner`'s, claimed
   * before then, or one that sent no claim. A block a sighting gave a claim
   * made since was that same dialog taken for another — a background ask
   * Claude denied itself, or a dialog queued behind — and is taken back, as if
   * it had never begun: the agent is running the tool it asked for, since it
   * asked, and its claim stays open and held, because its dialog may yet come
   * up. None of it is banked as blocked; an alert already sent is resolved.
   *
   * Only a sighting can have made such a block: a Notification blocks a claim
   * only once it is old enough, and a younger claim is never one.
   */
  private retractYoungerBlocks(session: SessionRecord, owner: AgentRecord): void {
    const now = this.nowMs();
    for (const a of session.agents.values()) {
      if (a === owner || !HUMAN_BLOCKING.has(a.state) || a.blockedReason !== "permission_prompt") continue;
      if (a.dialogSince === null || now - a.dialogSince >= NOTICE_MIN_AGE_MS) continue;
      debug("registry", "a Notification took back a block a sighting made", {
        session: session.sessionId,
        agent: a.id,
        claimedForMs: now - a.dialogSince,
      });
      a.state = "tool-running";
      a.blockedReason = null;
      a.dialogSeenAt = null;
      a.dialogHeldAt = now;
      a.acknowledgedAt = null;
      a.announcedAt = null;
    }
  }

  /**
   * #86 — whose dialog a `permission_prompt` Notification at `at` is about:
   * the newest claim in the session made at least NOTICE_MIN_AGE_MS before it,
   * either still open (inside its window) or the claim a block came from. A
   * blocked agent wins a tie, since it adds no new block. Null when there is
   * none.
   */
  private noticeOwner(session: SessionRecord, at: number): AgentRecord | null {
    let newest: AgentRecord | null = null;
    for (const a of session.agents.values()) {
      const since = a.dialogSince;
      if (since === null || at - since < NOTICE_MIN_AGE_MS) continue;
      const isBlocked = HUMAN_BLOCKING.has(a.state);
      if (!isBlocked && claimLapsed(a, at)) continue;
      const best = newest?.dialogSince ?? null;
      if (best === null || since > best || (since === best && isBlocked)) newest = a;
    }
    return newest;
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
      //
      // And only a session discovery could have vouched for. A provider that
      // vouches by pid never saw a session that has not reported one — the
      // first turn before any pid-bearing event, or a machine with no `ps` —
      // so its silence is not evidence, and silence is exactly what a blocked
      // agent sounds like. Sweeping it would delete a real block and send a
      // `resolved` for it.
      const couldHaveSeen = CAPABILITIES[s.provider].liveness === "listing" || s.pid !== null;
      if (
        this.discoveryEverWorked.has(s.provider) &&
        couldHaveSeen &&
        !s.everDiscovered &&
        now - s.lastEventTs >= this.undiscoveredTtlMs
      ) {
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
      // #86 verification — and a session with an agent waiting on a human has
      // not stopped either: its turn resumes when the human answers. Before
      // #86 a subagent's prompt blocked its parent too, which the timer leaves
      // alone; with the block where it belongs, the parent — still running the
      // Agent tool — went idle 30 s into its subagent's prompt, because the
      // listing reads `waiting` then, not busy.
      const waitingOnHuman = [...s.agents.values()].some((a) => HUMAN_BLOCKING.has(a.state));
      for (const a of s.agents.values()) {
        if (IDLE_EXEMPT.has(a.state)) continue;
        // Positive evidence that it is working. Do not contradict it.
        if (providerBusy || waitingOnHuman) continue;
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
        // Only the "come look" kinds are human-blocking. Claude's
        // `PermissionRequest` (`permission_request`) is not one: `apply` takes
        // it as a claim before it gets here (#86). Its Notification, ~6 s
        // later, sees the dialog and blocks, dated from the claim — unless the
        // listing saw it first, and then the agent is already blocked. Neither
        // says when the dialog ends on Esc; the listing does
        // (`settleFromListing`).
        return BLOCKING_NOTIFICATIONS.has(event.notificationKind ?? "") ? "blocked" : current;
      default:
        return current;
    }
  }

  /**
   * MOD-05 — bank the time spent in the state we are leaving.
   *
   * `since` dates the new state earlier than now, for a block seen after it
   * began (#86): from then on the agent was waiting on a human, so the time is
   * banked as blocked rather than as the working state it was recorded in.
   * Never before the state being left began — that time is already banked.
   */
  private transition(agent: AgentRecord, next: AgentState, since?: number): void {
    const now = this.nowMs();
    if (agent.state === next) return; // not a transition; banking would double-count

    const at = Math.min(now, Math.max(since ?? now, agent.stateSince));
    const elapsed = Math.max(0, at - agent.stateSince);
    if (!HUMAN_BLOCKING.has(agent.state) && HUMAN_BLOCKING.has(next)) this.blocks++;
    if (HUMAN_BLOCKING.has(agent.state)) {
      agent.blockedMs += elapsed;
    } else if (WORKING_STATES.has(agent.state)) {
      agent.activeMs += elapsed;
      agent.turnMs += elapsed;
    }

    // Handing control back to the human ends the turn. `blocked` deliberately
    // does not: the agent is mid-turn and resumes the moment you answer.
    if (TURN_END.has(next)) agent.turnMs = 0;

    // #86 — a block that ends takes its claim with it, and a sighting belongs
    // to the state it was made in.
    if (HUMAN_BLOCKING.has(agent.state)) agent.dialogSince = null;
    agent.dialogSeenAt = null;

    agent.state = next;
    agent.stateSince = at;
    // A new state is a new situation: whatever the human dismissed is over.
    agent.acknowledgedAt = null;
    // And whatever they were told about. Cleared here rather than left for the
    // loop's next pulse, so a surface polling in between never shows a block
    // that has already ended as one the user is waiting on.
    agent.announcedAt = null;
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
        startedAt: null,
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
  /**
   * `complete: false` means at least one source could not be listed — see
   * `DiscoveryResult`. Enrichment still applies, because what did answer is
   * true; PRUNING does not, because a session missing from an incomplete view
   * has not been shown to be gone. Defaults to true so a caller with a single
   * complete source needs to say nothing.
   */
  /**
   * Fold one PROVIDER's discovery into the registry.
   *
   * `provider` is explicit and required rather than derived from `discovered`,
   * because the one input this exists to handle — an empty array, meaning "that
   * provider is running nothing" — is precisely the one a provider cannot be
   * derived from. Getting it from the data would work until the moment it
   * matters and then delete every session of the other provider.
   *
   * `observedAt` is when the poll that produced `discovered` STARTED, in wall
   * ms on this registry's clock. #86 reads what a session's listing says is on
   * its screen (`DiscoveredSession.screen`) as evidence about a block, and
   * evidence is only as recent as the moment it was asked
   * for: a poll that began before a block cannot speak about it, however late
   * its answer lands. Defaults to now, for a caller with nothing to say.
   */
  reconcile(
    discovered: DiscoveredSession[] | null,
    opts: { complete?: boolean; provider?: Provider; observedAt?: number } = {},
  ): { enriched: number; pruned: number } {
    if (discovered === null) return { enriched: 0, pruned: 0 };
    const complete = opts.complete ?? true;
    const provider: Provider = opts.provider ?? "claude";
    const observedAt = opts.observedAt ?? this.nowMs();
    this.discoveryEverWorked.add(provider);

    const live = new Set<string>();
    let enriched = 0;
    const silent: DiscoveredSession[] = [];
    for (const d of discovered) {
      live.add(d.sessionId);
      const s = this.sessions.get(d.sessionId);
      if (!s) {
        // The moment a saved session earns its place. The provider is reporting
        // this process right now, and its identity matches what was written —
        // so the agent state is about something still running, which is the one
        // thing a snapshot cannot establish on its own.
        const saved = this.pendingRestore.get(d.sessionId);
        if (saved !== undefined && saved.provider === provider && identityMatches(saved, d)) {
          this.pendingRestore.delete(d.sessionId);
          this.adopt(saved, d);
          enriched++;
          continue;
        }
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
      s.startedAt = d.startedAt;
      if (d.attended !== undefined) s.attended = d.attended;
      if (d.cwd) s.cwd = d.cwd;
      // Only for a session this poll actually listed, so an incomplete poll
      // clears nothing it did not see. And only by the provider that owns it:
      // a capability is a property of the provider's listing.
      if (s.provider === provider && CAPABILITIES[provider].listingClearsBlocks) {
        this.settleFromListing(s, d, observedAt);
      }
      enriched++;
    }

    let pruned = 0;
    if (complete) {
      for (const [id, s] of [...this.sessions]) {
        // Only prune something discovery has previously vouched for. A session we
        // have events from but discovery has never listed is new, not dead.
        //
        // And only within the provider that just reported. Claude's lister
        // knows nothing about Codex's sessions, so their absence from its
        // answer is not evidence of anything — pruning on it deletes live
        // sessions of the other provider on every tick, with a green suite.
        if (s.provider === provider && s.everDiscovered && !live.has(id)) {
          this.sessions.delete(id);
          pruned++;
        }
      }
    }
    // Same reasoning twice over: an incomplete view cannot REPLACE the silent
    // list because the profiles that failed contribute none of theirs — and
    // neither can a complete view from ONE provider, because the other
    // provider's silent sessions are not in it either. What this provider just
    // reported replaces what it reported last time; everyone else's survives.
    if (complete) {
      // A complete answer that does not mention a saved session is the provider
      // saying it is not running. Keeping it "just in case" is how a snapshot
      // starts reporting work that stopped while the daemon was down.
      for (const [id, saved] of [...this.pendingRestore]) {
        if (saved.provider === provider && !live.has(id)) this.pendingRestore.delete(id);
      }
    }
    const previous = this.silentByProvider.get(provider) ?? [];
    this.silentByProvider.set(provider, complete ? silent : mergeSilent(previous, silent));
    debug("reconcile", "swept", {
      provider,
      discovered: discovered.length,
      pruned,
      complete,
    });

    return { enriched, pruned };
  }

  /**
   * #86 — what a provider's session listing says about a permission dialog
   * that no hook will report on.
   *
   * Claude fires `PermissionRequest` before a dialog, and also for asks that
   * never show one; it fires nothing when a dialog is dismissed with Esc, and
   * nothing between approving one and the tool finishing. Its listing
   * (CAPABILITIES.claude, `claude agents --json`) fills both gaps. The lister
   * translates what it says into `DiscoveredSession.screen` (CAP-02: no
   * provider's words here), read against when each poll STARTED:
   *
   * - `permission-dialog`: a dialog is on screen. That is ONE dialog, and the
   *   listing does not say whose.
   *   - Every agent already blocked on a dialog begun by then records the
   *     sighting (`dialogSeenAt`) — it may be theirs on screen — because it
   *     is what turns a later `working` into an answer. And if there is one,
   *     the sighting is its dialog, and blocks nothing new: a claim made
   *     while a seen prompt is up is queued behind it, or Claude denied it
   *     itself, and blocking it alerted about a prompt nobody could see.
   *   - Otherwise it blocks one open claim begun by then: the newest, dated
   *     from its claim. Newest, because the failure the other choices have is
   *     a false alert: a claim that outlived its dialog (approved before any
   *     poll saw it, or a background ask Claude denied itself) is older than
   *     the dialog now on screen, and blocking it named an agent running an
   *     approved tool, with its dwell long gone and its running time banked
   *     as blocked.
   *   - Every open claim it did not block is held (`dialogHeldAt`): it may be
   *     the dialog on screen — older than a claim with no dialog behind it, or
   *     queued — so its window runs on from this sighting. Once the block that
   *     took the sighting ends, the next sighting is the held claim's, or its
   *     Notification is. Late, never lost.
   * - `other-dialog`: no evidence either way. Another dialog may be on top, or
   *   an MCP elicitation queued behind one, which Claude reports for as long
   *   as it waits whatever else is open — so in such a session the listing
   *   never says `at-prompt` or `working` either, and a block there ends the
   *   way it did before #86, on the agent's next event.
   * - `at-prompt`, from a poll begun at least LISTING_SETTLE_MS after the
   *   claim or block: nothing is on screen and the turn is over — Esc, or a
   *   turn that ended without our hearing it. A claim is dropped. A block
   *   ends, and the human has the floor, so the agent is `waiting`.
   * - `working`, from a poll begun after one that saw a dialog during THIS
   *   agent's block (its own `dialogSeenAt`): nothing is on screen any more,
   *   so its dialog was answered and the tool is running. Another agent's
   *   later claim does not change that — its dialog would read as one too. A
   *   `working` with no such sighting before it is no evidence of anything —
   *   the listing can trail the hook, and read `busy` for a second or more of
   *   an open `AskUserQuestion`.
   *
   * Not applied in the pass that adopts a restored session (DMN-06): `adopt`
   * runs before enrichment and the loop moves on, so a restored block is
   * settled by the next poll, 5 s later.
   *
   * Through `transition`, so the blocked time is banked (MOD-05) and
   * `announcedAt` cleared; the notify loop then sends `resolved` for an
   * announced block on its next pulse, as for any other unblock. The tool's
   * name is not restored on the way to `tool-running` — the block cleared it,
   * and `PermissionRequest` does not carry a call id to tie it back to.
   */
  private settleFromListing(s: SessionRecord, d: DiscoveredSession, observedAt: number): void {
    const screen = d.screen;
    if (screen === undefined) return;
    const agents = [...s.agents.values()];
    const isOpen = (a: AgentRecord): boolean => a.dialogSince !== null && !HUMAN_BLOCKING.has(a.state);
    // A claim this poll began past the window of is gone, whatever it says.
    for (const a of agents) {
      if (isOpen(a) && claimLapsed(a, observedAt)) a.dialogSince = null;
    }
    const open = agents.filter(isOpen);
    const blocked = agents.filter(
      (a) => HUMAN_BLOCKING.has(a.state) && LISTING_ENDS.has(a.blockedReason ?? ""),
    );
    if (open.length === 0 && blocked.length === 0) return;
    // A blocked agent's current dialog began at its block, or at a claim it
    // made since; a poll begun before that cannot speak for it.
    const dialogStart = (a: AgentRecord): number => Math.max(a.stateSince, a.dialogSince ?? a.stateSince);

    if (screen === "permission-dialog") {
      const standing = blocked.filter((a) => observedAt >= dialogStart(a));
      for (const a of standing) a.dialogSeenAt = Math.max(a.dialogSeenAt ?? observedAt, observedAt);
      // Open claims this poll began after: only those can be on screen in it.
      const claims = open.filter((a) => (a.dialogSince ?? observedAt) <= observedAt);
      let newest: AgentRecord | null = null;
      if (standing.length === 0) {
        for (const a of claims) {
          if (newest === null || (a.dialogSince ?? 0) > (newest.dialogSince ?? 0)) newest = a;
        }
      }
      for (const a of claims) {
        if (a !== newest) a.dialogHeldAt = Math.max(a.dialogHeldAt ?? observedAt, observedAt);
      }
      if (newest === null) return;
      const since = newest.dialogSince ?? observedAt;
      debug("reconcile", "listing saw a claimed dialog", {
        session: s.sessionId,
        agent: newest.id,
        claimedForMs: Math.max(0, observedAt - since),
        held: claims.length - 1,
      });
      // What `apply` does for the Notification that sees it: the agent is
      // waiting on a human now, not running the tool it asked for.
      newest.blockedReason = "permission_prompt";
      newest.tool = null;
      newest.toolPath = null;
      this.transition(newest, "blocked", since);
      newest.dialogSeenAt = observedAt;
      return;
    }

    if (screen === "at-prompt") {
      for (const a of open) {
        if (observedAt - (a.dialogSince ?? observedAt) >= LISTING_SETTLE_MS) a.dialogSince = null;
      }
      for (const a of blocked) {
        if (observedAt - dialogStart(a) >= LISTING_SETTLE_MS)
          this.unblock(s, a, "waiting", screen, observedAt);
      }
      return;
    }

    if (screen === "working") {
      // The agent's own sighting, and a `working` asked for after it.
      for (const a of blocked) {
        if (a.dialogSeenAt !== null && observedAt > a.dialogSeenAt) {
          this.unblock(s, a, "tool-running", screen, observedAt);
        }
      }
    }
  }

  /** #86 — a block the listing has seen end. */
  private unblock(
    s: SessionRecord,
    a: AgentRecord,
    next: AgentState,
    screen: SessionScreen,
    observedAt: number,
  ): void {
    debug("reconcile", "listing ended a block", {
      session: s.sessionId,
      agent: a.id,
      screen,
      blockedForMs: Math.max(0, observedAt - a.stateSince),
    });
    a.blockedReason = null;
    this.transition(a, next);
  }

  /**
   * Sessions the provider reports as running that have never sent us an event.
   *
   * This is the "astir is deaf" signal. A session appears here when its hooks are
   * not registered — most commonly because it was started before the plugin was
   * installed, since hooks bind at session start and are never picked up
   * mid-session.
   */
  /**
   * Hold a snapshot's sessions aside, to be adopted only if discovery confirms.
   *
   * Deliberately NOT loaded into `sessions`: until the provider vouches for it,
   * a saved session is a claim about a process that may have exited while the
   * daemon was down. Until then it is not in the registry at all, so every
   * surface treats it exactly as it treats any other session astir has not
   * heard from — a path they already render honestly.
   */
  stageRestore(snap: Snapshot): void {
    for (const s of snap.sessions) this.pendingRestore.set(s.sessionId, s);
  }

  /**
   * A hook relay running inside the agent's process says which process it is.
   *
   * Discovery gives Claude sessions their pid; a provider with no session
   * listing has only this. A different pid under the same session id is a new
   * process — resuming a session keeps its id — so the start time is cleared
   * for the next liveness check to measure afresh rather than to compare
   * against the old process and conclude this one is a stranger.
   */
  observePid(sessionId: string, pid: number): void {
    const s = this.sessions.get(sessionId);
    if (s === undefined || s.pid === pid) return;
    s.pid = pid;
    s.startedAt = null;
  }

  /**
   * What a pid-based lister should check for one provider: live sessions that
   * reported a pid, and saved ones that recorded a pid and its start time —
   * without both, a restore cannot be told from a recycled pid.
   */
  pidCandidates(provider: Provider): PidCandidate[] {
    const out: PidCandidate[] = [];
    for (const s of this.sessions.values()) {
      if (s.provider === provider && s.pid !== null && s.endedAt === null) {
        out.push({ sessionId: s.sessionId, cwd: s.cwd, pid: s.pid, startedAt: s.startedAt });
      }
    }
    for (const saved of this.pendingRestore.values()) {
      if (saved.provider === provider && saved.pid !== null && saved.startedAt !== null) {
        out.push({ sessionId: saved.sessionId, cwd: saved.cwd, pid: saved.pid, startedAt: saved.startedAt });
      }
    }
    return out;
  }

  /** How many saved sessions are still waiting to be confirmed or discarded. */
  pendingRestoreCount(): number {
    return this.pendingRestore.size;
  }

  /**
   * DMN-06 — agent state only. The map is deliberately not persisted, and
   * neither is `announcedAt`: listed field by field below so it cannot leak in.
   */
  snapshot(): Snapshot {
    return {
      v: SNAPSHOT_VERSION,
      writtenAt: this.nowMs(),
      sessions: [...this.sessions.values()]
        // An ended session is lingering only so "what just finished" is
        // answerable; restoring one would resurrect it.
        .filter((s) => s.endedAt === null && s.agents.size > 0)
        .map((s) => ({
          sessionId: s.sessionId,
          provider: s.provider,
          cwd: s.cwd,
          name: s.name,
          pid: s.pid,
          startedAt: s.startedAt,
          agents: [...s.agents.values()].map((a) => ({
            id: a.id,
            agentType: a.agentType,
            parentId: a.parentId,
            parentSource: a.parentSource,
            state: a.state,
            activeMs: a.activeMs,
            blockedMs: a.blockedMs,
            turnMs: a.turnMs,
            stateSince: a.stateSince,
            lastActivityMs: a.lastActivityMs,
            lastEventTs: a.lastEventTs,
            blockedReason: a.blockedReason,
            description: a.description,
            tool: a.tool,
            toolPath: a.toolPath,
            acknowledgedAt: a.acknowledgedAt,
          })),
        })),
    };
  }

  silent(): DiscoveredSession[] {
    return [...this.silentByProvider.values()].flat();
  }

  /**
   * Rebuild a session from its saved agent state.
   *
   * `everDiscovered` is true because it just was — this runs from inside
   * reconcile, holding the provider's answer. `restored` marks the state as a
   * memory rather than an observation, and the first event clears it.
   *
   * No map is restored: DMN-06 permits agent state only, and heat rebuilds as
   * work continues.
   */
  private adopt(saved: SnapshotSession, found: DiscoveredSession): SessionRecord {
    const s = this.ensureSession(saved.sessionId, saved.provider, found.cwd || saved.cwd);
    s.everDiscovered = true;
    s.restored = true;
    s.name = found.name ?? saved.name;
    s.status = found.status;
    s.pid = found.pid;
    s.startedAt = found.startedAt;
    if (found.attended !== undefined) s.attended = found.attended;
    for (const a of saved.agents) {
      s.agents.set(a.id, {
        id: a.id,
        provider: saved.provider,
        agentType: a.agentType,
        parentId: a.parentId,
        parentSource: a.parentSource as ParentSource | null,
        state: a.state as AgentRecord["state"],
        lastEventTs: a.lastEventTs,
        activeMs: a.activeMs,
        blockedMs: a.blockedMs,
        turnMs: a.turnMs,
        stateSince: a.stateSince,
        lastActivityMs: a.lastActivityMs,
        blockedReason: a.blockedReason,
        description: a.description,
        tool: a.tool,
        toolPath: a.toolPath,
        acknowledgedAt: a.acknowledgedAt,
        // DMN-06 — a restored block must prove itself to THIS daemon. Its
        // `blockedForMs` accrued before the restart, and the loop re-measures
        // its dwell from the restore before announcing it again.
        announcedAt: null,
        // #86 — a claim is about a dialog this daemon heard of, and it heard
        // of none; nor has it polled anything since.
        dialogSince: null,
        dialogHeldAt: null,
        dialogSeenAt: null,
      });
    }
    return s;
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
        announcedAt: null,
        blockedReason: null,
        dialogSince: null,
        dialogHeldAt: null,
        dialogSeenAt: null,
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
    // A GUESS may be replaced by a FACT, never the reverse.
    //
    // "Only when null" was right for `agentType` and `description`, where every
    // answer is equally good, and wrong here because these answers are not: a
    // sidecar read is exact and `inferred` means astir could not find one. The
    // sidecar is written by the provider around the time the first event fires,
    // so an agent whose event wins that race was pinned to `inferred` forever —
    // and the sidecar appearing a moment later could never correct it. That
    // made the whole deterministic route a coin flip per agent.
    const upgrading = event.parentSource === "sidecar" && a.parentSource !== "sidecar";
    if (upgrading || (a.parentSource === null && event.parentSource !== null)) {
      a.parentId = event.parentAgentId;
      a.parentSource = event.parentSource;
    }
    return a;
  }
}
