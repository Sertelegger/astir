/**
 * DMN-05 — session discovery.
 *
 * `claude agents --json` reports every live session with pid, cwd, id and status.
 * Using it replaces what v1 built as an entire subsystem: discovery files with
 * 0600/0700 handling, a `/healthz` liveness probe, pid polling, orphan reaping,
 * and a `doctor --clean` to sweep up after all of it.
 */

import { execFile } from "node:child_process";

export interface DiscoveredSession {
  sessionId: string;
  cwd: string;
  pid: number | null;
  /** `status` for attached sessions, `state` for background ones. */
  status: string | null;
  name: string | null;
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
    });
  }
  return out;
}

/**
 * Shell out to the provider CLI. Never throws: a missing `claude` binary, a slow
 * invocation, or malformed output all degrade to "I know of no sessions", which
 * the caller treats as "don't prune anything" rather than "everything is dead".
 */
export function createClaudeLister(timeoutMs = 5_000): SessionLister {
  return () =>
    new Promise<DiscoveredSession[] | null>((resolve) => {
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
}
