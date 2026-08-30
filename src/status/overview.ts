/**
 * VIEW-09 — everything, at once: who needs you, and what is running.
 *
 * A distinct question from the map's. The map answers "where is work happening
 * in THIS repo"; this answers "which of my sessions needs me and what is
 * everything else doing", which is the question the whole push half of the
 * product exists for and the only one that spans machines.
 *
 * Pure, and shared with the menu bar rather than reimplemented beside it. The
 * two surfaces have already drifted twice — on how long a finished agent
 * lingers, and on whether an agent's task is worth showing — and each time the
 * cost was one surface quietly contradicting the other about the same session.
 *
 * ## Ordering is the feature
 *
 * A list of everything is not an overview; it is a list. What makes it useful
 * is that the thing needing a human is first, unconditionally, and that a
 * session astir cannot hear sorts below the ones it can rather than vanishing.
 */

import { isVisibleAgent } from "./agents.js";
import type { RemoteSession, SilentSession, StatusAgent, StatusBody, StatusSession } from "./types.js";

/**
 * Worst first. `blocked` outranks `error` because a blocked agent is waiting on
 * a person right now, while an error has already finished failing.
 */
export const STATE_RANK = ["blocked", "error", "tool-running", "thinking", "waiting", "done", "idle"];

/**
 * The repo, which is how people actually identify a session.
 *
 * `name` is the provider's own session slug (e.g. "astir-56"). It reads like a
 * branch name, is not one, and its suffix is generated — so as a primary label
 * it is close to useless: two sessions in the same project get unrelated-looking
 * names, and the name says nothing about which repo it belongs to.
 */
export function repoName(cwd: string, fallback: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? fallback;
}

/** DMN-11 — driven by a plugin or a script, not by a person. */
export function background(s: { attended?: boolean }): boolean {
  return s.attended === false;
}

/**
 * Labels that are unique within the list they are shown in.
 *
 * Two sessions in the same repo would otherwise be two identical rows, and the
 * only thing worse than an ambiguous label is two of them.
 */
