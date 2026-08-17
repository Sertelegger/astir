/**
 * PSH-06/PSH-07 — fan a doorbell out to every configured delivery path, and
 * remember which ones actually worked.
 *
 * The last part matters more than it looks. Silent non-delivery is the failure
 * mode this whole section exists to prevent, so "which path is live" has to be a
 * question `doctor` can answer, not something the user infers from the absence
 * of a notification.
 */

import type { NotifyEnvelope } from "./envelope.js";
import type { Notifier } from "./notify.js";

export interface DeliveryOutcome {
  target: string;
  ok: boolean;
  reason?: string;
  at: number;
}

export interface DeliveryTarget {
  readonly name: string;
  deliver(envelope: NotifyEnvelope): Promise<{ ok: boolean; reason?: string }>;
}

/** The local desktop. Always present; the floor beneath everything else. */
export function localTarget(notify: Notifier): DeliveryTarget {
  return {
    name: "local",
    deliver: (envelope) => {
      try {
        notify({ title: envelope.title, body: envelope.body });
        return Promise.resolve({ ok: true });
      } catch (err) {
        return Promise.resolve({ ok: false, reason: String(err) });
      }
    },
  };
}

/**
 * A notifier on another host, reached over loopback or an `ssh -R` tunnel.
 * Never throws — a dead tunnel is a reported outcome, not an exception.
 */
export function remoteTarget(url: string, token: string, timeoutMs = 5_000): DeliveryTarget {
  return {
    name: `remote(${url})`,
    deliver: async (envelope) => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(envelope),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 401) return { ok: false, reason: "unauthorized — token mismatch" };
        if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export class Dispatcher {
  private last = new Map<string, DeliveryOutcome>();

  constructor(private targets: DeliveryTarget[]) {}

  /** Deliver everywhere. Failures on one path never suppress another. */
  async send(envelope: NotifyEnvelope): Promise<DeliveryOutcome[]> {
    const results = await Promise.all(
      this.targets.map(async (t) => {
        const r = await t.deliver(envelope);
        const outcome: DeliveryOutcome = r.reason
          ? { target: t.name, ok: r.ok, reason: r.reason, at: Date.now() }
          : { target: t.name, ok: r.ok, at: Date.now() };
        this.last.set(t.name, outcome);
        return outcome;
      }),
    );
    return results;
  }

  /** PSH-07 — what `doctor` reports: which paths exist and whether they work. */
  status(): DeliveryOutcome[] {
    return this.targets.map(
      (t) => this.last.get(t.name) ?? { target: t.name, ok: false, reason: "not yet attempted", at: 0 },
    );
  }

  names(): string[] {
    return this.targets.map((t) => t.name);
  }
}
