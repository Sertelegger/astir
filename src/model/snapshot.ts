/**
 * DMN-06 — the one thing that survives the daemon.
 *
 * A restart destroys every agent record: state, parentage, and the
 * active/blocked accounting. `blockedMs` and the blocked flag are what the
 * product exists to report (G1/PSH-01), and unlike the map they cannot rebuild
 * — the event that produced them has already happened and will not happen
 * again. A restart turns "waiting on you for 14 minutes" into silence.
 *
 * AGENT STATE ONLY. The map stays in memory: heat and totals rebuild as work
 * continues, which makes them the larger structure and the cheaper loss. It
 * also keeps a whole class of problem out of this file — `RepoMap` runs on
 * `performance.now()`, which is process-relative and meaningless to a later
 * process, so persisting it would need a timestamp translation these records do
 * not.
 *
 * ## Why this does not need a SEC-01 allowlist
 *
 * SEC-01 forbids reasoning text and tool payloads on disk, and is unamended.
 * This file needs no hand-maintained exclusion list to comply, because astir's
 * IN-MEMORY state already excludes both and that exclusion is asserted —
 * `test/map.test.ts` "retains only paths and counts", `test/notify.test.ts`
 * "has no field that could carry code, arguments or reasoning". A snapshot of
 * that state inherits an enforced invariant rather than a promise.
 *
 * `description` is the one judgement call. It is the subagent's TASK, not its
 * reasoning (`src/contract/event.ts`), and it is the only thing distinguishing
 * eight concurrent `general-purpose` agents from each other — without it a
 * restored rail is unreadable. First field to remove if that judgement is
 * wrong; removing it costs labels and nothing else.
 *
 * ## A hint, never truth
 *
 * Nothing here is trusted on load. A saved session is adopted only when the
 * provider re-confirms it (see `identityMatches`), because the objection
 * persisting state has to answer is that a session may have ENDED while the
 * daemon was down — and reporting work that is not happening is the dishonesty
 * this project is built against.
 */

import type { Provider } from "../contract/event.js";
import type { DiscoveredSession } from "../discovery/sessions.js";

/**
 * VER-01. Unknown MAJOR is refused outright rather than partially read: a
 * half-understood snapshot restores a half-true world, which is worse than
 * restoring nothing.
 */
export const SNAPSHOT_VERSION = { major: 1, minor: 0 } as const;

export interface SnapshotAgent {
  id: string;
  agentType: string | null;
  parentId: string | null;
  parentSource: string | null;
  state: string;
  activeMs: number;
  blockedMs: number;
  turnMs: number;
  stateSince: number;
  lastActivityMs: number;
  lastEventTs: number;
  blockedReason: string | null;
  description: string | null;
  tool: string | null;
  toolPath: string | null;
  acknowledgedAt: number | null;
}

export interface SnapshotSession {
  sessionId: string;
  provider: Provider;
  cwd: string;
  name: string | null;
  /** Identity, checked on restore. Not display data. */
  pid: number | null;
  startedAt: number | null;
  agents: SnapshotAgent[];
}

export interface Snapshot {
  v: { major: number; minor: number };
  /** Epoch ms. How stale the restored state is, and where transcripts resume. */
  writtenAt: number;
  sessions: SnapshotSession[];
}

/**
 * Does the session the provider is reporting have the same identity as the one
 * on disk?
 *
 * All three, and every one earns its place:
 * - `sessionId` alone outlives the process — the id is in a transcript path
 *   long after the session is gone.
 * - `pid` alone is recycled, and on a busy box quickly.
 * - `startedAt` alone is not unique across concurrent sessions.
 *
 * A null on EITHER side of `pid` or `startedAt` fails the check. Absence is not
 * agreement, and adopting on a missing field is how a snapshot ends up
 * resurrecting a session that ended while the daemon was down.
 */
export function identityMatches(saved: SnapshotSession, found: DiscoveredSession): boolean {
  if (saved.sessionId !== found.sessionId) return false;
  if (saved.pid === null || found.pid === null || saved.pid !== found.pid) return false;
  if (saved.startedAt === null || found.startedAt === null) return false;
  return saved.startedAt === found.startedAt;
}

/**
 * Read a snapshot off disk, or null.
 *
 * Deliberately total and deliberately silent about WHY it failed: every failure
 * here has the same correct response, which is to carry on with nothing. A
 * daemon that will not start because its recovery file is corrupt has turned a
 * convenience into an outage.
 */
export function parseSnapshot(raw: unknown): Snapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const v = o.v as { major?: unknown; minor?: unknown } | undefined;
  if (typeof v?.major !== "number" || v.major !== SNAPSHOT_VERSION.major) return null;
  if (typeof o.writtenAt !== "number" || !Number.isFinite(o.writtenAt)) return null;
  if (!Array.isArray(o.sessions)) return null;

  const sessions: SnapshotSession[] = [];
  for (const entry of o.sessions) {
    const s = entry as Record<string, unknown>;
    if (typeof s?.sessionId !== "string" || typeof s.cwd !== "string") continue;
    if (s.provider !== "claude" && s.provider !== "codex") continue;
    if (!Array.isArray(s.agents)) continue;
    sessions.push({
      sessionId: s.sessionId,
      provider: s.provider,
      cwd: s.cwd,
      name: typeof s.name === "string" ? s.name : null,
      pid: typeof s.pid === "number" ? s.pid : null,
      startedAt: typeof s.startedAt === "number" ? s.startedAt : null,
      agents: s.agents.flatMap((a) => {
        const g = a as Record<string, unknown>;
        if (typeof g?.id !== "string" || typeof g.state !== "string") return [];
        const num = (k: string): number => (typeof g[k] === "number" ? (g[k] as number) : 0);
        const str = (k: string): string | null => (typeof g[k] === "string" ? (g[k] as string) : null);
        return [
          {
            id: g.id,
            state: g.state,
            agentType: str("agentType"),
            parentId: str("parentId"),
            parentSource: str("parentSource"),
            activeMs: num("activeMs"),
            blockedMs: num("blockedMs"),
            turnMs: num("turnMs"),
            stateSince: num("stateSince"),
            lastActivityMs: num("lastActivityMs"),
            lastEventTs: num("lastEventTs"),
            blockedReason: str("blockedReason"),
            description: str("description"),
            tool: str("tool"),
            toolPath: str("toolPath"),
            acknowledgedAt: typeof g.acknowledgedAt === "number" ? g.acknowledgedAt : null,
          },
        ];
      }),
    });
  }
  return {
    v: { major: v.major, minor: typeof v.minor === "number" ? v.minor : 0 },
    writtenAt: o.writtenAt,
    sessions,
  };
}
