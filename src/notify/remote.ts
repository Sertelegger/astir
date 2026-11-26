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
 * #98 — and which agents are waiting is the roster's to say, not the
 * doorbells'. A doorbell arrives once per alert, on the daemon's reminder
 * schedule, which may now be an hour apart or never, and a notifier that
 * restarted, or a tunnel that came up, after the first alert would not hear of
 * the block until the next one. The roster crosses the same tunnel every 10 s
 * and names the agents blocked on its machine, so an agent it names is listed
 * (silently, if no doorbell announced it here) and one a later roster from the
 * same machine stops naming is retired. Doorbells remain the alert channel,
 * and `resolved` still retires at once.
 *
 * A dismissal here (PSH-10) is about the person, not the agent, so it
 * outlives the agent being retired by a roster: the far daemon restarting
 * mid-block stops naming it until it has announced it again, and that
 * announcement is the same block, already dismissed.
 *
 * Entries also expire. If the tunnel drops after a `blocked` and before its
 * `resolved`, a stale entry would otherwise persist forever, and a menu bar
 * confidently reporting a machine it can no longer hear from is worse than one
 * that admits it does not know.
 */

import { basename } from "node:path";
import { type NotifyEnvelope, sameHost, shortHost } from "./envelope.js";
import type { RosterPayload } from "./roster.js";

/**
 * How long a remote entry survives without being heard of.
 *
 * An entry is heard of from its machine's roster, which names the agents
 * blocked there and crosses the tunnel every 10 s (`confirm`), and from each
 * doorbell. For a daemon older than #98, whose roster names nobody, the
 * doorbells are all there is, and on its quarter-hourly reminders this was
 * sized for them. Anything past it really has gone quiet: the tunnel is down
 * or the machine is.
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
 * #98 — how long a doorbell outranks a roster.
 *
 * A roster and a doorbell travel separately and can cross: a roster built a
 * moment before a block was announced may arrive after its `blocked`, and one
 * built before the block ended may arrive after its `resolved`. Neither is
 * news, so for this long after a doorbell a roster neither retires the block
 * it announced nor lists again the one it resolved. Three of the daemon's
 * roster ticks, well past its 5 s push timeout.
 */
const DOORBELL_WINS_MS = 30_000;

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

/**
 * One key per agent, whichever route named it. Hosts as `sameHost` compares
 * them: an envelope carries the short name, a roster whatever `hostname()`
 * said, and the same agent must not be listed twice.
 */
function keyFor(host: string, sessionId: string, agentId: string): string {
  return `${shortHost(host).toLowerCase()}/${sessionId}:${agentId}`;
}

function keyOf(e: NotifyEnvelope): string {
  return keyFor(e.origin.host, e.session.sessionId, e.session.agentId);
}

interface Entry extends RemoteAgent {
  /** When a `blocked` doorbell for it last arrived; absent when only a roster has named it. */
  rungAt?: number;
}

/** A dismissed agent a roster retired: when, and what its entry said. */
interface Dismissal {
  sessionId: string;
  since: number;
  retiredAt: number;
}

