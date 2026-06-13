import type { Op } from "./contract.js";

const EDIT = new Set(["Edit", "MultiEdit", "NotebookEdit", "Update"]);
const WRITE = new Set(["Write", "Create"]);
const READ = new Set(["Read"]);

function pathsOf(input: unknown): string[] {
  if (typeof input !== "object" || input === null) return [];
  const o = input as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ["file_path", "notebook_path", "path"]) {
    const v = o[key];
    if (typeof v === "string" && v.length > 0) out.push(v);
  }
  return out;
}

/** Map a Claude tool to a heat op + the file paths it references (REQ-005). */
export function classifyTool(toolName: string, toolInput: unknown): { op: Op; rawPaths: string[] } {
  const rawPaths = pathsOf(toolInput);
  if (EDIT.has(toolName)) return { op: "edit", rawPaths };
  if (WRITE.has(toolName)) return { op: "write", rawPaths };
  if (READ.has(toolName)) return { op: "read", rawPaths };
  return { op: "other", rawPaths: [] };
}
