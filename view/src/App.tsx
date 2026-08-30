import { type JSX, useEffect, useMemo, useState } from "react";
import { describeConnection } from "../../src/status/connection";
import type { MapMode } from "../../src/status/frames";
import { blockedTotal } from "../../src/status/overview";
import { MapPanel } from "./MapPanel";
import { Overview } from "./Overview";
import { Agents, Honesty, Hottest, Legend } from "./Sidebar";
import { useNow } from "./useNow";
import { useSession, useWorld } from "./useSession";

/** Which question the view is answering right now. */
type Screen = "overview" | "map";

export function App({ token }: { token: string }): JSX.Element {
  const world = useWorld(token);
  const asked = new URLSearchParams(window.location.search).get("session");
  const [chosen, setChosen] = useState<string | null>(asked);
  // Landing on the overview unless a session was named: "which of these needs
  // me" is the question you have on opening the view, and answering it with one
  // arbitrary session's map is answering a different one.
  const [screen, setScreen] = useState<Screen>(asked === null ? "overview" : "map");
  const [mode, setMode] = useState<MapMode>("live");
  const [selected, setSelected] = useState<string | null>(null);
  // Ticks once a second so every duration on screen advances between frames —
  // neither the stream nor the poll fires just because a clock moved.
  const now = useNow();

  // Land on whichever session has actually touched something, so opening a map
  // during real work does not show an empty one from an idle session.
  useEffect(() => {
    if (chosen !== null || world.sessions.length === 0) return;
    const busiest = [...world.sessions].sort(
      (a, b) => (world.touched.get(b.sessionId) ?? 0) - (world.touched.get(a.sessionId) ?? 0),
    )[0];
    if (busiest !== undefined) setChosen(busiest.sessionId);
  }, [world, chosen]);

  // VIEW-08 — switching is a change of argument, not a reload: the same page,
  // the same token, one stream torn down and another opened. Passing null while
  // on the overview closes the stream rather than holding a session open behind
  // a screen nobody is looking at.
  const { snapshot, receivedAt, connection } = useSession(token, screen === "map" ? chosen : null);
  const files = useMemo(() => snapshot?.files ?? [], [snapshot]);
  const elapsed = mode === "live" && snapshot !== null ? Math.max(0, now - receivedAt) : 0;
  const blocked = blockedTotal(world.sessions);
  const here = world.sessions.find((s) => s.sessionId === chosen);

  const open = (sessionId: string): void => {
    setChosen(sessionId);
    setSelected(null);
    setScreen("map");
  };

  return (
    <div className="app">
      <header>
        <span className="brand">astir</span>

        <nav className="screens" aria-label="View">
          <button
            type="button"
            className={screen === "overview" ? "on" : ""}
            aria-pressed={screen === "overview"}
            onClick={() => setScreen("overview")}
          >
            Overview
            {/* The count belongs on the way BACK to the overview, since that is
                the screen that can do anything about it. */}
            {blocked > 0 && <span className="badge">{blocked}</span>}
          </button>
          <button
            type="button"
            className={screen === "map" ? "on" : ""}
            aria-pressed={screen === "map"}
            disabled={chosen === null}
            onClick={() => setScreen("map")}
          >
            {here === undefined ? "Map" : `Map · ${here.project}`}
          </button>
        </nav>

        {screen === "map" && (
          /* VIEW-10 — the two modes look alike and mean opposite things, so the
             active one is labelled rather than merely highlighted. */
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
        )}

        <span className={`conn ${screen === "map" ? connection.state : "live"}`} role="status">
          {screen === "map"
            ? describeConnection(connection)
            : world.reachable
              ? `${world.sessions.length} session${world.sessions.length === 1 ? "" : "s"}`
              : "Daemon unreachable"}
        </span>
      </header>

      {screen === "overview" ? (
        <Overview
          sessions={world.sessions}
          receivedAt={world.receivedAt}
          now={now}
          onOpen={open}
          reachable={world.reachable}
        />
      ) : (
        <>
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

            {/* Each region scrolls on its own. With one scroll for the whole
                sidebar, a session with many agents pushed the legend and the
                hottest-files list off the bottom — the two things the map is
                unreadable without. */}
            <aside>
              <section className="rail">
                <Agents agents={snapshot?.agents ?? []} receivedAt={receivedAt} now={now} />
              </section>

              <section className="grow">
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
              </section>

              <section className="foot">
                <Legend mode={mode} />
              </section>
            </aside>
          </main>
        </>
      )}
    </div>
  );
}
