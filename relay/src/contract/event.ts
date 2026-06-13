import { CONTRACT_VERSION, type Kind, type Op, type Provider } from "./types.js";

export interface ClideEvent {
  v: number;
  eventId: string;
  provider: Provider;
  sessionId: string;
  ts: number;
  kind: Kind;
  agentId: string;
  agentType?: string | null;
  tool?: string | null;
  paths: string[];
  op: Op | null;
  ok?: boolean;
  linesChanged?: number;
  parentInferred?: boolean;
}

const KINDS = new Set<Kind>([
  "session_start", "pre_tool", "post_tool",
  "subagent_start", "subagent_stop", "stop", "session_end",
]);
const PROVIDERS = new Set<Provider>(["claude", "codex"]);
const OPS = new Set<Op>(["read", "write", "edit", "other"]);

export type ValidateResult =
  | { ok: true; event: ClideEvent }
  | { ok: false; error: string };

export function validateEvent(raw: unknown): ValidateResult {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "not an object" };
  const r = raw as Record<string, unknown>;
  if (r.v !== CONTRACT_VERSION) return { ok: false, error: `unsupported v: ${String(r.v)}` };
  for (const f of ["eventId", "sessionId", "agentId"] as const) {
    if (typeof r[f] !== "string" || r[f] === "") return { ok: false, error: `missing ${f}` };
  }
  if (typeof r.ts !== "number") return { ok: false, error: "missing ts" };
  if (!PROVIDERS.has(r.provider as Provider)) return { ok: false, error: "bad provider" };
  if (!KINDS.has(r.kind as Kind)) return { ok: false, error: "bad kind" };
  const op = r.op == null ? null : r.op;
  if (op !== null && !OPS.has(op as Op)) return { ok: false, error: "bad op" };
  const paths = Array.isArray(r.paths) ? (r.paths as unknown[]).filter((p) => typeof p === "string") as string[] : [];
  const event: ClideEvent = {
    v: CONTRACT_VERSION,
    eventId: r.eventId as string,
    provider: r.provider as Provider,
    sessionId: r.sessionId as string,
    ts: r.ts as number,
    kind: r.kind as Kind,
    agentId: r.agentId as string,
    agentType: (r.agentType as string | undefined) ?? null,
    tool: (r.tool as string | undefined) ?? null,
    paths,
    op: op as Op | null,
    ok: typeof r.ok === "boolean" ? r.ok : undefined,
    linesChanged: typeof r.linesChanged === "number" ? r.linesChanged : undefined,
    parentInferred: typeof r.parentInferred === "boolean" ? r.parentInferred : undefined,
  };
  return { ok: true, event };
}
