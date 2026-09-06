/**
 * CAP-02/03/05 — Claude Code hook payload → §10.1 event.
 *
 * The only place Claude's WIRE FORMAT is understood. It is not the only file
 * that mentions Claude — discovery shells out to `claude agents --json`, the
 * installer writes Claude's settings, and the sidecar reader knows its layout —
 * so the older claim that this was "the only Claude-specific code" set a
 * misleading expectation for anyone adding a second provider.
 */

import { randomUUID } from "node:crypto";
import type { NormalizeDeps, NormalizeResult } from "../types.js";

export type { NormalizeDeps, NormalizeResult, SidecarMeta } from "../types.js";

import { homedir } from "node:os";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import {
  CONTRACT_VERSION,
  type Kind,
  type NotificationKind,
  type Op,
  type ParentSource,
} from "../../contract/event.js";

/**
 * A3a — the spawn tool is `Agent` on current builds and `Task` upstream.
 * Matching only one silently resolves nothing.
 */
export const SPAWN_TOOLS = new Set(["Agent", "Task"]);

const KIND_BY_HOOK: Record<string, Kind> = {
  SessionStart: "session_start",
  PreToolUse: "pre_tool",
  PostToolUse: "post_tool",
  PostToolUseFailure: "tool_failed",
  Notification: "notification",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  FileChanged: "file_changed",
  Stop: "stop",
  SessionEnd: "session_end",
};

/** CAP-03 — normative tool→op table. Unknown tools are `other`, never dropped. */
const EDIT = new Set(["Edit", "MultiEdit", "NotebookEdit"]);
const WRITE = new Set(["Write"]);
const READ = new Set(["Read", "Glob", "Grep", "NotebookRead"]);

const NOTIFICATION_KINDS = new Set<string>([
  "permission_prompt",
  "agent_needs_input",
  "worker_permission_prompt",
  "idle_prompt",
  "agent_completed",
]);

/** Path keys Claude uses across its file tools. */
const PATH_KEYS = ["file_path", "notebook_path", "path"] as const;

export function classifyTool(tool: string, input: unknown): { op: Op; rawPaths: string[] } {
  const rawPaths: string[] = [];
  if (typeof input === "object" && input !== null) {
    const o = input as Record<string, unknown>;
    for (const k of PATH_KEYS) {
      const v = o[k];
      if (typeof v === "string" && v.length > 0) rawPaths.push(v);
    }
  }
  if (EDIT.has(tool)) return { op: "edit", rawPaths };
  if (WRITE.has(tool)) return { op: "write", rawPaths };
  if (READ.has(tool)) return { op: "read", rawPaths };
  // CAP-03: keep any paths we found even for `other` — MCP filesystem tools carry
  // real paths and v1 threw them away.
  return { op: "other", rawPaths };
}

/**
 * CAP-04 — repo-relative, posix-normalized, resolved once at the boundary.
 * Returns null for anything that escapes the root; callers count the drop.
 */
