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
