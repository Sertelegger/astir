/**
 * PSH-01/PSH-02 — the notification loop.
 *
 * Ties the three pieces together: the registry says who is blocked, the policy
 * says whether now is a moment to say so, and the dispatcher delivers it
 * everywhere configured.
 *
 * Polled rather than purely event-driven, because reminders have no triggering
 * event — an agent that has been blocked for thirty minutes generates nothing.
 */

import type { Registry } from "../model/registry.js";
import { debug } from "../obs/debug.js";
import type { Dispatcher } from "./dispatch.js";
import { buildEnvelope } from "./envelope.js";
import type { NotifyPolicy } from "./policy.js";

/** One agent in one session — the granularity a person actually acts on. */
function keyOf(sessionId: string, agentId: string): string {
  return `${sessionId}:${agentId}`;
}

export interface NotifyLoopOpts {
  registry: Registry;
  policy: NotifyPolicy;
  dispatcher: Dispatcher;
  now?: () => number;
  onDelivered?: (summary: string) => void;
  /**
   * PSH-16 — how long a block must last before it is worth interrupting anyone.
   * Long enough that an auto-resolved permission never reaches it, short enough
   * to be invisible against the reminder cadence.
   */
  notifyAfterMs?: number;
}

export class NotifyLoop {
  private readonly now: () => number;
  /** Keys we have sent a `blocked` envelope for, and therefore owe a `resolved`. */
  private announced = new Set<string>();
  /**
   * When a restored block was first seen, per agent.
   *
   * The dwell for these is measured from the RESTORE rather than from the
   * block, because the block's own duration accrued while the daemon was dead
   * and proves nothing about now.
   */
  private restoredSeen = new Map<string, number>();
  private readonly notifyAfterMs: number;

  constructor(private opts: NotifyLoopOpts) {
    this.now = opts.now ?? (() => Date.now());
    this.notifyAfterMs = opts.notifyAfterMs ?? 5_000;
  }

  /**
   * Call periodically. Fires initial notifications and reminders, and forgets
   * agents that stopped being blocked so a later block starts a fresh schedule
   * rather than resuming a stale backoff.
   */
  async pulse(): Promise<void> {
    const now = this.now();
    const blocked = this.opts.registry.blockedAgents();
    const live = new Set(blocked.map((b) => keyOf(b.sessionId, b.agentId)));

    for (const b of blocked) {
      const key = keyOf(b.sessionId, b.agentId);
      // PSH-16 — let a block prove it is real before interrupting anyone.
      //
      // A permission EVENT is not evidence that a human is needed. Under
      // `defaultMode: auto` the classifier answers some of them itself, so the
      // agent is blocked for a few hundred milliseconds and never shows a
      // prompt — and an alert fired inside that window tells the user their
      // agent needs permission when it does not, which is the same class of lie
      // as reporting a dead daemon as idle.
      //
      // Only the FIRST notification waits. Once announced, the reminder cadence
      // is the policy's business, and a genuine block is minutes long anyway —
      // this delay is invisible against a one-minute reminder interval, and the
      // user is by definition not looking yet.
      debug("notify", "considering", {
        session: b.sessionId,
        agent: b.agentId,
        blockedForMs: b.blockedForMs,
        restored: b.restored,
        announced: this.announced.has(key),
      });

      // DMN-06 — a RESTORED block has not proved anything yet.
      //
      // Its `blockedForMs` accrued before the daemon died, so it clears the
      // dwell below the instant the daemon returns — PSH-16's own failure
      // arriving from a direction it did not anticipate. The dwell exists to
      // let a block prove it is real; this one proves only that it was real
      // earlier.
      //
      // Re-measured from the restore rather than skipped, and the distinction
      // is the whole design: a genuinely blocked agent emits NOTHING, so
      // waiting for it to act would silence the one thing this product exists
      // to say. A session that merely unblocked while the daemon was down is
      // working, and working sessions emit within that window — which clears
      // `restored` and replaces the memory with the truth.
      //
      // The BADGE is not gated, per PSH-16's own note that an ambient count
      // costs no attention. Only the interruption waits.
      if (!this.announced.has(key) && b.restored) {
        const first = this.restoredSeen.get(key) ?? now;
        this.restoredSeen.set(key, first);
        if (now - first < this.notifyAfterMs) continue;
      }
      if (!this.announced.has(key) && b.blockedForMs < this.notifyAfterMs) continue;
      if (!this.opts.policy.shouldNotify(key, "blocked", now)) continue;

      const envelope = buildEnvelope({
        kind: "blocked",
        reason: b.reason,
        sessionId: b.sessionId,
        agentId: b.agentId,
        cwd: b.cwd,
        now,
      });
      this.announced.add(key);
      const outcomes = await this.opts.dispatcher.send(envelope);
      const ok = outcomes.filter((o) => o.ok).map((o) => o.target);
      this.opts.onDelivered?.(`${envelope.body} → ${ok.length > 0 ? ok.join(", ") : "NO PATH DELIVERED"}`);
    }

    await this.forgetResolved(live, now);
    this.opts.policy.prune(now);
  }

  /**
   * An agent that is no longer blocked gets a clean slate next time — and, if we
   * told anyone about it, they are told it is over.
   *
   * That second part is what keeps a remote view honest. A receiver on another
   * machine only ever sees edges, so without an explicit `resolved` it has no way
   * to distinguish "still waiting" from "answered an hour ago", and its menu bar
   * accumulates entries nothing can clear.
   */
  private async forgetResolved(live: Set<string>, now: number): Promise<void> {
    for (const session of this.opts.registry.list()) {
      for (const agent of session.agents.values()) {
        const key = keyOf(session.sessionId, agent.id);
        if (live.has(key)) continue;

        // Only announce a resolution for something we actually announced.
        this.restoredSeen.delete(key);
        if (this.announced.delete(key)) {
          const envelope = buildEnvelope({
            kind: "resolved",
            reason: agent.blockedReason ?? "resolved",
            sessionId: session.sessionId,
            agentId: agent.id,
            cwd: session.cwd,
            now,
          });
          await this.opts.dispatcher.send(envelope);
        }
        this.opts.policy.resolve(key);
      }
    }
  }
}