export function toRepoRelative(cwd: string, raw: string, realpath: (p: string) => string): string | null {
  if (raw.length === 0) return null;
  let abs = raw.startsWith("~") ? resolve(homedir(), raw.slice(1).replace(/^[/\\]/, "")) : raw;
  if (!isAbsolute(abs)) abs = resolve(cwd, abs);
  // Resolve symlinks so a linked repo root does not produce `../..` paths that the
  // model then silently drops. Falls back to the literal path when the file does
  // not exist yet, which is the normal case for a Write.
  const realCwd = realpath(cwd);
  const realAbs = realpath(abs);
  const rel = relative(realCwd, realAbs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join(posix.sep);
}

/**
 * CAP-05 — deterministic parentage.
 *
 * `parentAgentId` is present exactly when `spawnDepth >= 2`; its ABSENCE is not
 * missing data, it means "parent is the main session". So a sidecar with a
 * spawnDepth is always an exact answer. Only a missing sidecar is a guess.
 */
export function resolveParent(
  sessionId: string,
  agentId: string,
  readSidecar: NormalizeDeps["readSidecar"],
): { parentAgentId: string | null; parentSource: ParentSource } {
  const meta = readSidecar(sessionId, agentId);
  if (meta && (meta.parentAgentId !== undefined || meta.spawnDepth !== undefined)) {
    return { parentAgentId: meta.parentAgentId ?? null, parentSource: "sidecar" };
  }
  if (meta?.toolUseId !== undefined) {
    // Route 2 (pre-2.1.208 sidecars) needs a tool_use → owner index, which the
    // daemon builds as it ingests. Until that lands, be honest rather than wrong.
    return { parentAgentId: null, parentSource: "inferred" };
  }
  return { parentAgentId: null, parentSource: "inferred" };
}

export function normalizeClaudeHook(payload: unknown, deps: NormalizeDeps): NormalizeResult {
  let droppedPaths = 0;
  // Read before anything can fail. `session_id` and `cwd` are Claude's field
  // names, and the daemon used to reach into the raw payload for both — which
  // made its "provider-agnostic" tail depend on one provider's wire format.
  // They travel with the result now: a gap can still be attributed to a session
  // whose payload never became a valid event, which is precisely the case where
  // losing the attribution turns a per-session count into a daemon-wide one.
  const raw = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
  const claimedSessionId = typeof raw?.session_id === "string" ? raw.session_id : null;
  const cwd = typeof raw?.cwd === "string" ? raw.cwd : "";
  const nothing = (): NormalizeResult => ({ event: null, droppedPaths, claimedSessionId, cwd });

  if (raw === null) return nothing();
  const p = raw;

  const sessionId = p.session_id;
  const hookName = p.hook_event_name;
  if (typeof sessionId !== "string" || typeof hookName !== "string") return nothing();

  const kind = KIND_BY_HOOK[hookName];
  if (kind === undefined) return nothing(); // deliberately unmapped, e.g. PreCompact

  const agentIdField = typeof p.agent_id === "string" ? p.agent_id : null;
  const agentId = agentIdField ?? sessionId; // main agent's id IS the session id
  const agentType = typeof p.agent_type === "string" ? p.agent_type : null;

  let op: Op | null = null;
  let paths: string[] = [];
  let tool: string | null = null;
  let ok: boolean | null = null;

  if (kind === "pre_tool" || kind === "post_tool" || kind === "tool_failed") {
    tool = typeof p.tool_name === "string" ? p.tool_name : null;
    const c = classifyTool(tool ?? "", p.tool_input);
    op = c.op;
    if (cwd) {
      for (const rp of c.rawPaths) {
        const rel = toRepoRelative(cwd, rp, deps.realpath);
        if (rel === null) droppedPaths++;
        else paths.push(rel);
      }
    }
    // A2: the result field is `tool_output`. A failure arrives as its own event
    // kind rather than as ok:false, so `ok` is derivable rather than guessed.
    ok = kind === "tool_failed" ? false : kind === "post_tool" ? true : null;
  }

  if (kind === "file_changed") {
    const fp = typeof p.file_path === "string" ? p.file_path : null;
    if (fp !== null && cwd) {
      const rel = toRepoRelative(cwd, fp, deps.realpath);
      if (rel === null) droppedPaths++;
      else paths = [rel];
    }
    // FileChanged is how shell-driven writes become visible at all.
    op = "edit";
  }

  let notificationKind: NotificationKind | null = null;
  if (kind === "notification") {
    const nt = typeof p.notification_type === "string" ? p.notification_type : "";
    notificationKind = NOTIFICATION_KINDS.has(nt) ? (nt as NotificationKind) : "other";
  }

  let parentAgentId: string | null = null;
  let parentSource: ParentSource | null = null;
  let description: string | null = null;
  if (kind === "subagent_start") {
    // Read once and reuse: parentage and the task description come out of the
    // same tiny file, and it is the only disk touch on the hook path.
    const meta = deps.readSidecar(sessionId, agentId);
    const resolved = resolveParent(sessionId, agentId, () => meta);
    parentAgentId = resolved.parentAgentId;
    parentSource = resolved.parentSource;
    // The brief the spawning side wrote — "Extract chunk 5 social preview svg".
    // Present on every sidecar observed, and the only thing that distinguishes
    // eight concurrent `general-purpose` agents from each other.
    description = typeof meta?.description === "string" ? meta.description : null;
  }

  return {
    droppedPaths,
    claimedSessionId,
    cwd,
    event: {
      v: CONTRACT_VERSION,
      eventId: deps.newId(),
      provider: "claude",
      sessionId,
      ts: deps.now(),
      kind,
      agentId,
      agentType,
      parentAgentId,
      parentSource,
      tool,
      description,
      paths,
      op,
      ok,
      notificationKind,
    },
  };
}

export function defaultNewId(): string {
  return randomUUID();
}
