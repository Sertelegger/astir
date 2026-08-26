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
export type SessionLister = () => Promise<DiscoveredSession[] | null>;

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
export function createClaudeLister(timeoutMs = 5_000, ttys: TtyReader = createTtyReader()): SessionLister {
  return async () => {
    const listed = await new Promise<DiscoveredSession[] | null>((resolve) => {
      execFile(
        "claude",
        ["agents", "--json"],
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return resolve(null);
          resolve(parseAgentsJson(stdout));
        },
      );
    });
    if (listed === null) return null;

    // DMN-11 — one `ps` for the whole table, not one per session. A failure
    // here leaves every session unclassified rather than misclassified.
    const table = await ttys().catch(() => new Map<number, string>());
    return listed.map((d) => {
      const attended = isAttended(d.pid, table);
      return attended === undefined ? d : { ...d, attended };
    });
  };
}
