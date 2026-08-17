/** The shape `clide status` and `clide menubar` both consume from the daemon. */

export interface StatusAgent {
  id: string;
  state: string;
  agentType: string | null;
  /**
   * Banked totals — time in states already left. These do NOT include the
   * current state, which is why they must never be rendered on their own for an
   * agent that is still in that state: a blocked agent's `blockedMs` is whatever
   * it was on entry, and stays there for as long as the wait lasts.
   */
  activeMs: number;
  blockedMs: number;
  /**
   * Duration of the state the agent is in *right now*, computed by the daemon at
   * snapshot time. This is what a surface should show: "waiting 4m", not the
   * frozen banked total.
   */
  inStateMs: number;
  /** True once the human has dismissed this one; still blocked, no longer shouting. */
  acknowledged: boolean;
}

export interface StatusSession {
  sessionId: string;
  cwd: string;
  name: string | null;
  status: string | null;
  /** OS pid where the session runs, when discovery knows it — used by `clide focus`. */
  pid: number | null;
  agents: StatusAgent[];
}

export interface StatusBody {
  blockedCount: number;
  sessions: StatusSession[];
}

/**
 * PSH-04 — "cannot reach the daemon" is a state the surface must render, not an
 * error it may swallow. A menu bar that silently shows "idle" when the daemon is
 * dead is worse than one that shows nothing.
 */
export type StatusResult = { ok: true; body: StatusBody } | { ok: false; reason: string };
