import { type JSX, useEffect, useMemo, useState } from "react";
import { describeConnection } from "../../src/status/connection";
import type { MapMode } from "../../src/status/frames";
import { blockedTotal } from "../../src/status/overview";
import { allHidden, type PanelId, panelsIn, type Region, weightOf } from "../../src/status/panels";
import { absolutePathOf } from "../../src/status/paths";
import { MapPanel } from "./MapPanel";
import { Overview } from "./Overview";
import { HiddenPanels, Panel } from "./Panel";
import { Agents, Honesty, Hottest, Legend } from "./Sidebar";
import { useNow } from "./useNow";
import { usePanels } from "./usePanels";
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
  // VIEW-05 — what a click just did with a path, shown briefly. A copy nobody
  // can see is indistinguishable from a dead click, and a copy the browser
  // REFUSED must not be reported as one that worked: the clipboard needs a
  // permission that a page can be denied, and the path is then still only on
  // screen. Showing it is what makes that recoverable.
  const [copied, setCopied] = useState<{ path: string; ok: boolean } | null>(null);
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
  const { snapshot, receivedAt, connection } = useSession(
    token,
    screen === "map" ? chosen : null,
    // So a session this daemon does not own reports WHERE it runs, rather than
    // just that it is missing.
    (id) => world.sessions.find((s) => s.sessionId === id)?.host ?? null,
  );
  const files = useMemo(() => snapshot?.files ?? [], [snapshot]);
  const elapsed = mode === "live" && snapshot !== null ? Math.max(0, now - receivedAt) : 0;
  const blocked = blockedTotal(world.sessions);
  const here = world.sessions.find((s) => s.sessionId === chosen);
  // VIEW-01 — the layout follows the PROJECT, which outlives any one session.
  // `here?.cwd` is known from the poll before the first frame arrives, so the
  // saved arrangement is in place rather than flashing the default first.
  const panels = usePanels(here?.cwd ?? snapshot?.cwd ?? null);

  // The confirmation is transient by design: it reports an action, not a state,
  // and one that stayed put would start reading as "this file is selected".
  useEffect(() => {
    if (copied === null) return;
    const t = setTimeout(() => setCopied(null), 3_000);
    return () => clearTimeout(t);
  }, [copied]);

  /**
   * VIEW-05 — clicking a file.
   *
   * The spec's first clause hands the path to a host that owns an editor; that
   * host is the VSCode webview, and `astir view` is an ordinary browser tab. So
   * the clause that applies here is the second: copy the path and confirm.
   *
   * Selecting as well, because the click already meant "this one" — cross
   * highlighting the map and the ranked list is what tells you WHICH file you
   * just copied when the two disagree about ordering.
   */
  const copyPath = (path: string): void => {
    setSelected(path);
    const absolute = absolutePathOf(snapshot?.cwd ?? "", path);
    const clipboard = navigator.clipboard;
    if (clipboard === undefined) {
      setCopied({ path: absolute, ok: false });
      return;
    }
    void clipboard.writeText(absolute).then(
      () => setCopied({ path: absolute, ok: true }),
      () => setCopied({ path: absolute, ok: false }),
    );
  };

  /**
   * What each panel shows. The ONLY place a panel id is named — and it answers
   * "what goes inside", never "where does it go" or "how much room does it
   * get". Those come from the arrangement, which is what keeps the map a peer.
   */
  const content = (id: PanelId): JSX.Element | null => {
    if (snapshot === null) return null;
    switch (id) {
      case "map":
        return (
          <MapPanel
            files={files}
            decay={snapshot.decay}
            mode={mode}
            receivedAt={receivedAt}
            selected={selected}
            onSelect={copyPath}
          />
        );
      case "agents":
        return <Agents agents={snapshot.agents} receivedAt={receivedAt} now={now} />;
      case "files":
        return (
          <Hottest
            files={files}
            decay={snapshot.decay}
            mode={mode}
            elapsed={elapsed}
            selected={selected}
            onSelect={copyPath}
          />
        );
      case "legend":
        return <Legend mode={mode} />;
    }
  };

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
          {copied !== null && (
            <p className={copied.ok ? "copied" : "copied failed"} role="status">
              {copied.ok ? "Copied " : "Could not copy — select and copy: "}
              <code>{copied.path}</code>
            </p>
          )}
          {snapshot !== null && <Honesty counters={snapshot.counters} />}
          <HiddenPanels
            hidden={panels.arrangement.hidden}
            onShow={(id) => panels.hide(id, false)}
            onReset={panels.reset}
          />

          {snapshot === null ? (
            <div className="panel placeholder">
              {connection.state === "unreachable"
                ? "Cannot reach the astir daemon."
                : "Waiting for the first frame…"}
            </div>
          ) : allHidden(panels.arrangement) ? (
            <div className="panel placeholder">
              Every panel is hidden. Restore one above, or reset the layout.
            </div>
          ) : (
            /* VIEW-01 — the layout IS the arrangement. Nothing below asks which
               panel it is looking at; regions are sized from the weights of
               whatever they happen to contain, so moving the map to the side
               moves the space with it. */
            <main>
              {(["main", "side"] as Region[]).map((region) => {
                const inRegion = panelsIn(panels.arrangement, region);
                if (inRegion.length === 0) return null;
                return (
                  <div
                    key={region}
                    className={`region region-${region}`}
                    style={{ flexGrow: Math.max(1, weightOf(panels.arrangement, region)) }}
                  >
                    {inRegion.map((id, index) => (
                      <Panel
                        key={id}
                        id={id}
                        region={region}
                        index={index}
                        count={inRegion.length}
                        onMove={(panel, to) => panels.move(panel, to)}
                        onNudge={panels.nudge}
                        onHide={(panel) => panels.hide(panel, true)}
                      >
                        {content(id)}
                      </Panel>
                    ))}
                  </div>
                );
              })}
            </main>
          )}
        </>
      )}
    </div>
  );
}
