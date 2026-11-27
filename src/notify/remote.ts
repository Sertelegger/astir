/**
 * PSH-12 — what the notifier remembers about other machines.
 *
 * The menu bar reads the local daemon, so it can only ever show local sessions.
 * That is wrong for the case this project cares most about: sessions running over
 * SSH, in WSL, or in a dev container, which are precisely the ones you cannot see
 * and therefore the ones most likely to sit blocked unnoticed.
 *
 * A doorbell alone cannot fix that, because a doorbell is edge-triggered: it says
 * an agent became blocked and never says it stopped. Anything built from those
 * events accumulates entries that only a human can clear — the network version of
 * the immortal session record. So the sender also emits a `resolved` envelope,
 * and this view is level-triggered: it holds exactly the set of remote agents
 * currently believed to be waiting.
 *
 * #98 — the roster keeps it so between doorbells. Doorbells come on the
 * daemon's reminder schedule, which may now be an hour apart or never, and a
 * notifier that restarted, or a tunnel that came up, after a block's first
 * alert would not hear of it until the next. The roster crosses the same
 * tunnel every 10 s and names the agents blocked on its machine, so one it
 * names is listed, silently if no doorbell announced it here, and heard from
 * again. A roster only adds and refreshes: it never removes an entry, whether
 * or not it names it. Removal is a `resolved`, or the expiry below.
 *
 * Entries also expire. If the tunnel drops after a `blocked` and before its
 * `resolved`, a stale entry would otherwise persist forever, and a menu bar
 * confidently reporting a machine it can no longer hear from is worse than one
 * that admits it does not know.
 */

import { basename } from "node:path";
import { type NotifyEnvelope, shortHost } from "./envelope.js";
import type { RosterPayload } from "./roster.js";

/**
 * How long a remote entry survives without being reconfirmed.
 *
 * A still-blocked agent on a healthy tunnel is re-heard well before this, and
 * before `DEFAULT_STALE_MS` too, under every reminder schedule (#98): its
 * machine's roster names it every 10 s (`confirm`). Doorbells re-hear it as
 * well, but `calm` sends one an hour apart and `off` none after the first. A
 * daemon older than #98 names nobody in its roster, so for it the doorbells
 * are all there is, on its quarter-hourly reminders, for which this was sized.
 * Anything past it really has gone quiet: the tunnel is down, or the machine.
 */
const DEFAULT_TTL_MS = 2 * 60 * 60_000;

/**
 * How long silence must last before an entry is *shown* as unreachable.
 *
 * Distinct from the TTL on purpose. Vanishing is the wrong failure mode: if the
 * tunnel dies, the agent is still blocked and you have simply stopped being
 * told — so the surface must say it has lost contact rather than quietly drop
 * the row and look calm.
 */
const DEFAULT_STALE_MS = 20 * 60_000;

/**
 * #98 — how long a `resolved` outranks a roster.
 *
 * A roster and a doorbell travel separately and can cross: one built a moment
 * before a block ended may arrive after its `resolved`, still naming it. That
 * is not news, and since no roster removes an entry, listing it again would
 * leave it until the TTL. So for this long after a `resolved` a roster does
 * not list the agent again. Three of the daemon's roster ticks, well past its
 * 5 s push timeout.
 */
const RESOLVED_WINS_MS = 30_000;

/** What a roster-listed block is waiting on: the roster carries no reason. */
const ROSTER_REASON = "blocked";

export interface RemoteAgent {
  host: string;
  repo: string;
  sessionId: string;
  agentId: string;
  reason: string;
  /** When this agent was first reported blocked. */
  since: number;
  /** When we last heard anything about it — the basis for expiry. */
  lastSeen: number;
  acknowledged: boolean;
  /** True once we have not heard about this agent for `staleAfterMs`. */
  stale?: boolean;
}

export interface RemoteViewOpts {
  ttlMs?: number;
  staleAfterMs?: number;
}

function keyFor(host: string, sessionId: string, agentId: string): string {
  return `${host}/${sessionId}:${agentId}`;
}

function keyOf(e: NotifyEnvelope): string {
  return keyFor(e.origin.host, e.session.sessionId, e.session.agentId);
}

/**
 * A roster's agent, keyed as its doorbells are. A daemon's envelopes carry
 * `shortHost(hostname())` and its roster `hostname()`, so the roster's host is
 * shortened the same way and nothing else: one agent, one entry, by either
 * route.
 */
function rosterKey(roster: RosterPayload, sessionId: string, agentId: string): string {
  return keyFor(shortHost(roster.host), sessionId, agentId);
}

export class RemoteView {
  private entries = new Map<string, RemoteAgent>();
  /** #98 — when each recently `resolved` agent was resolved, so a crossing roster cannot list it again. */
  private resolvedAt = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly staleAfterMs: number;

