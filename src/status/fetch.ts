/** Shared daemon query for the `status` and `menubar` surfaces. */

import { hostname } from "node:os";
import { readTokenIfPresent } from "../config/paths.js";
import { sameHost, shortHost } from "../notify/envelope.js";
import type { HealthBody, RemoteSession, StatusBody, StatusResult } from "./types.js";

/** What a foreign daemon is called when the name it gave is not one fit to print. */
export const UNNAMED_HOST = "another machine";

/** One hostname label, as RFC 1123 has it — plus `_`, which real machines do use. */
const HOST_LABEL = /^[A-Za-z0-9_-]{1,63}$/;

/**
 * The machine a daemon says it runs on, when that is NOT this one; else null.
 *
 * The one host check every surface shares. Absent means "cannot tell" (an older
 * daemon), and refusing on that would break every surface against one — so
 * only a host the daemon actually reported can make it foreign.
 *
 * `reported` is read off a socket, and `/healthz` answers anyone without a
 * token, so it is `unknown` here rather than trusted to be the string the type
 * says. Anything that is not a string is "cannot tell", like absent: a value
 * that crashed this (`123.split`) took the whole `status --line` down with it,
 * and a tmux segment shows a command that printed nothing as calm.
 *
 * The name comes back fit to print, because it goes straight into a tmux
 * status segment (`#[...]` is a style there) and a terminal (escapes), and a
 * newline in it would break the line's "one line or nothing". It is compared
 * RAW, and then printed only if it is already what a hostname label looks
 * like. Anything else is "another machine" rather than a cleaned-up name: a
 * name that needed cleaning was never a hostname, and cleaning `dev#box` would
 * print `devbox` — this machine's own name, on the warning that says the
 * daemon is not this machine's. Still foreign either way: null would mean
 * "mine", and count the impostor's sessions as ours — precisely the lie the
 * check exists to stop.
 */
export function foreignHost(reported: unknown, selfHost: string): string | null {
  if (typeof reported !== "string" || sameHost(reported, selfHost)) return null;
  const name = shortHost(reported);
  return HOST_LABEL.test(name) ? name : UNNAMED_HOST;
}

/**
 * The request's deadline: its own timeout, and the caller's budget when it has
 * one. `status --line` aborts every fetch at once when its budget runs out, so
 * nothing is left holding the process open after the line is printed.
 */
function deadline(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const own = AbortSignal.timeout(timeoutMs);
  if (signal === undefined) return own;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([own, signal]);
  // `AbortSignal.any` arrived in Node 20.3 and `engines` says >=20, so the
  // last few 20.x releases get the same thing by hand.
  const both = new AbortController();
  const stop = (): void => both.abort();
  own.addEventListener("abort", stop, { once: true });
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  return both.signal;
}

/** A deadline passing, as opposed to the connection being refused. */
const timedOut = (err: unknown): boolean => {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
};

/**
 * Never throws. Every failure becomes a `reason` a surface can display, because
 * a silent failure here reads as "nothing is happening" — which is exactly the
 * lie this project exists downstream of. `kind` says the same thing as a value,
 * for a surface that must branch on it rather than print it.
 */
