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
}

export class NotifyLoop {
  private readonly now: () => number;
  /** Keys we have sent a `blocked` envelope for, and therefore owe a `resolved`. */
  private announced = new Set<string>();

  constructor(private opts: NotifyLoopOpts) {
    this.now = opts.now ?? (() => Date.now());
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
