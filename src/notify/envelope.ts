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

export const ENVELOPE_VERSION = { major: 1, minor: 0 } as const;

export interface NotifyEnvelope {
  v: { major: number; minor: number };
  /** Stable id so a receiver can dedupe across retries or overlapping transports. */
  id: string;
  ts: number;
  kind: NotifyKind;
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
  kind: NotifyKind;
  reason: string;
  sessionId: string;
  agentId: string;
  cwd: string;
  now?: number;
  id?: string;
  host?: string;
  user?: string;
}

export function buildEnvelope(input: BuildEnvelopeInput): NotifyEnvelope {
  const repo = basename(input.cwd) || "unknown";
  const host = input.host ?? hostname();
  const shortSession = input.sessionId.slice(0, 8);

  return {
    v: ENVELOPE_VERSION,
    id: input.id ?? randomUUID(),
    ts: input.now ?? Date.now(),
    kind: input.kind,
    reason: input.reason,
    origin: { host, user: input.user ?? safeUser() },
    session: { sessionId: input.sessionId, agentId: input.agentId, repo },
    title: input.kind === "blocked" ? "clide — needs your input" : `clide — ${input.kind}`,
    // The human-readable line that matters when several machines are pinging you.
    body: `${host} · ${repo} · ${shortSession} · ${input.reason}`,
  };
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
