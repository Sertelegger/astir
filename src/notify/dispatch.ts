/**
 * PSH-06/PSH-07 — fan a doorbell out to every configured delivery path, and
 * remember which ones actually worked.
 *
 * The last part matters more than it looks. Silent non-delivery is the failure
 * mode this whole section exists to prevent, so "which path is live" has to be a
 * question `doctor` can answer, not something the user infers from the absence
 * of a notification.
 */

import type { DetectResult } from "./detect.js";
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
  // #78, round two — the last announcement's failure, or null while the path
  // is presumed good. `available` is the static gate (a binary, a bus or a
  // display); this is what the run itself said. A headless systemd host
  // passes the first — pam_systemd exports a bus address to every SSH login —
  // and fails every run, so without this it read as live forever while
  // nothing appeared. Lifted by the next announcement that succeeds, which is
  // why a dead path is still tried.
  let failure: string | null = null;
  return {
    name: "local",
    live: () => backend.available && failure === null,
    get unavailableReason() {
      if (!backend.available) return backend.unavailableReason;
      return failure ?? undefined;
    },
    deliver: async (envelope) => {
      // #78 — the floor is not a floor on a machine that cannot show anything.
      // Answering `ok: true` here is what let a block on megabrain count as
      // delivered after the tunnel to the Mac dropped. A resolution fails the
      // same way: no banner was ever raised, so there is nothing to withdraw.
      if (!backend.available) {
        return { ok: false, reason: backend.unavailableReason ?? `${backend.name} unavailable` };
      }
      try {
        const group = `${envelope.session.sessionId}:${envelope.session.agentId}`;

        // A resolution is not an announcement — it withdraws the banner that is
        // still sitting on screen. Without this, reminders about an agent that
        // has since been answered stay up until the user clears them by hand.
        // It neither kills nor revives the path: withdrawing shows nothing, so
        // it cannot say whether anything can be shown.
        if (envelope.kind === "resolved") {
          backend.remove(group);
          return { ok: true };
        }

        // Rendered for *here*, so a local alert does not lead with this machine's
        // own name. The envelope keeps the host either way for routing.
        const text = notificationText(envelope);
        const outcome = await backend.notify({
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
        failure = outcome.ok ? null : outcome.reason;
        return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
      } catch {
        // Not the error's text: a backend's message can carry what it was
        // asked to show, and this reason is repeated everywhere (SEC-01).
        failure = `${backend.name} failed to run`;
        return { ok: false, reason: failure };
      }
    },
  };
}

/**
 * A notifier's delivery path, which the PSH-14 probe can also speak for.
 */
export interface RemoteTarget extends DeliveryTarget {
  /**
   * The probe reached the notifier's `/healthz`, and this is what it said.
   * `canShow` absent is a notifier too old to say — read as it always was.
   */
  probed(health: { canShow?: boolean }): void;
}

/**
 * How the last POST failed. The probe can overturn some of these and not
 * others, so the kind matters: see `probed`.
 */
type PostFailure = {
  reason: string;
  /** No HTTP answer at all; a 503 (it cannot show); any other refusal. */
  kind: "unreachable" | "cannot-show" | "refused";
};

/**
 * How long the daemon waits for a notifier to answer a doorbell.
 *
 * The notifier answers only once its own child has settled, and gives up on
 * that child after `NOTIFIER_TIMEOUT_MS` — which must not be longer than this.
 * If it were, a wedged notify-send at the far end would time this POST out
 * ("could not reach it"), the next probe would reach a `/healthz` still
 * saying it can show, and the path would read live until the child finally
 * failed. No longer, and the notifier's verdict lands as this side gives up.
 */
export const REMOTE_TIMEOUT_MS = 5_000;

/**
 * A notifier on another host, reached over loopback or an `ssh -R` tunnel.
 * Never throws — a dead tunnel is a reported outcome, not an exception.
 */
export function remoteTarget(url: string, token: string, timeoutMs = REMOTE_TIMEOUT_MS): RemoteTarget {
  // #78 — two facts, held apart, and the path is live only while neither
  // says otherwise.
  //
  // `cannotShow` is what the PSH-14 probe last read at the notifier's
  // `/healthz`. A notifier on a headless box answers the probe like any other
  // and refuses every doorbell, so being found is not being able to reach
  // anyone.
  //
  // `failure` is the last POST's, or null while the path is presumed good.
  // Being attached is not being reachable either: a daemon given
  // `--notify-url` is never probed and so never detaches, and a notifier
  // holding a different token answers the probe — which needs no token — and
  // refuses every doorbell with 401. A failed POST is a verdict until a later
  // one succeeds or the probe disproves it.
  //
  // A successful POST answers only for `failure`. Round one let it answer for
  // both, and a notifier that cannot show 503'd each block and then accepted
  // the `resolved` after it — so the path read live between blocks, which is
  // when anyone looks.
  let cannotShow = false;
  let failure: PostFailure | null = null;
  const fail = (reason: string, kind: PostFailure["kind"]) => {
    failure = { reason, kind };
    return { ok: false, reason };
  };
  return {
    name: `remote(${url})`,
    live: () => !cannotShow && failure === null,
    get unavailableReason() {
      // Fixed words, never the refusal's body: this is repeated on the
      // startup line and in doctor, and the notifier is another machine.
      if (cannotShow) return "the notifier cannot show notifications";
      return failure?.reason;
    },
    probed: (health) => {
      if (health.canShow !== undefined) cannotShow = !health.canShow;
      // Reaching it disproves "could not reach it" — the 5-second restart
      // that one POST fell into, which otherwise read dead until a doorbell
      // happened to get through, hours later on an idle machine. A 503 is
      // disproved only by the notifier saying it can show now. A 401 is never
      // disproved here: `/healthz` takes no token, so answering it says
      // nothing about whether ours is right.
      if (failure?.kind === "unreachable" || (failure?.kind === "cannot-show" && health.canShow === true)) {
        failure = null;
      }
    },
    deliver: async (envelope) => {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(envelope),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err), "unreachable");
      }
      if (res.status === 401) return fail("unauthorized — token mismatch", "refused");
      if (res.status === 503) return fail("HTTP 503", "cannot-show");
      if (!res.ok) return fail(`HTTP ${res.status}`, "refused");
      failure = null;
      return { ok: true };
    },
  };
}

