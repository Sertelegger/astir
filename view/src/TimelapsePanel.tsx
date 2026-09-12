/**
 * VIEW-11 — how the work spread, replayed over a fixed map.
 *
 * ## Two decisions that are the whole design
 *
 * **The geometry is computed once, from the final totals.** VIEW-11 says "over
 * the same fixed layout", and VIEW-10 already establishes why: `layout()` takes
 * paths and totals and nothing else, so the map cannot reflow as a colour scale
 * changes. Laying out each step from its own totals would make the map boil
 * during playback — tiles appearing, resizing and shuffling — which is
 * animation of the container rather than of the data.
 *
 * **The denominator is the final maximum, not each step's own.** Totals only
 * ever increase, so normalising a step against its own max would make a file
 * that stopped being touched appear to *cool* as others caught up. Nothing
 * cooled; it is the same lie as v1's heat normalisation, one layer up. Against
 * a fixed denominator a tile only ever brightens, which is what actually
 * happened.
 */

import { type JSX, useMemo, useState } from "react";
import { layout, type Sized } from "../../src/status/layout";
import { css, labelOn, ramp } from "../../src/status/ramp";
import { cumulative, type ProgressionState } from "./useProgression";

export interface TimelapsePanelProps {
  state: ProgressionState;
  onRefresh: () => void;
  /** Where the session runs, when it is not here. Names the machine to ask. */
  host: string | null;
}

const WIDTH = 720;
const HEIGHT = 360;

export function TimelapsePanel(props: TimelapsePanelProps): JSX.Element {
  const [step, setStep] = useState<number | null>(null);

  const ready = props.state.status === "ready" ? props.state.progression : null;
  const frames = useMemo(() => (ready === null ? [] : cumulative(ready)), [ready]);

  const geometry = useMemo(() => {
    const final = frames.at(-1);
    if (final === undefined) return { tiles: [], max: 0 };
    const files: Sized[] = Object.entries(final).map(([path, total]) => ({ path, total }));
    return {
      tiles: layout(files, { x: 0, y: 0, w: WIDTH, h: HEIGHT }).tiles,
      // Fixed for the whole replay. See the note at the top of this file.
      max: Math.max(...Object.values(final), 1),
    };
  }, [frames]);

  if (props.state.status === "loading") return <p className="quiet">Reading the progression…</p>;

  if (props.state.status === "elsewhere") {
    // Not an error, and not an empty timelapse — the honest answer is that this
    // daemon does not have the data and which machine does.
    return (
      <p className="quiet">
        This session runs {props.host === null ? "on another machine" : `on ${props.host}`}, and its
        progression lives with the daemon watching it. Astir cannot fetch it from here yet.
      </p>
    );
  }

  if (props.state.status === "failed") {
    return (
      <p className="quiet">
        Could not read the progression — {props.state.detail}.{" "}
        <button type="button" className="linkish" onClick={props.onRefresh}>
          try again
        </button>
      </p>
    );
  }

  if (ready === null || frames.length === 0) {
    return (
      <p className="quiet">
        Nothing sampled yet. The progression seals an interval every 30 seconds, so a session that has just
        started has no shape to show.
      </p>
    );
  }

  // Null means "the end", so a freshly opened panel shows the finished picture
  // rather than an empty first interval.
  const at = step ?? frames.length - 1;
  const totals = frames[at] ?? {};
  const elapsed = ready.spanMs - (ready.steps[at]?.agoMs ?? 0);

  return (
    <div className="timelapse">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="timelapse-map"
        role="img"
        aria-label="Work over time"
      >
        {geometry.tiles.map((tile) => {
          // A file with no touches YET is drawn as an empty frame rather than
          // omitted: its absence at this step is information, and a tile that
          // pops into existence would reflow the eye even though the geometry
          // did not move.
          const total = totals[tile.path] ?? 0;
          const fill = total === 0 ? "transparent" : css(ramp(total / geometry.max));
          return (
            <g key={tile.path}>
              <title>{`${tile.path} · ${total}`}</title>
              <rect
                x={tile.x}
                y={tile.y}
                width={Math.max(0, tile.w - 1)}
                height={Math.max(0, tile.h - 1)}
                fill={fill}
                stroke="#23232d"
                strokeWidth={0.5}
              />
              {tile.w > 46 && tile.h > 14 && total > 0 && (
                <text
                  x={tile.x + 4}
                  y={tile.y + 12}
                  fontSize={9}
                  fill={css(labelOn(ramp(total / geometry.max)))}
                >
                  {tile.path.split("/").at(-1)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      <div className="timelapse-controls">
        <input
          type="range"
          min={0}
          max={frames.length - 1}
          value={at}
          aria-label="Position in the session"
          onChange={(e) => setStep(Number(e.currentTarget.value))}
        />
        {/* The numbers a slider alone cannot convey, and the accessible reading
            of it (VIEW-07): position, elapsed time, and how much was touched. */}
        <p className="timelapse-read">
          step {at + 1} of {frames.length} · {Math.round(elapsed / 60_000)} min in ·{" "}
          {Object.keys(totals).length} of {geometry.tiles.length} files touched
        </p>
      </div>
    </div>
  );
}