export class RemoteView {
  private entries = new Map<string, Entry>();
  /** #98 — when each recently `resolved` agent was resolved, so a crossing roster cannot list it again. */
  private resolvedAt = new Map<string, number>();
  /** #98 (R98-3) — agents dismissed here that a roster retired, so listed again they are still dismissed. */
  private dismissed = new Map<string, Dismissal>();
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
      // The block is over, so its dismissal is too: the next one alerts.
      this.dismissed.delete(key);
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
      existing.rungAt = now;
      existing.reason = envelope.reason;
      // A reminder for something already dismissed here stays dismissed,
      // whichever route listed it.
      return { notify: !existing.acknowledged };
    }

    // Announced again after a roster retired it, dismissed: the far daemon
    // restarted, and this is the block it was dismissed in, not a new one.
    const dismissed = this.takeDismissal(key, now);
    this.entries.set(key, {
      host: envelope.origin.host,
      repo: envelope.session.repo,
      sessionId: envelope.session.sessionId,
      agentId: envelope.session.agentId,
      reason: envelope.reason,
      since: dismissed?.since ?? now,
      lastSeen: now,
      acknowledged: dismissed !== undefined,
      rungAt: now,
    });
    return { notify: dismissed === undefined };
  }

  /**
   * #98 — fold in a roster: the agents blocked on its machine now, which is
   * what this view lists for that machine. Never raises a notification, and
   * so returns nothing to show; alerts are the doorbells' business.
   *
   * Every agent it names is heard from again, and one not held here is
   * listed: a notifier that restarted, or a tunnel that came up, after the
   * block's first alert would otherwise not list it until the next reminder,
   * an hour off under `calm` and never under `off`. Its wait is counted from
   * what the roster says (`blockedForMs`, a duration, so the two machines'
   * clocks need not agree), else from now. An agent held for that machine and
   * not named is retired: its block is over, and its `resolved` was lost or
   * is still on its way.
   *
   * Only from a roster that says it names blocked agents (`namesBlocked`). A
   * daemon older than #98 names none, and its rosters say nothing either way.
   * A doorbell younger than `DOORBELL_WINS_MS` outranks a roster, which may
   * have been built before it. Hosts are compared as `sameHost` does.
   *
   * An agent dismissed here stays dismissed through being retired: listed
   * again, by a roster or a doorbell, within the TTL and with no `resolved`
   * between, it is listed dismissed. A far daemon that restarts mid-block
   * names it again only once it has announced it again, and a roster in
   * between would otherwise cost the person their dismissal and restart
   * every reminder for an agent they had silenced.
   */
  confirm(roster: RosterPayload, now: number): void {
    this.forgetResolved(now);
    if (roster.namesBlocked !== true) return;

    const named = new Set<string>();
    for (const session of roster.sessions) {
      const blocked = session.blocked ?? [];
      const forMs = session.blockedForMs;
      for (const [i, agentId] of blocked.entries()) {
        const key = keyFor(roster.host, session.sessionId, agentId);
        named.add(key);
        const existing = this.entries.get(key);
        if (existing) {
          existing.lastSeen = now;
          continue;
        }
        if (this.resolvedAt.has(key)) continue;
        const waited = forMs?.[i];
        const dismissed = this.takeDismissal(key, now);
        this.entries.set(key, {
          host: shortHost(roster.host),
          repo: basename(session.cwd) || "unknown",
          sessionId: session.sessionId,
          agentId,
          reason: ROSTER_REASON,
          since: waited !== undefined ? now - waited : (dismissed?.since ?? now),
          lastSeen: now,
          acknowledged: dismissed !== undefined,
        });
      }
    }

    for (const [key, entry] of [...this.entries]) {
      if (named.has(key) || !sameHost(entry.host, roster.host)) continue;
      if (entry.rungAt !== undefined && now - entry.rungAt < DOORBELL_WINS_MS) continue;
      this.entries.delete(key);
      if (entry.acknowledged) {
        this.dismissed.set(key, { sessionId: entry.sessionId, since: entry.since, retiredAt: now });
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

  /**
   * Drop a session's agents, dismissals included. One still blocked comes
   * back with the next roster from its machine (#98): it is still waiting
   * there.
   */
  forget(sessionId: string): boolean {
    let removed = false;
    for (const [key, entry] of [...this.entries]) {
      if (entry.sessionId === sessionId) {
        this.entries.delete(key);
        removed = true;
      }
    }
    for (const [key, d] of [...this.dismissed]) {
      if (d.sessionId === sessionId) this.dismissed.delete(key);
    }
    return removed;
  }

  /** Drop entries we have not heard about within the TTL. */
  prune(now: number): void {
    for (const [key, entry] of [...this.entries]) {
      if (now - entry.lastSeen >= this.ttlMs) this.entries.delete(key);
    }
    for (const [key, d] of [...this.dismissed]) {
      if (now - d.retiredAt >= this.ttlMs) this.dismissed.delete(key);
    }
    this.forgetResolved(now);
  }

  /**
   * The dismissal of a retired agent, if one is kept for it, and no longer
   * kept: it moves to the entry listing the agent again. Kept as long as an
   * entry not heard of is, the TTL, and whether or not `prune` has run.
   */
  private takeDismissal(key: string, now: number): Dismissal | undefined {
    const d = this.dismissed.get(key);
    if (d === undefined) return undefined;
    this.dismissed.delete(key);
    return now - d.retiredAt < this.ttlMs ? d : undefined;
  }

  /** Tombstones last only as long as a crossing roster could. */
  private forgetResolved(now: number): void {
    for (const [key, at] of [...this.resolvedAt]) {
      if (now - at >= DOORBELL_WINS_MS) this.resolvedAt.delete(key);
    }
  }

  /**
   * Every tracked remote agent, each flagged with whether contact has been lost.
   * `now` is required so staleness is computed at read time rather than depending
   * on how recently `prune` happened to run.
   */
  list(now: number = Date.now()): RemoteAgent[] {
    return [...this.entries.values()].map(({ rungAt: _, ...e }) => ({
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
