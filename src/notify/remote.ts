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
 * Entries also expire. If the tunnel drops after a `blocked` and before its
 * `resolved`, a stale entry would otherwise persist forever, and a menu bar
 * confidently reporting a machine it can no longer hear from is worse than one
 * that admits it does not know.
 */

import type { NotifyEnvelope } from "./envelope.js";

/**
 * How long a remote entry survives without being reconfirmed.
 *
 * Comfortably longer than the slowest reminder cadence (quarter-hourly), so a
 * still-blocked agent on a healthy tunnel is always re-heard well before it
 * would expire. Anything past this really has gone quiet.
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

function keyOf(e: NotifyEnvelope): string {
  return `${e.origin.host}/${e.session.sessionId}:${e.session.agentId}`;
}

export class RemoteView {
  private entries = new Map<string, RemoteAgent>();
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
