/**
 * DMN-05 — session discovery.
 *
 * `claude agents --json` reports every live session with pid, cwd, id and status.
 * Using it replaces what v1 built as an entire subsystem: discovery files with
 * 0600/0700 handling, a `/healthz` liveness probe, pid polling, orphan reaping,
 * and a `doctor --clean` to sweep up after all of it.
 */

import { execFile } from "node:child_process";
import { createTtyReader, isAttended, type TtyReader } from "./attended.js";
import { candidateConfigDirs } from "./profiles.js";

export interface DiscoveredSession {
  sessionId: string;
  cwd: string;
  pid: number | null;
  /** `status` for attached sessions, `state` for background ones. */
  status: string | null;
  name: string | null;
  /**
   * Epoch ms the session started, when the provider reports it.
   *
   * This is what makes "astir heard nothing from it" interpretable. A session
   * older than the daemon cannot have had its `SessionStart` received, so its
   * silence says nothing about whether its hooks work — and calling that "hooks
   * are not wired, restart it" sends someone to restart a session that was fine.
   */
  startedAt: number | null;
  /**
   * DMN-11 — whether a human is sitting at it. `undefined` means we could not
   * tell, which is treated as attended: hiding a session someone is working in
   * is far worse than listing a background one.
   */
  attended?: boolean;
}

/**
 * `null` means "could not determine" — a missing binary, a timeout, unparseable
 * output. That is deliberately distinct from `[]` ("no sessions are running"),
 * because the caller prunes on the latter and must not prune on the former.
 * Collapsing the two would make a missing `claude` binary look like every session
 * having ended.
 */
export interface DiscoveryResult {
  sessions: DiscoveredSession[];
  /**
   * False when at least one profile could not be listed.
   *
   * The caller must NOT prune on an incomplete view: a profile that failed this
   * tick has sessions that are still running, and treating their absence as
   * death would delete live records. Enrichment from the profiles that DID
   * answer is still applied, because partial truth beats none.
   */
  complete: boolean;
}

export type SessionLister = () => Promise<DiscoveryResult | null>;

interface RawAgent {
  sessionId?: unknown;
  cwd?: unknown;
  pid?: unknown;
  status?: unknown;
  state?: unknown;
  name?: unknown;
  startedAt?: unknown;
}

export function parseAgentsJson(stdout: string): DiscoveredSession[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const out: DiscoveredSession[] = [];
  for (const item of parsed as RawAgent[]) {
    if (typeof item?.sessionId !== "string") continue; // a session with no id is useless to us
    out.push({
      sessionId: item.sessionId,
      cwd: typeof item.cwd === "string" ? item.cwd : "",
      pid: typeof item.pid === "number" ? item.pid : null,
      status:
        typeof item.status === "string" ? item.status : typeof item.state === "string" ? item.state : null,
      name: typeof item.name === "string" ? item.name : null,
      startedAt: typeof item.startedAt === "number" ? item.startedAt : null,
    });
  }
  return out;
}

/**
 * Shell out to the provider CLI. Never throws: a missing `claude` binary, a slow
 * invocation, or malformed output all degrade to "I know of no sessions", which
 * the caller treats as "don't prune anything" rather than "everything is dead".
 */
/** One profile's worth of sessions, or null if that profile could not be listed. */
function listProfile(configDir: string, timeoutMs: number): Promise<DiscoveredSession[] | null> {
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["agents", "--json"],
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        // The whole point: `claude agents --json` answers for exactly one
        // profile, so the profile has to be named rather than inherited.
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(parseAgentsJson(stdout));
      },
    );
  });
}

/**
 * How much evidence a status carries that work is actually happening.
 *
 * Used only to break a tie between two views of ONE process. The asymmetry is
 * the point: **activity is evidence, and its absence is not.** A profile whose
 * registry has gone stale reports what it last knew — it cannot invent work
 * that is not happening — so where two views disagree, the more active one is
 * the one with something behind it.
 *
 * A status this does not recognise ranks ABOVE the calm ones rather than below.
 * We do not know what it means, and astir's rule throughout is that it must
 * never look calmer than it is entitled to; assuming an unfamiliar word is
 * quiet would be exactly that.
 */
const ACTIVITY: Record<string, number> = {
  busy: 3,
  "tool-running": 3,
  thinking: 3,
  waiting: 2,
  idle: 1,
  done: 1,
};

/** Unknown-but-present sits above calm; absent sits below everything. */
function activityOf(status: string | null): number {
  if (status === null) return 0;
  return ACTIVITY[status] ?? 2;
}

