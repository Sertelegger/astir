/** The shape `astir status` and `astir menubar` both consume from the daemon. */

export interface StatusAgent {
  /**
   * G4 — working time since the human last handed over, excluding any time the
   * agent spent blocked on them. Live time in the current state is NOT included;
   * add `inStateMs` while the agent is working.
   */
  turnMs?: number;
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

/**
 * MOD-01/MOD-08 — a bounded view of the session's repo map.
 *
 * Deliberately a summary rather than the map itself: `/state` is polled every
 * few seconds by the menu bar, and a session that has touched a thousand files
 * would make that poll carry a thousand records nobody is reading. `touched`
 * reports the true size so the summary can never be mistaken for the whole map
 * — the previous version's silent truncation is exactly what VIEW-06 forbids.
 */
export interface FileSummary {
  /** Total files touched this session. */
  touched: number;
  /** Hottest first — what is being worked on right now. */
  hottest: Array<{ path: string; heat: number; total: number; intensity: number; idle: boolean }>;
  /**
   * MOD-08 — progression intervals sealed so far, and when the map started.
   *
   * The frames themselves are not on this route: only VIEW-11's timelapse
   * consumes them and they are far too large for a poll. The count is here so
   * a progression that has silently stopped advancing is visible rather than
   * being a feature nobody can tell has broken.
   */
  samples: number;
  since: number;
}

export interface StatusSession {
  /** Absent until a session touches a file. */
  files?: FileSummary;
  /** DMN-11 — false when a plugin or script drives it, not a person. */
  attended?: boolean;
  sessionId: string;
  cwd: string;
  name: string | null;
  status: string | null;
  /** OS pid where the session runs, when discovery knows it — used by `astir focus`. */
  pid: number | null;
  agents: StatusAgent[];
}

/** A session the provider reports running that has never sent astir an event. */
export interface SilentSession {
  sessionId: string;
  name: string | null;
  cwd: string;
  /** From discovery. Present so a silent session can still be focused. */
  pid?: number | null;
  /** DMN-11 — false when a plugin or script drives it, not a person. */
  attended?: boolean;
  /**
   * Epoch ms the session started, when the provider reports it. Compared with
   * `daemonStartedAt` to tell "its hooks are not wired" apart from "it started
   * before astir was listening" — silence means completely different things.
   */
  startedAt?: number | null;
  /**
   * DMN-08 — this project runs sandboxed and has not allowed the daemon's host,
   * so its hooks are refused by the egress proxy before they reach us. Filled in
   * by the surface from the project's own settings: the daemon cannot know,
   * because the whole symptom is that nothing arrives.
   */
  sandboxBlocked?: boolean;
}

/**
 * A session on another machine.
 *
 * Two independent routes produce these, because neither alone covers the cases
 * that matter. A daemon running over there PUSHES its roster (live, knows agent
 * state, needs astir installed remotely); an SSH POLL from here asks
 * `claude agents --json` over the user's existing access (works with nothing
 * installed remotely, but only sees what discovery sees and costs a round trip).
 * `source` records which, so a push always wins the tie.
 */
export interface RemoteSession {
  host: string;
  sessionId: string;
  cwd: string;
  name: string | null;
  status: string | null;
  source: "push" | "ssh";
  /**
   * DMN-11 — only ever known for the push route: a controlling terminal is a
   * local fact, and `claude agents --json` does not report one, so an SSH poll
   * cannot tell. Undefined means unclassified, which is treated as attended.
   */
  attended?: boolean;
  /** Epoch ms of the last confirmation. */
  lastSeen: number;
  /** Contact lost. The session is probably still running; we stopped being told. */
  stale?: boolean;
}

export interface StatusBody {
  blockedCount: number;
  sessions: StatusSession[];
  /**
   * DMN-07 — the difference between "nothing is running" and "I cannot hear
   * anything". Rendering those identically is the same class of lie as showing a
   * dead daemon as idle, and it is the more common one: hooks bind at session
   * start, so any session older than the plugin install is invisible forever.
   */
  silent?: SilentSession[];
  /** False when no event has ever arrived — i.e. the hooks are not wired at all. */
  everIngested?: boolean;
  /** CAP-08 — non-zero means hooks have EVER fired with a token that did not match. */
  unauthorizedIngest?: number;
  /**
   * When that last happened, as epoch ms. A lifetime total cannot answer "is
   * this happening now", which is the only question a diagnosis should answer.
   */
  lastUnauthorizedAt?: number | null;
  /** Epoch ms this daemon process started. See `SilentSession.startedAt`. */
  daemonStartedAt?: number;
  /** Sessions found by polling paired hosts over SSH. */
  remote?: RemoteSession[];
}

/**
 * PSH-04 — "cannot reach the daemon" is a state the surface must render, not an
 * error it may swallow. A menu bar that silently shows "idle" when the daemon is
 * dead is worse than one that shows nothing.
 */
export type StatusResult = { ok: true; body: StatusBody } | { ok: false; reason: string };
