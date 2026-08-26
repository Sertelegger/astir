/** §10.1 — the normalized event contract. The one seam every provider crosses. */

export type Provider = "claude" | "codex";
export type Op = "read" | "write" | "edit" | "other";

export type Kind =
  | "session_start"
  | "pre_tool"
  | "post_tool"
  | "tool_failed"
  | "notification"
  | "subagent_start"
  | "subagent_stop"
  | "file_changed"
  | "stop"
  | "session_end";

/** How CAP-05 resolved this agent's parent. `inferred` means "we guessed". */
export type ParentSource = "sidecar" | "tooluse" | "inferred";

/** Claude's Notification matcher values. The first three mean "come look". */
export type NotificationKind =
  | "permission_prompt"
  | "agent_needs_input"
  | "worker_permission_prompt"
  | "idle_prompt"
  | "agent_completed"
  | "other";

export interface ContractVersion {
  major: number;
  minor: number;
}

/** VER-01: every event and frame carries {major,minor}. */
export const CONTRACT_VERSION: ContractVersion = { major: 2, minor: 0 };

export interface AstirEvent {
  v: ContractVersion;
  eventId: string;
  provider: Provider;
  sessionId: string;
  ts: number;
  kind: Kind;
  agentId: string;
  agentType: string | null;
  parentAgentId: string | null;
  parentSource: ParentSource | null;
  tool: string | null;
  paths: string[];
  op: Op | null;
  ok: boolean | null;
  notificationKind: NotificationKind | null;
}

/** DMN-03 bounds. Exceeding any of these is a rejection, never a silent clamp. */
export const LIMITS = {
  maxPaths: 256,
  maxPathLength: 1024,
  maxPathSegments: 64,
  maxStringLength: 4096,
  /** Sanity window for `ts`, in seconds: 2000-01-01 .. 2100-01-01. */
  minTs: 946_684_800,
  maxTs: 4_102_444_800,
} as const;

export type ValidateResult = { ok: true; event: AstirEvent } | { ok: false; error: string };

const KINDS = new Set<string>([
  "session_start",
  "pre_tool",
  "post_tool",
  "tool_failed",
  "notification",
  "subagent_start",
  "subagent_stop",
  "file_changed",
  "stop",
  "session_end",
]);
const PROVIDERS = new Set<string>(["claude", "codex"]);
const OPS = new Set<string>(["read", "write", "edit", "other"]);

function isSaneString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= LIMITS.maxStringLength;
}

/**
 * MOD-07 — validate before anything touches the model.
 *
 * v1 accepted `Infinity` for `ts`, which permanently froze an agent because every
 * later event then failed the staleness comparison. Hence the explicit finite +
 * range check rather than `typeof === "number"`.
 */
export function validateEvent(raw: unknown): ValidateResult {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "not an object" };
  const r = raw as Record<string, unknown>;

  const v = r.v as ContractVersion | undefined;
  if (!v || typeof v.major !== "number") return { ok: false, error: "missing contract version" };
  if (v.major !== CONTRACT_VERSION.major) {
    return { ok: false, error: `unsupported contract major: ${String(v.major)}` };
  }

  for (const f of ["eventId", "sessionId", "agentId"] as const) {
    if (!isSaneString(r[f])) return { ok: false, error: `missing or oversized ${f}` };
  }

  const ts = r.ts;
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts < LIMITS.minTs || ts > LIMITS.maxTs) {
    return { ok: false, error: "ts must be finite seconds within a sane range" };
  }

  if (!PROVIDERS.has(r.provider as string)) return { ok: false, error: "bad provider" };
  if (!KINDS.has(r.kind as string)) return { ok: false, error: "bad kind" };

  const op = r.op == null ? null : (r.op as string);
  if (op !== null && !OPS.has(op)) return { ok: false, error: "bad op" };

  const rawPaths = r.paths;
  if (rawPaths !== undefined && !Array.isArray(rawPaths)) return { ok: false, error: "paths not an array" };
  const pathArr = (rawPaths ?? []) as unknown[];
  if (pathArr.length > LIMITS.maxPaths) return { ok: false, error: "too many paths" };
  const paths: string[] = [];
  for (const p of pathArr) {
    if (typeof p !== "string") return { ok: false, error: "non-string path" };
    if (p.length > LIMITS.maxPathLength) return { ok: false, error: "path too long" };
    if (p.split("/").length > LIMITS.maxPathSegments) return { ok: false, error: "path too deep" };
    paths.push(p);
  }

  return {
    ok: true,
    event: {
      v: CONTRACT_VERSION,
      eventId: r.eventId as string,
      provider: r.provider as Provider,
      sessionId: r.sessionId as string,
      ts,
      kind: r.kind as Kind,
      agentId: r.agentId as string,
      agentType: typeof r.agentType === "string" ? r.agentType : null,
      parentAgentId: typeof r.parentAgentId === "string" ? r.parentAgentId : null,
      parentSource: (r.parentSource as ParentSource | undefined) ?? null,
      tool: typeof r.tool === "string" ? r.tool : null,
      paths,
      op: op as Op | null,
      ok: typeof r.ok === "boolean" ? r.ok : null,
      notificationKind: (r.notificationKind as NotificationKind | undefined) ?? null,
    },
  };
}