export function sessionLabels(sessions: Array<{ cwd: string; sessionId: string }>): string[] {
  const total = new Map<string, number>();
  for (const s of sessions) {
    const repo = repoName(s.cwd, s.sessionId.slice(0, 8));
    total.set(repo, (total.get(repo) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  return sessions.map((s) => {
    const repo = repoName(s.cwd, s.sessionId.slice(0, 8));
    if ((total.get(repo) ?? 0) < 2) return repo;
    const n = (seen.get(repo) ?? 0) + 1;
    seen.set(repo, n);
    return `${repo} (${n})`;
  });
}

/** The most urgent state among the agents a surface is actually showing. */
export function dominantState(session: { agents: StatusAgent[] }): string | null {
  let best: string | null = null;
  let bestRank = STATE_RANK.length;
  // The same agents the list shows, so a session row cannot claim "done" about
  // an agent that has already aged out of the rows beneath it.
  for (const a of session.agents.filter(isVisibleAgent)) {
    // A dismissed agent is still blocked, but the human has already seen it and
    // chose to defer — surfacing it as an alert again would be nagging.
    const state = a.state === "blocked" && a.acknowledged ? "waiting" : a.state;
    const rank = STATE_RANK.indexOf(state);
    if (rank !== -1 && rank < bestRank) {
      bestRank = rank;
      best = state;
    }
  }
  return best;
}

/** How much astir can say about a session, and why. */
export type SessionKind =
  | "live"
  /** DMN-07 — the provider says it is running; we have never heard from it. */
  | "silent"
  /** DMN-09/10 — on another machine. */
  | "remote"
  /** DMN-11 — a plugin or script drives it; nothing here waits on you. */
  | "background";

export interface OverviewSession {
  sessionId: string;
  /** Disambiguated repo label — what a person calls this session. */
  project: string;
  cwd: string;
  name: string | null;
  kind: SessionKind;
  /** The machine, when it is not this one. */
  host: string | null;
  /** Dominant state, or null when we cannot say. */
  state: string | null;
  /** Agents waiting on a human that the human has NOT already dismissed. */
  blocked: number;
  agents: StatusAgent[];
  /** Contact lost. Probably still running; we stopped being told. */
  stale: boolean;
}

const KIND_RANK: Record<SessionKind, number> = { live: 0, silent: 1, remote: 2, background: 3 };

const unacknowledgedBlocked = (agents: readonly StatusAgent[]): number =>
  agents.filter((a) => a.state === "blocked" && !a.acknowledged).length;

/**
 * Agents worth a row, worst first.
 *
 * A dismissed blocked agent sorts as `waiting` rather than `blocked` — it is
 * still blocked, but the human said "later", and re-floating it to the top of
 * the list every few seconds is how a surface teaches people to stop reading it.
 */
export function rankAgents(agents: readonly StatusAgent[]): StatusAgent[] {
  return agents
    .filter(isVisibleAgent)
    .map((a) => {
      const effective = a.state === "blocked" && a.acknowledged ? "waiting" : a.state;
      const rank = STATE_RANK.indexOf(effective);
      return { agent: a, rank: rank === -1 ? STATE_RANK.length : rank };
    })
    .sort((x, y) => x.rank - y.rank || x.agent.id.localeCompare(y.agent.id))
    .map((x) => x.agent);
}

/**
 * Every session astir knows about, worst first.
 *
 * Silent and remote sessions are included rather than filtered out. A view that
 * shows only what it can hear looks calm in exactly the situation where it is
 * least entitled to — DMN-07's whole point — and "I cannot see this one" is
 * information a person can act on.
 */
export function overview(body: StatusBody): OverviewSession[] {
  const rows: OverviewSession[] = [];

  const live: StatusSession[] = body.sessions ?? [];
  const silent: SilentSession[] = body.silent ?? [];
  const remote: RemoteSession[] = body.remote ?? [];

  // Labels are computed across EVERYTHING, so two sessions in the same repo are
  // still told apart when one of them is silent or on another machine.
  const all = [
    ...live.map((s) => ({ cwd: s.cwd, sessionId: s.sessionId })),
    ...silent.map((s) => ({ cwd: s.cwd, sessionId: s.sessionId })),
    ...remote.map((s) => ({ cwd: s.cwd, sessionId: s.sessionId })),
  ];
  const labels = sessionLabels(all);
  let i = 0;

  for (const s of live) {
    // `agents` is required by the type and absent in practice only from a
    // malformed body — but this parses JSON off a socket, and a view that
    // throws on one odd field shows nothing at all rather than the rest.
    const agents = rankAgents(s.agents ?? []);
    rows.push({
      sessionId: s.sessionId,
      project: labels[i++] ?? s.sessionId.slice(0, 8),
      cwd: s.cwd,
      name: s.name,
      kind: background(s) ? "background" : "live",
      host: null,
      state: dominantState({ agents: s.agents ?? [] }),
      blocked: unacknowledgedBlocked(s.agents ?? []),
      agents,
      stale: false,
    });
  }

  for (const s of silent) {
    rows.push({
      sessionId: s.sessionId,
      project: labels[i++] ?? s.sessionId.slice(0, 8),
      cwd: s.cwd,
      name: s.name,
      kind: background(s) ? "background" : "silent",
      host: null,
      // Null rather than "idle": we do not know, and guessing calm is the lie
      // DMN-07 exists to prevent.
      state: null,
      blocked: 0,
      agents: [],
      stale: false,
    });
  }

  for (const s of remote) {
    rows.push({
      sessionId: s.sessionId,
      project: labels[i++] ?? s.sessionId.slice(0, 8),
      cwd: s.cwd,
      name: s.name,
      kind: background(s) ? "background" : "remote",
      host: s.host,
      state: s.status,
      blocked: 0,
      agents: [],
      stale: s.stale === true,
    });
  }

  return rows.sort(
    (a, b) =>
      // Anything waiting on a human comes first, always. This is the one
      // ordering rule the surface exists to enforce.
      b.blocked - a.blocked ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      stateRank(a.state) - stateRank(b.state) ||
      a.project.localeCompare(b.project) ||
      a.sessionId.localeCompare(b.sessionId),
  );
}

const stateRank = (state: string | null): number => {
  if (state === null) return STATE_RANK.length;
  const rank = STATE_RANK.indexOf(state);
  return rank === -1 ? STATE_RANK.length : rank;
};

/** Total agents waiting on a human, across everything. */
export function blockedTotal(rows: readonly OverviewSession[]): number {
  return rows.reduce((n, r) => n + r.blocked, 0);
}