/**
 * PSH-14 — what the daemon does with each probe of the notifier port.
 *
 * Three answers, not two. Round one handled "found, not attached" (attach)
 * and "gone, attached" (detach), and did nothing at all with "found, already
 * attached" — so the probe that had just reached a healthy notifier threw
 * that away while one failed POST kept the path dead. Every reviewer who
 * reproduced it had to copy this logic out of `runDaemon` line for line; it
 * lives here so the daemon and the tests run the same code.
 */
export class NotifierWatch {
  private target: RemoteTarget | null = null;
  private attached: string | null = null;

  constructor(
    private readonly dispatcher: Dispatcher,
    private readonly token: string,
    private readonly timeoutMs = REMOTE_TIMEOUT_MS,
  ) {}

  /** The notifier attached now, if any — the roster push and `/state` read follow it. */
  get url(): string | null {
    return this.attached;
  }

  /** Apply one probe's answer. Returns the line for the daemon's log, or null when nothing changed. */
  observe(probe: DetectResult): string | null {
    const where = new URL(probe.url).host;

    if (!probe.found) {
      if (this.target === null) return null;
      this.dispatcher.remove(this.target.name);
      this.target = null;
      this.attached = null;
      // #78 — this is the moment no one may be told, so say who still can be.
      return `notifier on ${where} went away (${probe.reason ?? "gone"}); delivery paths: ${this.dispatcher.describe()}`;
    }

    if (this.target === null) {
      const target = remoteTarget(probe.url, this.token, this.timeoutMs);
      // Told what the probe saw BEFORE it joins the dispatcher, so there is no
      // moment in which a notifier that cannot show is counted as live.
      target.probed(probe);
      this.target = target;
      this.attached = probe.url;
      this.dispatcher.add(target);
      return target.live()
        ? `notifier detected on ${where} — delivering there too`
        : `notifier detected on ${where}, but it cannot show notifications; delivery paths: ${this.dispatcher.describe()}`;
    }

    const was = this.target.live();
    this.target.probed(probe);
    const now = this.target.live();
    if (was === now) return null;
    return now
      ? `notifier on ${where} is live again; delivery paths: ${this.dispatcher.describe()}`
      : `notifier on ${where} cannot show notifications; delivery paths: ${this.dispatcher.describe()}`;
  }
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
