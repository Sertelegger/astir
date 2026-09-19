/**
 * What every surface agrees about agents: which ones are worth showing, and how
 * to say how long.
 *
 * Extracted because the menu bar and the web view had drifted. The menu bar
 * dropped a finished agent after a minute; the view listed every agent the
 * session had ever spawned, for as long as the daemon had been up. On a daemon
 * running for days that is a wall of "done" rows burying the two that are
 * actually working — the same surface answering "what is happening" with a
 * transcript of what has already stopped happening.
 */

import type { StatusAgent } from "./types.js";

/**
 * How long a finished agent stays on screen.
 *
 * Not zero: an agent that finishes the instant you look away should still be
 * there when you look back, or the surface appears to have lost it. Not
 * unbounded either — see above.
 */
export const DONE_LINGER_MS = 60_000;

const TERMINAL = new Set(["done", "error"]);

/**
 * Worth a row right now.
 *
 * `error` never expires. A failure is the one terminal state you may not have
 * seen yet, and quietly retiring it after a minute would make the surface hide
 * exactly what it exists to report.
 */
export function isVisibleAgent(agent: Pick<StatusAgent, "state" | "inStateMs">): boolean {
  if (agent.state === "error") return true;
  return !TERMINAL.has(agent.state) || agent.inStateMs < DONE_LINGER_MS;
}

export function visibleAgents<T extends Pick<StatusAgent, "state" | "inStateMs">>(agents: readonly T[]): T[] {
  return agents.filter(isVisibleAgent);
}

/**
 * A duration a person can read at a glance.
 *
 * Days are handled because they occur: the daemon holds state in memory and is
 * often left running for a week, so a finished agent's clock keeps counting.
 * Rendering that as `232129s` is technically a duration and practically a
 * number nobody converts in their head.
 */
export function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Everything a surface needs to say who an agent is and what it is doing. */
export interface AgentLabel {
  /** Which agent: its type, or `main` for the session itself. */
  who: string;
  /** What it was sent to do. Null for the main agent — it has no sidecar. */
  task: string | null;
  /** What it is doing this instant, e.g. `Edit src/status/ramp.ts`. */
  doing: string | null;
}

/**
 * Two different questions, deliberately kept apart.
 *
 * `task` is standing and `doing` is instantaneous, and a surface wants both:
 * "Explore — finding where heat is computed — currently grepping src/". Folding
 * them into one string forces every renderer to pick one, and whichever it
 * picks is wrong half the time. The main agent has no task, which is a real
 * absence and must render as one rather than as an invented label.
 *
 * The tool NAME and its path only. NG1 forbids retaining tool arguments; paths
 * are carved out because the map is grown from them, but a Bash command line is
 * not a path and has no business here.
 */
export function describeAgent(
  agent: Pick<StatusAgent, "agentType" | "description" | "tool" | "toolPath">,
): AgentLabel {
  const tool = agent.tool ?? null;
  const path = agent.toolPath ?? null;
  return {
    who: agent.agentType ?? "main",
    task: agent.description ?? null,
    doing: tool === null ? null : path === null ? tool : `${tool} ${path}`,
  };
}

/**
 * The most specific true thing about this agent, for a surface with one line.
 *
 * Prefers what it is doing NOW over what it was sent to do, because a menu bar
 * is read to answer "what is happening", and returns null rather than padding
 * with a state word the caller is already rendering next to it.
 */
export function agentDetail(
  agent: Pick<StatusAgent, "agentType" | "description" | "tool" | "toolPath">,
): string | null {
  const { task, doing } = describeAgent(agent);
  return doing ?? task;
}

