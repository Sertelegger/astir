import type { AgentRecordDTO } from "./protocol.js";

function depthOf(a: AgentRecordDTO, byId: Map<string, AgentRecordDTO>): number {
  let d = 0; let cur = a; const seen = new Set<string>();
  while (cur.parentId && byId.has(cur.parentId) && !seen.has(cur.id)) { seen.add(cur.id); d++; cur = byId.get(cur.parentId)!; }
  return d;
}

export function renderRail(container: HTMLElement, agents: AgentRecordDTO[]): void {
  container.innerHTML = "";
  const byId = new Map(agents.map((a) => [a.id, a]));
  for (const a of agents) {
    const row = document.createElement("div");
    row.setAttribute("data-agent", a.id);
    if (a.parentId) row.setAttribute("data-parent", a.parentId);
    const depth = depthOf(a, byId);
    if (depth > 0) row.style.marginLeft = `${depth * 14}px`;
    row.style.padding = "4px 0";
    const dot = document.createElement("span");
    dot.setAttribute("data-dot", "");
    dot.style.cssText = `display:inline-block;width:9px;height:9px;border-radius:50%;background:${a.color};margin-right:6px;`;
    const title = document.createElement("span");
    title.textContent = `${a.name}${a.agentType ? ` · ${a.agentType}` : ""} (${a.state})`;
    const now = document.createElement("div");
    now.style.cssText = "opacity:.7;font-size:.85em;margin-left:15px;";
    now.textContent = `Now: ${a.now}`;
    row.append(dot, title, now);
    container.appendChild(row);
  }
}
