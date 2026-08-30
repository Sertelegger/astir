import type { JSX } from "react";
import { agentDetail, humanDuration } from "../../src/status/agents";
import type { OverviewSession } from "../../src/status/overview";
import { blockedTotal } from "../../src/status/overview";

export interface OverviewProps {
  sessions: OverviewSession[];
  /** `performance.now()` when the poll landed, so times advance between polls. */
  receivedAt: number;
  now: number;
  onOpen: (sessionId: string) => void;
  reachable: boolean;
}

/**
 * VIEW-09 — every agent, everywhere, worst first.
 *
 * A different question from the map's, and deliberately a different screen:
 * the map asks "where is work happening in this repo", this asks "which of
 * these needs me". Rendering them as one view would force the second question
 * to be answered one session at a time, which is the thing being fixed.
 *
 * Sessions astir cannot hear are listed rather than filtered out. A surface
 * showing only what it can hear looks calmest exactly when it is least entitled
 * to, which is DMN-07's whole point.
 */
export function Overview(props: OverviewProps): JSX.Element {
  const { sessions, onOpen } = props;
  const blocked = blockedTotal(sessions);
  const elapsed = Math.max(0, props.now - props.receivedAt);

  if (!props.reachable) {
    return (
      <div className="overview">
        <p className="empty">Cannot reach the astir daemon.</p>
      </div>
    );
  }

  return (
    <div className="overview">
      {blocked > 0 ? (
        <div className="waiting-banner" role="status">
          <strong>
            {blocked} agent{blocked === 1 ? "" : "s"}
          </strong>{" "}
          waiting on you
        </div>
      ) : null}

      {sessions.length === 0 && <p className="empty">No sessions running.</p>}

      <ul className="sessions">
        {sessions.map((s) => (
          <li key={s.sessionId} className={`session ${s.kind}${s.blocked > 0 ? " blocked" : ""}`}>
            {/* The whole row opens the session. A row that looks like the others
                but does nothing reads as broken rather than as deliberately
                inert — there is no visual difference between the two. */}
            <button type="button" className="session-head" onClick={() => onOpen(s.sessionId)}>
              <span className="project">{s.project}</span>
              {s.host !== null && <span className="host">{s.host}</span>}
              <span className={`state ${s.state ?? "unknown"}`}>{stateLabel(s)}</span>
              {s.blocked > 0 && <span className="badge">{s.blocked} waiting</span>}
            </button>
            <div className="cwd" title={s.cwd}>
              {s.cwd}
            </div>

            {s.agents.length > 0 && (
              <ul className="session-agents">
                {s.agents.map((a) => {
                  const detail = agentDetail(a);
                  return (
                    <li key={a.id}>
                      <span className={`state ${a.state}`}>{a.state}</span>
                      <span className="who">{a.agentType ?? "main"}</span>
                      {detail !== null && (
                        <span className="detail" title={detail}>
                          {detail}
                        </span>
                      )}
                      <span className="num">{humanDuration(a.inStateMs + elapsed)}</span>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Why there is nothing more to say, rather than an empty gap that
                looks like "nothing is happening". */}
            {s.kind === "silent" && <p className="quiet">Not connected — astir has heard nothing from it.</p>}
            {s.stale && <p className="quiet">Contact lost — it is probably still running.</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function stateLabel(s: OverviewSession): string {
  if (s.stale) return "unreachable";
  if (s.kind === "silent") return "unknown";
  return s.state ?? "idle";
}