/**
 * Collapse records that describe the SAME PROCESS.
 *
 * A pid identifies one, and two live sessions cannot share it — so where two
 * session ids do, they are one session that two profiles each named for
 * themselves. Each profile keeps its own registry and mints its own id, so
 * merging by id cannot see it: the ids never collide.
 *
 * Left alone it doubles every row on every surface, and a machine watching
 * remotely sees the pair arrive by different routes and therefore under
 * different host labels — an ssh alias for one and a hostname for the other —
 * which reads as one session running on two machines.
 *
 * WHICH record survives matters, because hooks POST under exactly one of the
 * ids and enrichment must land on that one, or the surviving row never updates.
 * The id the daemon has already heard from wins. Failing that the earlier
 * profile does, which is `$CLAUDE_CONFIG_DIR`'s: `candidateConfigDirs` orders
 * it first and the caller preserves that order.
 */
export function collapseByPid(
  sessions: readonly DiscoveredSession[],
  known: (sessionId: string) => boolean,
): DiscoveredSession[] {
  const indexByPid = new Map<number, number>();
  const out: DiscoveredSession[] = [];
  for (const session of sessions) {
    if (session.pid === null) {
      // No pid is no evidence. Merging on its absence would fuse two genuine
      // sessions into one row, which is a worse failure than showing an extra.
      out.push(session);
      continue;
    }
    const at = indexByPid.get(session.pid);
    if (at === undefined) {
      indexByPid.set(session.pid, out.length);
      out.push(session);
      continue;
    }
    const incumbent = out[at];
    if (incumbent !== undefined && wins(session, incumbent, known)) {
      out[at] = session;
    }
  }
  return out;
}

/**
 * Whether `candidate` should replace `incumbent` as the row for their process.
 *
 * Two rules, in order.
 *
 * **Heard-from wins.** Hooks POST under exactly one of the ids, so enrichment
 * lands on that one; keep the other and the surviving row is fed by events that
 * never arrive and freezes. This outranks activity deliberately — a heard-from
 * record showing a calmer state corrects itself on the next event, while a
 * livelier record nothing reports to never does.
 *
 * **Then the more active view.** Profile order was the old tie-break and it has
 * nothing to do with which view is current: on a real machine `~/.claude` said
 * a process was `idle` while `~/.claude-nv` said `busy`, and order picked the
 * calmer answer by coin flip. Preferring activity is not a guess — a stale
 * registry cannot report work that is not happening.
 *
 * Equal on both leaves the incumbent, which keeps the earlier profile's id and,
 * more importantly, keeps the answer stable: a row whose id flipped between
 * polls would take every action bound to it along.
 */
function wins(
  candidate: DiscoveredSession,
  incumbent: DiscoveredSession,
  known: (sessionId: string) => boolean,
): boolean {
  const candidateHeard = known(candidate.sessionId);
  const incumbentHeard = known(incumbent.sessionId);
  if (candidateHeard !== incumbentHeard) return candidateHeard;
  return activityOf(candidate.status) > activityOf(incumbent.status);
}

export interface ClaudeListerOpts {
  timeoutMs?: number;
  ttys?: TtyReader;
  profiles?: () => string[];
  /**
   * Whether the daemon has actually received events for a session id.
   *
   * Used to pick a winner when two profiles describe one process — see the
   * collapse below. Defaults to "heard from none", which falls back to profile
   * order and is the right answer before any hook has arrived.
   */
  known?: (sessionId: string) => boolean;
}

export function createClaudeLister(opts: ClaudeListerOpts = {}): SessionLister {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const ttys = opts.ttys ?? createTtyReader();
  const profiles = opts.profiles ?? candidateConfigDirs;
  const known = opts.known ?? (() => false);
  return async () => {
    const dirs = profiles();
    const results = await Promise.all(dirs.map((dir) => listProfile(dir, timeoutMs)));

    // Merged by session id, which catches a profile reached by two paths (a
    // symlink). It does NOT catch the same process seen through two profiles:
    // each keeps its own registry and mints its own id, so the ids never
    // collide. That is what the pid collapse below is for.
    const byId = new Map<string, DiscoveredSession>();
    let complete = true;
    for (const result of results) {
      if (result === null) {
        complete = false;
        continue;
      }
      for (const session of result) byId.set(session.sessionId, session);
    }

    // Every profile failed: that is "could not determine", not "nothing is
    // running", and the caller must not act on it at all.
    if (byId.size === 0 && !complete) return null;

    const listed = collapseByPid([...byId.values()], known);

    // DMN-11 — one `ps` for the whole table, not one per session. A failure
    // here leaves every session unclassified rather than misclassified.
    const table = await ttys().catch(() => new Map<number, string>());
    return {
      complete,
      sessions: listed.map((d) => {
        const attended = isAttended(d.pid, table);
        return attended === undefined ? d : { ...d, attended };
      }),
    };
  };
}
