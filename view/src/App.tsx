import { type JSX, useEffect, useMemo, useState } from "react";
import { describeConnection } from "../../src/status/connection";
import type { MapMode } from "../../src/status/frames";
import { MapPanel } from "./MapPanel";
import { Honesty, Hottest, Legend } from "./Sidebar";
import { useSession, useSessionList } from "./useSession";

export function App({ token }: { token: string }): JSX.Element {
  const sessions = useSessionList(token);
  const [chosen, setChosen] = useState<string | null>(
    new URLSearchParams(window.location.search).get("session"),
  );
  const [mode, setMode] = useState<MapMode>("live");
  const [selected, setSelected] = useState<string | null>(null);

  // Land on whichever session has actually touched something, so opening the
  // view during real work does not show an empty map from an idle session.
  useEffect(() => {
    if (chosen !== null || sessions.length === 0) return;
    const best = [...sessions].sort((a, b) => b.touched - a.touched)[0];
    if (best !== undefined) setChosen(best.sessionId);
  }, [sessions, chosen]);

  const { snapshot, receivedAt, connection } = useSession(token, chosen);
  const files = useMemo(() => snapshot?.files ?? [], [snapshot]);
  const elapsed = mode === "live" && snapshot !== null ? performance.now() - receivedAt : 0;

  return (
    <div className="app">
      <header>
        <span className="brand">astir</span>

        <select
          className="picker"
          value={chosen ?? ""}
          onChange={(e) => {
            setChosen(e.target.value);
            setSelected(null);
          }}
          aria-label="Session"
        >
          {chosen === null && <option value="">Waiting for a session…</option>}
          {sessions.map((s) => (
            <option key={s.sessionId} value={s.sessionId}>
              {s.name ?? s.cwd.split("/").pop() ?? s.sessionId} · {s.touched} files
            </option>
          ))}
        </select>

        {/* VIEW-10 — the two modes look alike and mean opposite things, so the
            active one is labelled rather than merely highlighted. */}
        <fieldset className="modes" aria-label="Map mode">
          <button
            type="button"
            className={mode === "live" ? "on" : ""}
            aria-pressed={mode === "live"}
            onClick={() => setMode("live")}
          >
            Live · where work is now
          </button>
          <button
            type="button"
            className={mode === "session" ? "on" : ""}
            aria-pressed={mode === "session"}
            onClick={() => setMode("session")}
          >
            Session · where work has been
          </button>
        </fieldset>

        <span className={`conn ${connection.state}`} role="status">
          {describeConnection(connection)}
        </span>
      </header>

      {snapshot !== null && <Honesty counters={snapshot.counters} />}

      <main>
        {snapshot === null ? (
          <div className="panel placeholder">
            {connection.state === "unreachable"
              ? "Cannot reach the astir daemon."
              : "Waiting for the first frame…"}
          </div>
        ) : (
          <MapPanel
            files={files}
            decay={snapshot.decay}
            mode={mode}
            receivedAt={receivedAt}
            selected={selected}
            onSelect={setSelected}
          />
        )}

        <aside>
          <div className="agents">
            <h2>Agents</h2>
            {(snapshot?.agents ?? []).length === 0 ? (
              <p className="empty">None reported.</p>
            ) : (
              <ul>
                {(snapshot?.agents ?? []).map((a) => (
                  <li key={a.id}>
                    <span className={`state ${a.state}`}>{a.state}</span>
                    <span className="who">{a.agentType ?? "main"}</span>
                    <span className="num">{Math.round(a.inStateMs / 1000)}s</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Legend mode={mode} />

          {snapshot !== null && (
            <Hottest
              files={files}
              decay={snapshot.decay}
              mode={mode}
              elapsed={elapsed}
              selected={selected}
              onSelect={setSelected}
            />
          )}
        </aside>
      </main>
    </div>
  );
}
