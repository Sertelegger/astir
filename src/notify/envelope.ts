/**
 * PSH-06/PSH-09 — the message that crosses a machine boundary.
 *
 * This is a **doorbell, not a payload**. It says which session, on which host,
 * in which repo, and why — and nothing else. No file contents, no paths, no tool
 * arguments, no reasoning text. Detail is retrieved from the local view via the
 * link, on the machine where the data already lives.
 *
 * That constraint is what makes the transport choice free: whether it travels
 * over an `ssh -R` tunnel to your own laptop or through a hosted push service,
 * the worst case is that someone learns a repo name.
 */

import { randomUUID } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { basename } from "node:path";
import type { NotifyKind } from "./policy.js";

/**
 * What an envelope can announce. `resolved` is not a notification — nothing is
 * displayed for it — it is the "you can stop showing this" signal.
 *
 * Without it a doorbell is write-only: a receiver on another machine learns that
 * an agent became blocked and never learns that it stopped, so any view it builds
 * from envelopes accumulates entries that can only be cleared by hand. That is
 * the same immortal-entry bug as an unprunable session, arriving over the network.
 */
export type EnvelopeKind = NotifyKind | "resolved";

/** Notification titles, in the user's language rather than the state machine's. */
const TITLE_BY_KIND: Record<string, string> = {
  blocked: "An agent needs you",
  completed: "An agent finished",
  failed: "An agent failed",
  resolved: "Resolved",
};

export const ENVELOPE_VERSION = { major: 1, minor: 0 } as const;

export interface NotifyEnvelope {
  v: { major: number; minor: number };
  /** Stable id so a receiver can dedupe across retries or overlapping transports. */
  id: string;
  ts: number;
  kind: EnvelopeKind;
  /** The provider's own notification type, verbatim, e.g. `permission_prompt`. */
  reason: string;
  origin: {
    host: string;
    user: string;
  };
  session: {
    sessionId: string;
    agentId: string;
    /**
     * Repo *name* only — deliberately the basename, never the full path.
     * "which repo" is routing; "/Users/me/clients/acme/secret-thing" is not.
     */
    repo: string;
  };
  title: string;
  body: string;
}

export interface BuildEnvelopeInput {
  kind: EnvelopeKind;
  reason: string;
  sessionId: string;
  agentId: string;
  cwd: string;
  now?: number;
  id?: string;
  host?: string;
  user?: string;
}

/**
 * The machine name a person recognises. `os.hostname()` returns the FQDN, which
 * on a typical Mac is something like `Saschas-Air.localdomain` — the suffix is
 * pure noise in a notification and, on a corporate network, can leak an internal
 * domain to wherever the doorbell travels.
 */
export function shortHost(name: string): string {
  return name.split(".")[0] || name;
}

export function buildEnvelope(input: BuildEnvelopeInput): NotifyEnvelope {
  const repo = basename(input.cwd) || "unknown";
  const host = shortHost(input.host ?? hostname());
  const shortSession = input.sessionId.slice(0, 8);

  return {
    v: ENVELOPE_VERSION,
    id: input.id ?? randomUUID(),
    ts: input.now ?? Date.now(),
    kind: input.kind,
    reason: input.reason,
    origin: { host, user: input.user ?? safeUser() },
    session: { sessionId: input.sessionId, agentId: input.agentId, repo },
    title: TITLE_BY_KIND[input.kind] ?? "Clide",
    // Retained for receivers that render the envelope directly. Anything that
    // knows where it is should prefer `notificationText` below, which drops the
    // host when the alert did not come from somewhere else.
    body: `${host} · ${repo} · ${shortSession} · ${input.reason}`,
  };
}

/**
 * Plain English for a provider's internal notification type.
 *
 * `reason` is carried verbatim across the wire on purpose — it is the provider's
 * own vocabulary and must survive round-tripping, version skew and logging
 * unmangled. But it is an identifier, not a sentence, and a notification banner
 * reading "permission_prompt" asks the reader to do the translation that this
 * tool exists to do for them.
 */
const REASON_TEXT: Record<string, string> = {
  permission_prompt: "needs permission to run something",
  worker_permission_prompt: "needs permission for a subagent",
  agent_needs_input: "is waiting for your input",
  idle_prompt: "has been idle for a while",
  agent_completed: "finished",
  blocked: "is waiting on you",
  resolved: "no longer needs you",
  doctor_test: "— this is a test notification",
};

/** Human-readable form of a reason, falling back to de-snake-casing the raw id. */
export function reasonText(reason: string): string {
  const known = REASON_TEXT[reason];
  if (known !== undefined) return known;
  // An unknown reason from a newer provider should still read as a phrase rather
  // than as a symbol — degrading to "needs_your_attention" helps nobody.
  return reason.replace(/[_-]+/g, " ").trim() || "needs your attention";
}

/**
 * Render an envelope for a human, given the machine they are looking at.
 *
 * The host prefix is routing information, and it is only information when the
 * answer is "somewhere else". Prefixing every local alert with the name of the
 * machine already in front of you is noise that pushes the part you actually
 * need — which repo, and why — past the width of a notification banner.
 */
export function notificationText(
  envelope: NotifyEnvelope,
  localHost: string = hostname(),
): { title: string; body: string } {
  const from = shortHost(envelope.origin.host);
  const here = shortHost(localHost);
  const where = from === here ? envelope.session.repo : `${from} · ${envelope.session.repo}`;
  return { title: envelope.title, body: `${where} ${reasonText(envelope.reason)}` };
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

/**
 * VER-01 — reject an unknown major, tolerate an unknown minor. A receiver may be
 * older or newer than the sender across a machine boundary; that is the normal
 * case, not the exception.
 */
export function validateEnvelope(
  raw: unknown,
): { ok: true; envelope: NotifyEnvelope } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "not an object" };
  const r = raw as Record<string, unknown>;

  const v = r.v as { major?: unknown } | undefined;
  if (!v || typeof v.major !== "number") return { ok: false, error: "missing version" };
  if (v.major !== ENVELOPE_VERSION.major) {
    return { ok: false, error: `unsupported envelope major ${String(v.major)}` };
  }

  for (const f of ["id", "kind", "reason", "title", "body"] as const) {
    if (typeof r[f] !== "string" || (r[f] as string).length === 0) {
      return { ok: false, error: `missing ${f}` };
    }
    if ((r[f] as string).length > 512) return { ok: false, error: `${f} too long` };
  }
  if (typeof r.ts !== "number" || !Number.isFinite(r.ts)) return { ok: false, error: "bad ts" };

  const origin = r.origin as Record<string, unknown> | undefined;
  const session = r.session as Record<string, unknown> | undefined;
  if (typeof origin?.host !== "string") return { ok: false, error: "missing origin.host" };
  if (typeof session?.sessionId !== "string") return { ok: false, error: "missing session.sessionId" };

  return { ok: true, envelope: raw as NotifyEnvelope };
}
