import { hierarchy, partition, treemap, type HierarchyRectangularNode } from "d3-hierarchy";
import type { DirDTO, LeafDTO } from "./protocol.js";
import { isLeaf } from "./protocol.js";
import type { Shape } from "./view-state.js";

type Node = DirDTO | LeafDTO;
export interface Positioned { path: string; type: "dir" | "file"; heat: number; depth: number; pulse?: boolean; x0: number; x1: number; y0: number; y1: number; }
export interface Size { width: number; height: number; }

export function findSubtree(tree: DirDTO, path: string): Node | null {
  if (path === "") return tree;
  let found: Node | null = null;
  const walk = (n: Node): void => {
    if (n.path === path) { found = n; return; }
    if (!isLeaf(n)) n.children.forEach(walk);
  };
  walk(tree);
  return found;
}

export function computeLayout(tree: DirDTO, focus: string, shape: Shape, size: Size): Positioned[] {
  const rootDTO = findSubtree(tree, focus);
  if (!rootDTO) return [];
  const root = hierarchy<Node>(rootDTO, (n) => (isLeaf(n) ? undefined : n.children))
    .sum((n) => (isLeaf(n) ? Math.max(1, n.loc) : 0))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  if (shape === "treemap") {
    treemap<Node>().size([size.width, size.height]).paddingInner(1).round(false)(root);
  } else {
    const radius = Math.min(size.width, size.height) / 2;
    partition<Node>().size([2 * Math.PI, radius])(root);
  }
  return (root.descendants() as Array<HierarchyRectangularNode<Node>>).map((n) => ({
    path: n.data.path, type: n.data.type, heat: n.data.heat, depth: n.depth,
    pulse: isLeaf(n.data) ? n.data.pulse : undefined,
    x0: n.x0, x1: n.x1, y0: n.y0, y1: n.y1,
  }));
}
