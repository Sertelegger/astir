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

import type { Registry } from "../model/registry.js";
import type { RemoteSession } from "../status/types.js";
import { sameHost } from "./envelope.js";

/** A roster is a handful of small records; anything larger is a bug. */
export const MAX_ROSTER_SESSIONS = 200;
/** More blocked agents than this in one session is a bug, not a workload. */
export const MAX_BLOCKED_PER_SESSION = 64;

export interface RosterPayload {
  host: string;
  /**
   * #98 — this daemon names every agent blocked on its machine in its
   * sessions' `blocked`, so one it does not name is not blocked there, and
   * the notifier retires it. Sent on every roster, an empty one too. Absent
   * from a daemon older than #98, whose rosters say nothing about blocks.
   */
  namesBlocked?: true;
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
    /**
     * #98 — the agents in this session blocked now, announced and not
     * dismissed there, by id. The notifier lists exactly these for this
     * machine (`RemoteView.confirm`): from one roster to the next, not from
     * one reminder to the next, which may be an hour apart or never. Absent
     * when none is blocked, and from a daemon older than #98.
     */
    blocked?: string[];
    /**
     * #98 — how long each agent in `blocked` has been blocked, in the same
     * order, as of when the roster was built. A duration rather than a time,
     * since the two machines' clocks need not agree. Absent, the notifier
     * counts the wait from when it first heard.
     */
    blockedForMs?: number[];
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
    const { blocked, blockedForMs } = validateBlocked(s.blocked, s.blockedForMs);
    sessions.push({
      sessionId: s.sessionId,
      cwd: s.cwd,
      name: typeof s.name === "string" ? s.name : null,
      status: typeof s.status === "string" ? s.status : null,
      ...(typeof s.attended === "boolean" ? { attended: s.attended } : {}),
      ...(blocked.length > 0 ? { blocked } : {}),
      ...(blockedForMs !== undefined && blocked.length > 0 ? { blockedForMs } : {}),
    });
  }
  return {
    ok: true,
    roster: { host: b.host, ...(b.namesBlocked === true ? { namesBlocked: true as const } : {}), sessions },
  };
}

/**
 * A session's `blocked` ids, and their `blockedForMs` when every one has a
 * duration that is one. Anything that is not an id is dropped with its
 * duration, like a malformed session, and the list is bounded rather than
 * refused. A duration list that does not line up with the ids is not
 * believed at all: the wait is then counted from when the notifier heard.
 */
function validateBlocked(rawIds: unknown, rawForMs: unknown): { blocked: string[]; blockedForMs?: number[] } {
  if (!Array.isArray(rawIds)) return { blocked: [] };
  const durations = Array.isArray(rawForMs) && rawForMs.length === rawIds.length ? rawForMs : null;
  const blocked: string[] = [];
  const forMs: number[] = [];
  let believed = durations !== null;
  for (const [i, id] of rawIds.entries()) {
    if (typeof id !== "string") continue;
    if (blocked.length >= MAX_BLOCKED_PER_SESSION) break;
    blocked.push(id);
    const ms: unknown = durations?.[i];
    if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) forMs.push(ms);
    else believed = false;
  }
  return believed ? { blocked, blockedForMs: forMs } : { blocked };
}

/**
 * The roster this machine pushes: every session it runs, heard or not, and in
 * each the agents blocked now, with how long each has been.
 *
 * Blocked means what the notify loop has announced (`blockedAgents` with an
 * `announcedAt`), which is what the far end lists. A block still inside its
 * dwell (PSH-16) is left out: it may yet clear itself, and a surface that
 * listed it would flash what was never announced. So is an agent dismissed
 * here, since dismissing retires its block and sends the notifier its
 * `resolved`.
 */
export function rosterOf(
  registry: Pick<Registry, "list" | "silent" | "blockedAgents">,
  host: string,
): RosterPayload {
  const blocked = new Map<string, { ids: string[]; forMs: number[] }>();
  for (const b of registry.blockedAgents()) {
    if (b.announcedAt === null) continue;
    const named = blocked.get(b.sessionId) ?? { ids: [], forMs: [] };
    if (named.ids.length < MAX_BLOCKED_PER_SESSION) {
      named.ids.push(b.agentId);
      named.forMs.push(b.blockedForMs);
    }
    blocked.set(b.sessionId, named);
  }
  const sessions: RosterPayload["sessions"] = [
    ...registry.list().map((r) => {
      const named = blocked.get(r.sessionId);
      return {
        sessionId: r.sessionId,
        cwd: r.cwd,
        name: r.name,
        status: r.status,
        ...(r.attended === undefined ? {} : { attended: r.attended }),
        ...(named === undefined ? {} : { blocked: named.ids, blockedForMs: named.forMs }),
      };
    }),
    // Sessions we cannot hear are still running here, and the far end has no
    // other way to learn they exist. Nothing of theirs can be blocked: no
    // event of theirs has arrived to say so.
    ...registry.silent().map((d) => ({
      sessionId: d.sessionId,
      cwd: d.cwd,
      name: d.name,
      status: d.status,
      ...(d.attended === undefined ? {} : { attended: d.attended }),
    })),
  ];
  return { host, namesBlocked: true, sessions };
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

/**
 * DMN-10, read side — drop the sessions this machine pushed itself.
 *
 * The notifier already refuses a roster whose origin is its own host, and that
 * check is correct, but it only protects a notifier from the daemon beside it.
 * It cannot protect a daemon from a notifier, and over `ssh -R` that is exactly
 * the shape: a daemon forwards its roster to a notifier on another machine —
 * which accepts it, rightly, because from there it IS remote — and then polls
 * that same notifier on 127.0.0.1 and reads its own sessions back. Every local
 * session then appears a second time under "Other machines", attributed to the
 * very box displaying it.
 *
 * Only the pushing machine sees this. A notifier's own daemon polls a roster
 * that never contained its sessions, so its view is right and the fault looks
 * like it belongs to the other end.
 *
 * Compared on the first label, and case-insensitively, because the two ends do
 * not agree on how a host is spelled: `hostname()` may return a FQDN on one and
 * a short name on the other, and a comparison that misses is invisible — it
 * fails open, restoring precisely the duplication this exists to remove.
 */
export function dropSelfSessions(sessions: readonly RemoteSession[], selfHost: string): RemoteSession[] {
  return sessions.filter((s) => !sameHost(s.host, selfHost));
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
