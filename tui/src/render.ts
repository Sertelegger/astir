import type { DirDTO, LeafDTO, AgentRecordDTO } from "./protocol.js";
import { isLeaf } from "./protocol.js";
import { heatBlock, type ColorMode } from "./color.js";

const BAR_WIDTH = 10;
function base(path: string): string { const i = path.lastIndexOf("/"); return i === -1 ? path : path.slice(i + 1); }

function bar(heat: number, maxLeafHeat: number, mode: ColorMode): string {
  const norm = maxLeafHeat > 0 ? Math.min(heat / maxLeafHeat, 1) : 0;
  const filled = Math.round(norm * BAR_WIDTH);
  return heatBlock(norm, mode).repeat(Math.max(0, filled)) || "";
}

/** Indented file tree with heat bars; dirs show rolled-up heat (REQ-061). */
export function renderTree(tree: DirDTO, maxLeafHeat: number, mode: ColorMode): string {
  const lines: string[] = [];
  const walk = (n: DirDTO | LeafDTO, depth: number): void => {
    if (n.path !== "") {
      const indent = "  ".repeat(depth - 1);
      const label = isLeaf(n) ? base(n.path) : `${base(n.path)}/`;
      lines.push(`${indent}${label}  ${bar(n.heat, maxLeafHeat, mode)}`);
    }
    if (!isLeaf(n)) n.children.forEach((c) => walk(c, depth + 1));
  };
  walk(tree, 0);
  return lines.join("\n");
}

function depthOf(a: AgentRecordDTO, byId: Map<string, AgentRecordDTO>): number {
  let d = 0, cur = a; const seen = new Set<string>();
  while (cur.parentId && byId.has(cur.parentId) && !seen.has(cur.id)) { seen.add(cur.id); d++; cur = byId.get(cur.parentId)!; }
  return d;
}

/** Nested agent rail with state + Now line (REQ-061). */
export function renderRail(agents: AgentRecordDTO[]): string {
  const byId = new Map(agents.map((a) => [a.id, a]));
  return agents.map((a) => {
    const indent = "  ".repeat(depthOf(a, byId));
    const name = `${a.name}${a.agentType ? ` · ${a.agentType}` : ""}`;
    return `${indent}● ${name} (${a.state})  Now: ${a.now}`;
  }).join("\n");
}
