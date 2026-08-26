/**
 * VIEW-10 — the map's geometry, computed once and shared by both modes.
 *
 * The single most important thing about this file is what it does NOT take as
 * input: heat. Geometry is a function of the repo's shape and of cumulative
 * totals, both of which mean the same thing in live mode and in session mode.
 * That is what makes VIEW-10's "switching preserves layout" true by
 * construction rather than by careful coding on the other side — a layout that
 * could see heat would have to be trusted not to use it, and this one cannot.
 *
 * ## Why a squarified treemap
 *
 * The alternative — a flat grid or a ranked list — throws away the directory
 * structure, and structure is the whole difference between a map and a bar
 * chart. "All the churn is under src/status" is a sentence you can only read
 * off something that groups.
 *
 * Squarified (Bruls, Huizing & van Wijk, 2000) rather than the naive slice-and-
 * dice because slice-and-dice produces slivers: a file laid out one pixel wide
 * is unlabellable, unclickable, and effectively invisible, which for a
 * monitoring surface is the same failure as dropping it.
 *
 * ## Why area is `sqrt(total)`
 *
 * Linear area would let one heavily-edited file swallow the map — twenty
 * touches against one is a twentyfold area ratio, and everything else becomes a
 * sliver again. The square root keeps the ordering intact while compressing the
 * range, so the map still reads as "where work went" without becoming a map of
 * one file. It is a deliberate distortion, and it is why the hottest-files list
 * (VIEW-07) carries the real numbers.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Tile extends Rect {
  path: string;
  total: number;
  /** Nesting depth, for the renderer's padding and label decisions. */
  depth: number;
}

/** A directory's frame, so the map can be read as a tree rather than a heap. */
export interface Group extends Rect {
  prefix: string;
  label: string;
  depth: number;
}

export interface Layout {
  tiles: Tile[];
  groups: Group[];
}

export interface Sized {
  path: string;
  total: number;
}

/** Room for a directory's caption. Dropped when the frame is too small to earn it. */
const HEADER_PX = 13;
const PAD_PX = 2;

interface Node {
  /** Full path for a file, directory prefix for a branch. */
  path: string;
  label: string;
  total: number;
  weight: number;
  children: Node[];
}

function build(files: readonly Sized[]): Node {
  const root: Node = { path: "", label: "", total: 0, weight: 0, children: [] };
  for (const file of files) {
    if (typeof file.path !== "string" || file.path.length === 0) continue;
    const parts = file.path.split("/").filter((p) => p.length > 0);
    if (parts.length === 0) continue;

    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i] as string;
      const prefix = node.path === "" ? name : `${node.path}/${name}`;
      let next = node.children.find((c) => c.path === prefix);
      if (next === undefined) {
        next = { path: prefix, label: name, total: 0, weight: 0, children: [] };
        node.children.push(next);
      }
      node = next;
    }
    const leafName = parts[parts.length - 1] as string;
    node.children.push({
      path: file.path,
      label: leafName,
      total: file.total,
      weight: Math.sqrt(Math.max(0, file.total)) || 0,
      children: [],
    });
  }
  collapse(root);
  weigh(root);
  return root;
}

/**
 * Fold `a → b → c` chains into a single `a/b/c` frame.
 *
 * A repo where everything lives under `src/` otherwise spends most of the map's
 * area and three levels of padding drawing a box labelled "src" around another
 * box. Collapsing costs nothing — the joined label says exactly the same thing.
 */
function collapse(node: Node): void {
  for (const child of node.children) collapse(child);
  if (node.path === "") return;
  while (node.children.length === 1) {
    const only = node.children[0] as Node;
    if (only.children.length === 0) break; // a lone FILE still needs its own tile
    node.path = only.path;
    node.label = `${node.label}/${only.label}`;
    node.children = only.children;
  }
}

function weigh(node: Node): number {
  if (node.children.length === 0) return node.weight;
  node.weight = node.children.reduce((sum, c) => sum + weigh(c), 0);
  node.total = node.children.reduce((sum, c) => sum + c.total, 0);
  // Largest first, then by path — deterministic, so equal weights never shuffle
  // between frames and make the map twitch for no reason.
  node.children.sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path));
  return node.weight;
}

/**
 * The worst aspect ratio in a row — the quantity squarifying minimises.
 *
 * `side` is the shorter side of the free rectangle, which is what the row is
 * laid along.
 */