  constructor(opts: RemoteViewOpts = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_MS;
  }

  /**
   * Fold an envelope in. Returns whether the caller should raise a desktop
   * notification for it — `resolved` updates the view silently, and a repeat of a
   * block we already know about is a reminder the sender decided to send, so it
   * is still shown.
   */
  apply(envelope: NotifyEnvelope, now: number): { notify: boolean } {
    const key = keyOf(envelope);

    if (envelope.kind === "resolved") {
      this.entries.delete(key);
      this.resolvedAt.set(key, now);
      return { notify: false };
    }

    if (envelope.kind !== "blocked") {
      // Terminal states are announced, not tracked: there is nothing left to wait on.
      return { notify: true };
    }

    const existing = this.entries.get(key);
    if (existing) {
      existing.lastSeen = now;
      existing.reason = envelope.reason;
      // A reminder for something already dismissed here stays dismissed.
      return { notify: !existing.acknowledged };
    }

    this.entries.set(key, {
      host: envelope.origin.host,
      repo: envelope.session.repo,
      sessionId: envelope.session.sessionId,
      agentId: envelope.session.agentId,
      reason: envelope.reason,
      since: now,
      lastSeen: now,
      acknowledged: false,
    });
    return { notify: true };
  }

  /**
   * #98 — fold in a roster: the agents blocked on its machine now. Never
   * raises a notification, and so returns nothing to show; alerts are the
   * doorbells' business, on the daemon's schedule.
   *
   * Each agent it names is heard from again, so it neither goes stale nor
   * expires while its machine keeps naming it, however far apart the
   * reminders. One not held here is listed, undismissed: a notifier that
   * restarted, or a tunnel that came up, after the block's first alert would
   * otherwise not list it until the next reminder, an hour off under `calm`
   * and never under `off`. Its wait is counted from what the roster says
   * (`blockedForMs`, a duration, so the two machines' clocks need not agree),
   * else from now, and a held entry's wait is moved earlier when the roster
   * says the block began before this view heard of it (R98-10).
   *
   * Nothing else about a held entry changes, and no entry is ever removed
   * here, named or not: removal is its `resolved`, or the TTL, as for any
   * entry. Entries past the TTL are dropped first, so a roster never revives
   * one. Only a roster that says it names blocked agents (`namesBlocked`) is
   * read for them.
   */
  confirm(roster: RosterPayload, now: number): void {
    this.prune(now);
    if (roster.namesBlocked !== true) return;

    for (const session of roster.sessions) {
      const forMs = session.blockedForMs;
      for (const [i, agentId] of (session.blocked ?? []).entries()) {
        const key = rosterKey(roster, session.sessionId, agentId);
        const waited = forMs?.[i];
        const existing = this.entries.get(key);
        if (existing) {
          existing.lastSeen = now;
          if (waited !== undefined) existing.since = Math.min(existing.since, now - waited);
          continue;
        }
        if (this.resolvedAt.has(key)) continue;
        this.entries.set(key, {
          host: shortHost(roster.host),
          repo: basename(session.cwd) || "unknown",
          sessionId: session.sessionId,
          agentId,
          reason: ROSTER_REASON,
          since: waited === undefined ? now : now - waited,
          lastSeen: now,
          acknowledged: false,
        });
      }
    }
  }

  /** PSH-10, for remote agents — silence without pretending they are unblocked. */
  acknowledge(sessionId?: string): number {
    let n = 0;
    for (const entry of this.entries.values()) {
      if (sessionId !== undefined && entry.sessionId !== sessionId) continue;
      if (!entry.acknowledged) {
        entry.acknowledged = true;
        n++;
      }
    }
    return n;
  }

  forget(sessionId: string): boolean {
    let removed = false;
    for (const [key, entry] of [...this.entries]) {
      if (entry.sessionId === sessionId) {
        this.entries.delete(key);
        removed = true;
      }
    }
    return removed;
  }

  /** Drop entries we have not heard about within the TTL. */
  prune(now: number): void {
    for (const [key, entry] of [...this.entries]) {
      if (now - entry.lastSeen >= this.ttlMs) this.entries.delete(key);
    }
    for (const [key, at] of [...this.resolvedAt]) {
      if (now - at >= RESOLVED_WINS_MS) this.resolvedAt.delete(key);
    }
  }

  /**
   * Every tracked remote agent, each flagged with whether contact has been lost.
   * `now` is required so staleness is computed at read time rather than depending
   * on how recently `prune` happened to run.
   */
  list(now: number = Date.now()): RemoteAgent[] {
    return [...this.entries.values()].map((e) => ({
      ...e,
      stale: now - e.lastSeen >= this.staleAfterMs,
    }));
  }

  /** Remote agents still demanding attention. */
  blockedCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (!e.acknowledged) n++;
    return n;
  }
}
