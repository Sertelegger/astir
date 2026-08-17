/** The shape `clide status` and `clide menubar` both consume from the daemon. */

export interface StatusAgent {
  id: string;
  state: string;
  agentType: string | null;
  activeMs: number;
  blockedMs: number;
}

export interface StatusSession {
  sessionId: string;
  cwd: string;
  name: string | null;
  status: string | null;
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