function worst(areas: readonly number[], side: number): number {
  if (areas.length === 0) return Number.POSITIVE_INFINITY;
  let sum = 0;
  let max = 0;
  let min = Number.POSITIVE_INFINITY;
  for (const a of areas) {
    sum += a;
    if (a > max) max = a;
    if (a < min) min = a;
  }
  if (sum <= 0 || min <= 0 || side <= 0) return Number.POSITIVE_INFINITY;
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}

interface Placed {
  node: Node;
  rect: Rect;
}

function placeRow(areas: number[], nodes: Node[], free: Rect): { placed: Placed[]; rest: Rect } {
  const sum = areas.reduce((a, b) => a + b, 0);
  const placed: Placed[] = [];
  if (sum <= 0) {
    // A row of nothing but zero-weight nodes — a file touched zero times, which
    // the map still has to acknowledge. Returning early without them would drop
    // the tile silently, which is the one thing this layer must never do.
    return {
      placed: areas.map((_, i) => ({ node: nodes[i] as Node, rect: { ...free, w: 0, h: 0 } })),
      rest: free,
    };
  }

  if (free.w >= free.h) {
    const w = free.h > 0 ? sum / free.h : 0;
    let y = free.y;
    areas.forEach((a, i) => {
      const h = w > 0 ? a / w : 0;
      placed.push({ node: nodes[i] as Node, rect: { x: free.x, y, w, h } });
      y += h;
    });
    return { placed, rest: { x: free.x + w, y: free.y, w: free.w - w, h: free.h } };
  }

  const h = free.w > 0 ? sum / free.w : 0;
  let x = free.x;
  areas.forEach((a, i) => {
    const w = h > 0 ? a / h : 0;
    placed.push({ node: nodes[i] as Node, rect: { x, y: free.y, w, h } });
    x += w;
  });
  return { placed, rest: { x: free.x, y: free.y + h, w: free.w, h: free.h - h } };
}

function squarify(nodes: readonly Node[], rect: Rect): Placed[] {
  const zero = { x: rect.x, y: rect.y, w: 0, h: 0 };
  const total = nodes.reduce((s, n) => s + n.weight, 0);
  // Everything still gets a rectangle, even a degenerate one. Dropping a node
  // that does not fit is the silent truncation VIEW-06 forbids; a zero-area
  // tile is at least still in the keyboard order and the hottest-files list.
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) {
    return nodes.map((node) => ({ node, rect: zero }));
  }

  const scale = (rect.w * rect.h) / total;
  const queue = nodes.map((node) => ({ node, area: node.weight * scale }));
  const out: Placed[] = [];
  let free = { ...rect };
  let rowAreas: number[] = [];
  let rowNodes: Node[] = [];

  while (queue.length > 0) {
    const head = queue[0] as { node: Node; area: number };
    const side = Math.min(free.w, free.h);
    if (rowAreas.length === 0 || worst([...rowAreas, head.area], side) <= worst(rowAreas, side)) {
      rowAreas.push(head.area);
      rowNodes.push(head.node);
      queue.shift();
      continue;
    }
    const done = placeRow(rowAreas, rowNodes, free);
    out.push(...done.placed);
    free = done.rest;
    rowAreas = [];
    rowNodes = [];
  }
  if (rowAreas.length > 0) out.push(...placeRow(rowAreas, rowNodes, free).placed);
  return out;
}

/**
 * Lay `files` out inside `area`.
 *
 * Deterministic and total: the same input always gives the same output, and
 * every input file appears exactly once in `tiles`.
 */
export function layout(files: readonly Sized[], area: Rect): Layout {
  const tiles: Tile[] = [];
  const groups: Group[] = [];
  const root = build(files);
  // An empty session has no root tile. Without this the childless root falls
  // through the leaf branch below and the map draws one enormous nameless box.
  if (root.children.length === 0) return { tiles, groups };

  const place = (node: Node, rect: Rect, depth: number): void => {
    if (node.children.length === 0) {
      tiles.push({ ...rect, path: node.path, total: node.total, depth });
      return;
    }
    let inner = rect;
    if (depth > 0) {
      groups.push({ ...rect, prefix: node.path, label: node.label, depth });
      // A caption is only worth its pixels when the frame can spare them;
      // below that the group still exists, it just goes uncaptioned.
      const header = rect.h > HEADER_PX * 3 && rect.w > HEADER_PX * 4 ? HEADER_PX : 0;
      inner = {
        x: rect.x + PAD_PX,
        y: rect.y + header,
        w: Math.max(0, rect.w - PAD_PX * 2),
        h: Math.max(0, rect.h - header - PAD_PX),
      };
    }
    for (const child of squarify(node.children, inner)) place(child.node, child.rect, depth + 1);
  };

  place(root, area, 0);
  return { tiles, groups };
}