/** Shorten for a fixed-width surface, keeping the end when it is a path. */
export function ellipsise(text: string, max: number): string {
  if (max <= 1 || text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** One rail row: the agent, and how deep in the spawn tree it sits. */
export interface RailRow<T> {
  agent: T;
  depth: number;
}

type Nestable = Pick<StatusAgent, "id" | "state" | "acknowledged"> & {
  parentId?: string | null;
};

/**
 * How loudly a subtree is asking for a human.
 *
 * The rail's whole job is G1 — which agent needs you — so this is what decides
 * order, at every level. An unacknowledged block outranks a dismissed one,
 * because dismissing says "I know" and not "it is resolved".
 */
function urgency(a: Nestable): number {
  if (a.state !== "blocked") return 0;
  return a.acknowledged ? 1 : 2;
}

/**
 * CAP-05 — the spawn tree, flattened into rows with a depth.
 *
 * Returns rows rather than a nested structure because the rail renders a list
 * and the only thing it needs from the tree is indentation — and because a flat
 * array is what makes "is this ordered correctly" a testable question.
 *
 * **Depth must never outrank needing a human.** A subtree is ordered by the
 * worst thing anywhere inside it, so a blocked grandchild pulls its whole
 * branch to the top and stays reachable without scrolling. Ordering purely by
 * structure would bury the one row the product exists to show, which is the
 * rail being pretty at the cost of being useful.
 *
 * Orphans are roots. An agent whose parent has finished and been filtered out
 * still has to appear — dropping it would hide live work because something
 * unrelated ended, and the parent's absence is not the child's fault.
 *
 * Cycles cannot hang it, and the reason is worth stating because it is not the
 * visited sets. Each agent has exactly one `parentId`, so every member of a
 * cycle has its parent INSIDE that cycle — which means no cycle is ever a root
 * and none is reachable from one. The walk therefore covers a forest and
 * terminates on its own; what rescues a cycle's members is the completeness
 * sweep at the end, which appends anything the walk never reached.
 *
 * The visited sets are kept anyway, and deliberately: they are unreachable
 * given one parent per node, and that invariant lives in a payload arriving
 * over a wire. The cost of keeping them is a Set; the cost of being wrong is a
 * frozen tab. A mutation removing them survives the suite, and that is honest
 * rather than a gap — there is no input that reaches them.
 */
export function nestAgents<T extends Nestable>(agents: readonly T[]): Array<RailRow<T>> {
  const byId = new Map<string, T>(agents.map((a) => [a.id, a]));
  const children = new Map<string, T[]>();
  const roots: T[] = [];

  for (const a of agents) {
    const parent = a.parentId ?? null;
    // Present in the input, not merely named: a parent that has finished is not
    // a parent this rail can nest under.
    if (parent !== null && parent !== a.id && byId.has(parent)) {
      const sibs = children.get(parent) ?? [];
      sibs.push(a);
      children.set(parent, sibs);
    } else {
      roots.push(a);
    }
  }

  /** The loudest urgency anywhere in this agent's subtree. */
  const worst = new Map<string, number>();
  const scoreOf = (a: T, seen: Set<string>): number => {
    const cached = worst.get(a.id);
    if (cached !== undefined) return cached;
    if (seen.has(a.id)) return urgency(a);
    seen.add(a.id);
    let best = urgency(a);
    for (const child of children.get(a.id) ?? []) best = Math.max(best, scoreOf(child, seen));
    worst.set(a.id, best);
    return best;
  };

  // Stable within a tie: two equally quiet siblings must not swap places
  // between frames, which would make the rail flicker and every row's position
  // meaningless.
  const order = (list: T[]): T[] => {
    const index = new Map(list.map((a, i) => [a.id, i]));
    return [...list].sort(
      (x, y) =>
        scoreOf(y, new Set()) - scoreOf(x, new Set()) || (index.get(x.id) ?? 0) - (index.get(y.id) ?? 0),
    );
  };

  const rows: Array<RailRow<T>> = [];
  const walk = (list: T[], depth: number, seen: Set<string>): void => {
    for (const a of order(list)) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      rows.push({ agent: a, depth });
      walk(children.get(a.id) ?? [], depth + 1, seen);
    }
  };
  walk(roots, 0, new Set());

  // A cycle among non-roots would otherwise vanish entirely. Appending them at
  // the top level keeps the rail's contents complete even when its shape is
  // wrong, because a missing agent is the worse failure.
  const shown = new Set(rows.map((r) => r.agent.id));
  for (const a of agents) if (!shown.has(a.id)) rows.push({ agent: a, depth: 0 });
  return rows;
}
