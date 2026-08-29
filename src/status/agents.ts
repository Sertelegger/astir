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
