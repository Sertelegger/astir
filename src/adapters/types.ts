/**
 * The seam every provider adapter is written against.
 *
 * These types lived inside the Claude adapter, which made "the only
 * Claude-specific code" a claim about a file rather than a boundary — a second
 * provider would have had to import from `adapters/claude/` to say anything at
 * all. Moving them here is a type extraction, not a refactor:
 * `normalizeClaudeHook` already matches `Normalizer` exactly.
 */

import type { AstirEvent } from "../contract/event.js";

/** CAP-05 route 1: a subagent sidecar, or null when absent. */
export interface SidecarMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
  parentAgentId?: string;
}

export interface NormalizeDeps {
  now: () => number;
  newId: () => string;
  realpath: (p: string) => string;
  readSidecar: (sessionId: string, agentId: string) => SidecarMeta | null;
}

export interface NormalizeResult {
  event: AstirEvent | null;
  /**
   * OBS-01/VIEW-06 — paths rejected by CAP-04 (outside the repo, unresolvable).
   * Dropping silently is how a monitoring tool ends up lying by omission, so the
   * count travels with the result and the caller is expected to surface it.
   */
  droppedPaths: number;
  /**
   * The session this payload claims to belong to, even when it never became a
   * valid event.
   *
   * The daemon used to read `payload.session_id` itself, which is a Claude
   * field name — so the "provider-agnostic" ingest tail was reading one
   * provider's wire format. Losing this attribution is how a gap ends up
   * counted daemon-wide, and a daemon-wide count shown against one session
   * warns about work that session never lost.
   */
  claimedSessionId: string | null;
  /**
   * The working directory the payload reports. Empty string when it says none.
   *
   * Same reason as `claimedSessionId`: the tail read `payload.cwd` directly.
   * Only the adapter knows where its provider puts this.
   */
  cwd: string;
}

/**
 * A provider's payload turned into astir's contract.
 *
 * Everything after this is shared: validation, the registry, the counters and
 * the response. A new provider is one of these plus a route.
 */
export type Normalizer = (payload: unknown, deps: NormalizeDeps) => NormalizeResult;
