/**
 * PSH-06/PSH-07 — fan a doorbell out to every configured delivery path, and
 * remember which ones actually worked.
 *
 * The last part matters more than it looks. Silent non-delivery is the failure
 * mode this whole section exists to prevent, so "which path is live" has to be a
 * question `doctor` can answer, not something the user infers from the absence
 * of a notification.
 */

import { type NotifyEnvelope, notificationText } from "./envelope.js";
import type { NotifierBackend } from "./notify.js";

export interface DeliveryOutcome {
  target: string;
  ok: boolean;
  reason?: string;
  at: number;
}

export interface DeliveryTarget {
  readonly name: string;
  /**
   * PSH-07 / #78 — can this path deliver right now?
   *
   * Distinct from "is it configured", which is all `names()` ever said: the
   * startup line printed `delivery paths: local` on a machine with no way to
   * show a notification, and that line is the only place anyone looks.
   */
  live(): boolean;
  /**
   * Why `live()` is false, when the target knows. Content-free, for the
   * startup line and `doctor` to repeat. Read whenever it is needed rather
   * than fixed at construction: a remote path's answer changes with each
   * delivery.
   */
  readonly unavailableReason?: string | undefined;
  deliver(envelope: NotifyEnvelope): Promise<{ ok: boolean; reason?: string }>;
}

/**
 * The local desktop. Always present; the floor beneath everything else.
 *
 * `invocation` is the full argv prefix that runs astir — normally
 * `[process.execPath, <script>]`, NOT the script alone. A notification's click
 * action is executed by `/bin/sh` with a minimal PATH, so relying on the script's
 * `#!/usr/bin/env node` shebang produces `env: node: No such file or directory`
 * and a click that does nothing at all, silently. Passing the interpreter
 * explicitly is what makes the action survive that environment.
 *
 * Omitted, the notification is still raised, just not clickable — the right
 * degradation, since an alert you cannot act on still beats no alert.
 */
export function localTarget(backend: NotifierBackend, invocation?: string[]): DeliveryTarget {
  return {
    name: "local",
    live: () => backend.available,
    ...(backend.available || backend.unavailableReason === undefined
      ? {}
      : { unavailableReason: backend.unavailableReason }),
    deliver: (envelope) => {
      // #78 — the floor is not a floor on a machine that cannot show anything.
      // Answering `ok: true` here is what let a block on megabrain count as
      // delivered after the tunnel to the Mac dropped. A resolution fails the
      // same way: no banner was ever raised, so there is nothing to withdraw.
      if (!backend.available) {
        return Promise.resolve({
          ok: false,
          reason: backend.unavailableReason ?? `${backend.name} unavailable`,
        });
      }
      try {
        const group = `${envelope.session.sessionId}:${envelope.session.agentId}`;

        // A resolution is not an announcement — it withdraws the banner that is
        // still sitting on screen. Without this, reminders about an agent that
        // has since been answered stay up until the user clears them by hand.
        if (envelope.kind === "resolved") {
          backend.remove(group);
          return Promise.resolve({ ok: true });
        }

        // Rendered for *here*, so a local alert does not lead with this machine's
        // own name. The envelope keeps the host either way for routing.
        const text = notificationText(envelope);
        backend.notify({
          ...text,
          group,
          ...(invocation !== undefined && invocation.length > 0 && backend.capabilities.click
            ? {
                onClick: {
                  command: invocation[0] as string,
                  args: [...invocation.slice(1), "focus", envelope.session.sessionId],
                },
              }
            : {}),
        });
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
  // #78 — the last delivery's failure, or null while the path is presumed
  // good. Presumed, because the probe that attaches a detected notifier
  // (PSH-14) has just reached it. But being attached is not being reachable:
  // a daemon given `--notify-url` is never probed and so never detaches, and a
  // notifier holding a different token answers the probe — which needs no
  // token — and refuses every doorbell with 401. Both reported this path live
  // forever while nothing arrived. So a failed POST is a verdict until a later
  // one succeeds. Reactive, not polled: it can only learn on a send, so a
  // tunnel that recovers reads dead until the next doorbell proves it.
  let failure: string | null = null;
  const settle = (r: { ok: boolean; reason?: string }): { ok: boolean; reason?: string } => {
    failure = r.ok ? null : (r.reason ?? "delivery failed");
    return r;
  };
  return {
    name: `remote(${url})`,
    live: () => failure === null,
    get unavailableReason() {
      return failure ?? undefined;
    },
    deliver: async (envelope) => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(envelope),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 401) return settle({ ok: false, reason: "unauthorized — token mismatch" });
        if (!res.ok) return settle({ ok: false, reason: `HTTP ${res.status}` });
        return settle({ ok: true });
      } catch (err) {
        return settle({ ok: false, reason: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

export class Dispatcher {
  private last = new Map<string, DeliveryOutcome>();
  private targets: DeliveryTarget[];

  constructor(targets: DeliveryTarget[]) {
    this.targets = [...targets];
  }

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
      (t) =>
        this.last.get(t.name) ?? {
          target: t.name,
          ok: false,
          // A dead path has not merely not been tried — it cannot be, and why
          // is the thing to say.
          reason: t.live() ? "not yet attempted" : (t.unavailableReason ?? "not live"),
          at: 0,
        },
    );
  }

  /** Every configured path, live or not. */
  names(): string[] {
    return this.targets.map((t) => t.name);
  }

  /**
   * PSH-07 / #78 — the paths that can deliver right now. What `/healthz`
   * reports, so a surface can say "nothing can notify you" instead of
   * inferring it from silence.
   */
  live(): string[] {
    return this.targets.filter((t) => t.live()).map((t) => t.name);
  }

  /**
   * The startup line, after its `delivery paths: ` prefix: the live paths,
   * then every dead one with its reason — `none live (local: notify-send not
   * found)` rather than the bare `local` that reported a machine with no
   * desktop as covered.
   */
  describe(): string {
    const live = this.live();
    const dead = this.targets
      .filter((t) => !t.live())
      .map((t) => `${t.name}: ${t.unavailableReason ?? "not live"}`);
    const head = live.length > 0 ? live.join(", ") : "none live";
    return dead.length > 0 ? `${head} (${dead.join("; ")})` : head;
  }

  /** Attach a delivery path discovered after construction — e.g. an ssh tunnel. */
  add(target: DeliveryTarget): void {
    if (this.targets.some((t) => t.name === target.name)) return;
    this.targets.push(target);
  }

  /** Drop a path that has gone away, so `status()` stops implying it is live. */
  remove(name: string): void {
    this.targets = this.targets.filter((t) => t.name !== name);
    this.last.delete(name);
  }
}