export async function fetchStatus(
  port: number,
  timeoutMs = 3_000,
  /** This machine's name. Injectable for the reason `fetchRemote` documents. */
  selfHost: string = hostname(),
  signal?: AbortSignal,
): Promise<StatusResult> {
  const token = process.env.ASTIR_TOKEN ?? readTokenIfPresent();
  if (token === null) return { ok: false, kind: "no-token", reason: "no token — run `astir install`" };

  try {
    const res = await fetch(`http://127.0.0.1:${port}/state`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: deadline(timeoutMs, signal),
    });
    if (res.status === 401) return { ok: false, kind: "rejected", reason: "token rejected — is it current?" };
    if (!res.ok) return { ok: false, kind: "http", reason: `daemon returned ${res.status}` };
    const body = (await res.json()) as StatusBody;

    // The dangerous case is not an unreachable port — that already reports
    // itself. It is ANOTHER astir daemon answering here, forwarded from the
    // machine you are developing on, whose sessions would be rendered as this
    // machine's. It shares the token `astir pair` copied, so it authenticates
    // cleanly and the reply looks entirely valid.
    const foreign = foreignHost(body.host, selfHost);
    if (foreign !== null) {
      return {
        ok: false,
        kind: "foreign",
        host: foreign,
        // The cleaned name, not `body.host`: this reason is printed too.
        reason: `port ${port} is ${foreign}'s daemon, not this machine's — a forwarded port?`,
      };
    }
    return { ok: true, body };
  } catch (err) {
    // Kept apart from "absent": something that accepted the connection and
    // never answered is not a daemon that is not running, and saying it is
    // would be a guess dressed as a fact.
    if (timedOut(err)) {
      return { ok: false, kind: "timeout", reason: `daemon on 127.0.0.1:${port} did not answer in time` };
    }
    return { ok: false, kind: "absent", reason: `no daemon on 127.0.0.1:${port}` };
  }
}

/**
 * The daemon's `/healthz` — unauthenticated, so it still answers when the token
 * is missing or stale, and the only route that carries `delivery` (#78).
 *
 * Null when nothing usable answered. The caller decides what that means; the
 * host check is `foreignHost`, applied by whoever renders the result.
 */
export async function fetchHealth(
  port: number,
  timeoutMs = 3_000,
  signal?: AbortSignal,
): Promise<HealthBody | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: deadline(timeoutMs, signal) });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return typeof body === "object" && body !== null ? (body as HealthBody) : null;
  } catch {
    return null;
  }
}

/** One blocked agent on another machine, as the local notifier reports it. */
export interface RemoteAgentView {
  host: string;
  repo: string;
  sessionId: string;
  agentId: string;
  reason: string;
  since: number;
  lastSeen: number;
  acknowledged: boolean;
  stale?: boolean;
}

/**
 * PSH-12 — ask the local notifier what other machines are waiting on.
 *
 * Returns `null` when no notifier is running, which is the common case and not
 * an error: without one, there are simply no remote sessions to show.
 */
export async function fetchRemote(
  port: number,
  timeoutMs = 3_000,
  /**
   * This machine's name, for deciding what came from here. Injectable so a test
   * never has to derive a fixture from the real hostname — building one by
   * appending to `hostname()` produces a DIFFERENT host on Linux and the SAME
   * one on macOS, where the name carries a `.local` suffix and the comparison
   * is on the first label.
   */
  selfHost: string = hostname(),
  signal?: AbortSignal,
): Promise<{ agents: RemoteAgentView[]; sessions: RemoteSession[] } | null> {
  const token = process.env.ASTIR_NOTIFY_TOKEN ?? process.env.ASTIR_TOKEN ?? readTokenIfPresent();
  if (token === null) return null;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/state`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: deadline(timeoutMs, signal),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { agents?: RemoteAgentView[]; sessions?: RemoteSession[] };
    // DMN-10 — `sessions` is absent from an older notifier, which is not an
    // error: it simply has nothing but doorbells to report.
    //
    // Anything this machine sent is dropped on the way back in. The notifier
    // refuses a roster from its own host, but that only protects a notifier
    // from the daemon beside it — and over `ssh -R` the notifier is on ANOTHER
    // machine, where our roster is legitimately remote and is stored. Polling
    // it on 127.0.0.1 then returns our own sessions, and every local one is
    // listed a second time under "Other machines" on the box displaying it.
    //
    // Both halves, not just sessions: a doorbell carries an origin host too and
    // is not origin-checked on the way in, so the blocked-agent list reflects
    // by the same route.
    return {
      agents: (body.agents ?? []).filter((a) => !sameHost(a.host, selfHost)),
      sessions: (body.sessions ?? []).filter((s) => !sameHost(s.host, selfHost)),
    };
  } catch {
    return null;
  }
}
