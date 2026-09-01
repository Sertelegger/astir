import type { JSX } from "react";
import { describeAgent, humanDuration, visibleAgents } from "../../src/status/agents";
import type { AgentFrame, FileFrame, FrameCounters, MapMode } from "../../src/status/frames";
import { shades } from "../../src/status/frames";
import { css, ramp } from "../../src/status/ramp";

const STEPS = 9;

/**
 * VIEW-04 — the legend.
 *
 * Labelled at both ends because the ramp means different things in the two
 * modes, and an unlabelled gradient is a decoration rather than a key.
 */
export function Legend({ mode }: { mode: MapMode }): JSX.Element {
  return (
    <div className="legend">
      <div className="legend-swatches" aria-hidden="true">
        {Array.from({ length: STEPS }, (_, i) => css(ramp(i / (STEPS - 1)))).map((colour) => (
          <span key={colour} className="legend-step" style={{ background: colour }} />
        ))}
      </div>
      <div className="legend-ends">
        <span>{mode === "live" ? "idle" : "untouched"}</span>
        <span>{mode === "live" ? "active now" : "most touched"}</span>
      </div>
      <p className="legend-note">
        Tile area is cumulative work (√ touches) and does not change with mode. The bar inside each tile
        repeats the colour as a length.
      </p>
    </div>
  );
}

export interface HottestProps {
  files: FileFrame[];
  decay: { halfLifeMs: number; referenceHeat: number; idleFloor: number };
  mode: MapMode;
  elapsed: number;
  selected: string | null;
  onSelect: (path: string) => void;
}

/**
 * VIEW-07 — the map's accessibility fallback, and the honest numbers.
 *
 * Every mark on a canvas is invisible to assistive technology and unreachable
 * by keyboard, so the spec accepts a ranked list in its place. That makes this
 * list load-bearing rather than decorative: it is the only way some people will
 * read the map at all, which is why it carries the real values that the tile
 * areas deliberately compress.
 */
export function Hottest(props: HottestProps): JSX.Element {
  const ranked = shades(props.files, props.mode, props.elapsed, props.decay)
    .sort((a, b) => b.value - a.value || a.path.localeCompare(b.path))
    .slice(0, 25);

  return (
    <div className="hottest">
      {/* Not a heading — the panel chrome supplies that. This says which
          RANKING is being shown, which the panel title cannot. */}
      <p className="panel-sub">{props.mode === "live" ? "Hottest now" : "Most touched"}</p>
      {ranked.length === 0 ? (
        <p className="empty">No files touched yet.</p>
      ) : (
        <ol>
          {ranked.map((file) => (
            // Keyed by path so React preserves element identity across frames
            // (VIEW-03): scroll position, focus and text selection survive.
            <li key={file.path}>
              <button
                type="button"
                className={file.path === props.selected ? "row selected" : "row"}
                onClick={() => props.onSelect(file.path)}
              >
                <span className="dot" style={{ background: css(ramp(file.intensity)) }} />
                <span className="path" title={file.path}>
                  {file.path}
                </span>
                <span className="num">{props.mode === "live" ? file.value.toFixed(1) : file.total}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * VIEW-06 — what this view is NOT showing.
 *
 * A monitoring tool must not lie by omission, and the most comfortable lie is
 * the one where absent data simply never appears. But there is a second way to
 * be untrustworthy, and the first version of this banner committed it: dressing
 * an ordinary fact about scope as a malfunction.
 *
 * Paths outside the repo are the overwhelmingly common case — an agent reads
 * `~/.zshrc`, or a file in a sibling checkout — and a REPO map has nowhere to
 * put them. Saying "this map is missing work that happened" about that is
 * alarming, unactionable, and spends on a non-event the credibility the banner
 * needs for a real gap. So the two are separated by severity and by wording,
 * and only one of them is a warning.
 */
export function Honesty({ counters }: { counters: FrameCounters }): JSX.Element | null {
  const { pathsOutsideRepo, invalidEvents } = counters;
  if (pathsOutsideRepo === 0 && invalidEvents === 0) return null;

  if (invalidEvents > 0) {
    return (
      <div className="honesty warn" role="status">
        <strong>Incomplete</strong> — {invalidEvents} event
        {invalidEvents === 1 ? "" : "s"} could not be read
        {pathsOutsideRepo > 0 ? `, and ${pathsOutsideRepo} paths fell outside this repo` : ""}. This map is
        missing work that happened.
      </div>
    );
  }

  return (
    <div className="honesty note" role="status">
      {pathsOutsideRepo} path{pathsOutsideRepo === 1 ? "" : "s"} outside this repo{" "}
      {pathsOutsideRepo === 1 ? "is" : "are"} not on the map — a repo map can only place files within it.
      Nothing was lost.
    </div>
  );
}

export interface AgentsProps {
  agents: AgentFrame[];
  /** `performance.now()` when the frame landed, so times advance between frames. */
  receivedAt: number;
  now: number;
}

/**
 * The agent rail.
 *
 * Two things this gets right that the first version did not. It shows only
 * agents `visibleAgents` considers current — a daemon left running for days had
 * been rendering every subagent that had ever finished, a wall of "done" rows
 * burying the one or two actually working. And it ADVANCES the clock rather
 * than printing whatever the last frame happened to say, because the daemon
 * deliberately does not send a frame merely because a timer moved.
 */
export function Agents({ agents, receivedAt, now }: AgentsProps): JSX.Element {
  const elapsed = Math.max(0, now - receivedAt);
  const live = visibleAgents(agents);
  const hidden = agents.length - live.length;

  return (
    <div className="agents">
      {live.length === 0 ? (
        <p className="empty">Nothing running.</p>
      ) : (
        <ul>
          {live.map((a) => {
            const { who, task, doing } = describeAgent(a);
            return (
              <li key={a.id}>
                <div className="agent-head">
                  <span className={`state ${a.state}`}>{a.state}</span>
                  <span className="who">{who}</span>
                  <span className="num">{humanDuration(a.inStateMs + elapsed)}</span>
                </div>
                {/* Both, when both exist: the standing brief and the current
                    action answer different questions, and an agent three
                    minutes into a task wants the first while a burst of tool
                    calls wants the second. The main agent has no brief, and
                    that absence renders as absence. */}
                {task !== null && (
                  <div className="agent-task" title={task}>
                    {task}
                  </div>
                )}
                {doing !== null && (
                  <div className="agent-doing" title={doing}>
                    {doing}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {hidden > 0 && (
        // Said rather than silently omitted: the rows are gone because they
        // finished, which is different from the session never having had them.
        <p className="muted">{hidden} finished earlier</p>
      )}
    </div>
  );
}
