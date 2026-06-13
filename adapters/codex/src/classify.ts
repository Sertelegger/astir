import type { Op } from "./contract.js";

const PATCH_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

function patchPaths(input: unknown): string[] {
  if (typeof input !== "object" || input === null) return [];
  const o = input as Record<string, unknown>;
  const out: string[] = [];
  // explicit keys
  for (const k of ["file_path", "path"]) { const v = o[k]; if (typeof v === "string" && v) out.push(v); }
  if (Array.isArray(o.changes)) for (const c of o.changes) { const p = (c as Record<string, unknown>)?.path; if (typeof p === "string" && p) out.push(p); }
  // patch text (apply_patch): parse "*** Update File: <path>" headers
  const patch = typeof o.input === "string" ? o.input : typeof o.patch === "string" ? o.patch : "";
  let m: RegExpExecArray | null;
  PATCH_HEADER.lastIndex = 0;
  while ((m = PATCH_HEADER.exec(patch)) !== null) out.push(m[1]!.trim());
  return [...new Set(out)];
}

/** Codex tool → heat op + paths (REQ-005, OV6 fallback). apply_patch→edit; shell→other (reads are fuzzy). */
export function classifyCodexTool(toolName: string, toolInput: unknown): { op: Op; rawPaths: string[] } {
  if (toolName === "apply_patch") return { op: "edit", rawPaths: patchPaths(toolInput) };
  return { op: "other", rawPaths: [] };
}
