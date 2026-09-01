/**
 * DMN-10 (option 3) — a remote daemon announces what it is running, not just
 * what is blocked.
 *
 * The doorbell path (PSH-06) only ever said "an agent over here needs you". That
 * is the urgent case, but it leaves the ordinary one invisible: a session on
 * another machine that is working fine does not exist as far as this menu bar is
 * concerned, so a quiet remote machine and an unreachable one look identical.
 *
 * A roster is the same tunnel carrying the boring news. It is a full snapshot
 * rather than a diff — a roster is small, the transport can drop messages
 * without anyone noticing, and reconciling diffs across a tunnel that comes and
 * goes with an SSH connection would be a source of permanent drift for no gain.
 *
 * Where the SSH poll (DMN-09) reaches out from here, this is pushed from there,
 * and the two overlap deliberately: the push knows more and arrives sooner, the
 * poll needs nothing installed remotely. Whichever is available wins.
 */

import type { RemoteSession } from "../status/types.js";

/** A roster is a handful of small records; anything larger is a bug. */
export const MAX_ROSTER_SESSIONS = 200;

export interface RosterPayload {
  host: string;
  sessions: Array<{
    sessionId: string;
    cwd: string;
    name: string | null;
    status: string | null;
    /**
     * DMN-11. Only the machine running the session can see whether it has a
     * controlling terminal, so classification travels with the roster — this is
     * the one route by which a remote background session can be recognised.
     */
    attended?: boolean;
  }>;
}

export function validateRoster(
  body: unknown,
): { ok: true; roster: RosterPayload } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "not an object" };
  const b = body as Record<string, unknown>;
  if (typeof b.host !== "string" || b.host.length === 0) return { ok: false, error: "host required" };
  if (!Array.isArray(b.sessions)) return { ok: false, error: "sessions required" };
  if (b.sessions.length > MAX_ROSTER_SESSIONS) return { ok: false, error: "too many sessions" };

  const sessions: RosterPayload["sessions"] = [];
  for (const raw of b.sessions) {
    if (typeof raw !== "object" || raw === null) continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.sessionId !== "string" || typeof s.cwd !== "string") continue;
    sessions.push({
      sessionId: s.sessionId,
      cwd: s.cwd,
      name: typeof s.name === "string" ? s.name : null,
      status: typeof s.status === "string" ? s.status : null,
      ...(typeof s.attended === "boolean" ? { attended: s.attended } : {}),
    });
  }
  return { ok: true, roster: { host: b.host, sessions } };
}

/** Matches the SSH poller's, so the two age out of the view identically. */
export const ROSTER_STALE_AFTER_MS = 90_000;
export const ROSTER_FORGET_AFTER_MS = 15 * 60_000;

/**
 * Rosters, by host.
 *
 * Keyed by host rather than accumulated, so a machine that stops running
 * anything reports an empty roster and its sessions disappear — a store that
 * only ever added would leave finished sessions on screen forever.
 */
export class RosterStore {
  private readonly hosts = new Map<string, { sessions: RemoteSession[]; lastSeen: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  apply(roster: RosterPayload): void {
    const now = this.now();
    this.hosts.set(roster.host, {
      lastSeen: now,
      sessions: roster.sessions.map((s) => ({
        host: roster.host,
        sessionId: s.sessionId,
        cwd: s.cwd,
        name: s.name,
        status: s.status,
        source: "push" as const,
        ...(s.attended === undefined ? {} : { attended: s.attended }),
        lastSeen: now,
      })),
    });
  }

  list(): RemoteSession[] {
    const now = this.now();
    const out: RemoteSession[] = [];
    for (const [host, entry] of [...this.hosts]) {
      const age = now - entry.lastSeen;
      if (age >= ROSTER_FORGET_AFTER_MS) {
        this.hosts.delete(host);
        continue;
      }
      const stale = age >= ROSTER_STALE_AFTER_MS;
      for (const s of entry.sessions) out.push(stale ? { ...s, stale: true } : s);
    }
    return out;
  }
}

/**
 * One list from both routes, push winning.
 *
 * A machine running a astir daemon AND reachable over SSH reports the same
 * session twice, and rendering it twice is exactly the duplicate-row problem
 * that made the local view untrustworthy. The push wins because it comes from
 * the daemon that is actually watching the session rather than from a poll of
 * whatever discovery happened to report a moment ago.
 */
export function mergeRemoteSessions(pushed: RemoteSession[], polled: RemoteSession[]): RemoteSession[] {
  const byId = new Map<string, RemoteSession>();
  for (const s of polled) byId.set(s.sessionId, s);
  for (const s of pushed) {
    const alreadyPolled = byId.get(s.sessionId);
    // The push wins on STATE — it comes from the daemon actually watching the
    // session — but the poll wins on NAME. The two routes label the same
    // machine differently: a poll carries the ssh alias the user configured
    // (`megabrain-dev`), a push carries whatever the box calls itself
    // (`claude-dev-geeklish`). The alias is the name they chose and the one
    // `astir watch` takes; the hostname was assigned to it.
    byId.set(s.sessionId, alreadyPolled === undefined ? s : { ...s, host: alreadyPolled.host });
  }
  return [...byId.values()];
}

/** The notifier advertises `.../notify`; its roster route sits beside it. */
export function rosterUrlFrom(notifyUrl: string): string {
  return notifyUrl.replace(/\/notify\/?$/, "/roster");
}

export interface PushRosterResult {
  ok: boolean;
  reason?: string;
}

/**
 * Announce this machine's sessions to a notifier.
 *
 * Failure is returned rather than thrown and is never fatal: the tunnel this
 * travels through comes and goes with an SSH connection, so a push failing is
 * the normal state of affairs half the time, not an error worth interrupting a
 * daemon for.
 */
export async function pushRoster(
  url: string,
  token: string,
  roster: RosterPayload,
  timeoutMs = 5_000,
): Promise<PushRosterResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(roster),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) return { ok: false, reason: "unauthorized" };
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}
