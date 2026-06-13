import type { AgentRecordDTO } from "./protocol.js";
import type { Positioned, Size } from "./layout.js";
import type { Shape } from "./view-state.js";
import { normalizeHeat, heatColor } from "./color.js";

const SVGNS = "http://www.w3.org/2000/svg";
export interface HeatmapCallbacks { onFile: (path: string) => void; onZoom: (path: string) => void; }
export interface HeatmapCtx { maxLeafHeat: number; agents: AgentRecordDTO[]; shape: Shape; size: Size; }

function ringColor(path: string, agents: AgentRecordDTO[]): string | null {
  for (let i = agents.length - 1; i >= 0; i--) if (agents[i]!.currentFiles.includes(path)) return agents[i]!.color;
  return null;
}

function arcPath(x0: number, x1: number, y0: number, y1: number, cx: number, cy: number): string {
  const p = (a: number, r: number): [number, number] => [cx + Math.cos(a - Math.PI / 2) * r, cy + Math.sin(a - Math.PI / 2) * r];
  const [sx0, sy0] = p(x0, y1), [sx1, sy1] = p(x1, y1), [ix1, iy1] = p(x1, y0), [ix0, iy0] = p(x0, y0);
  const large = x1 - x0 > Math.PI ? 1 : 0;
  return `M${sx0},${sy0} A${y1},${y1} 0 ${large} 1 ${sx1},${sy1} L${ix1},${iy1} A${y0},${y0} 0 ${large} 0 ${ix0},${iy0} Z`;
}

export function renderHeatmap(svg: SVGSVGElement, nodes: Positioned[], ctx: HeatmapCtx, cb: HeatmapCallbacks): void {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  svg.setAttribute("viewBox", `0 0 ${ctx.size.width} ${ctx.size.height}`);
  const cx = ctx.size.width / 2, cy = ctx.size.height / 2;
  for (const n of nodes) {
    if (n.depth === 0 && n.type === "dir") continue;
    const isFile = n.type === "file";
    const el = document.createElementNS(SVGNS, ctx.shape === "treemap" ? "rect" : "path");
    el.setAttribute("data-path", n.path);
    el.setAttribute("data-type", n.type);
    if (ctx.shape === "treemap") {
      el.setAttribute("x", String(n.x0)); el.setAttribute("y", String(n.y0));
      el.setAttribute("width", String(Math.max(0, n.x1 - n.x0))); el.setAttribute("height", String(Math.max(0, n.y1 - n.y0)));
    } else {
      el.setAttribute("d", arcPath(n.x0, n.x1, n.y0, n.y1, cx, cy));
    }
    el.setAttribute("fill", isFile ? heatColor(normalizeHeat(n.heat, ctx.maxLeafHeat)) : "rgba(255,255,255,0.03)");
    const ring = isFile ? ringColor(n.path, ctx.agents) : null;
    if (ring) { el.setAttribute("stroke", ring); el.setAttribute("stroke-width", "2"); }
    if (isFile && n.pulse) el.setAttribute("data-pulse", "true");
    el.addEventListener("click", () => (isFile ? cb.onFile?.(n.path) : cb.onZoom?.(n.path)));
    svg.appendChild(el);
  }
}
