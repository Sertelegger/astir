import type { JSX } from "react";
import { type FileFrame, type FrameCounters, type MapMode, shades } from "../../src/status/frames";
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
      <h2>{props.mode === "live" ? "Hottest now" : "Most touched"}</h2>
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
 * the one where dropped data simply never appears. Rendered only when there is
 * something to admit, and it stays for the rest of the session once shown.
 */
export function Honesty({ counters }: { counters: FrameCounters }): JSX.Element | null {
  const { droppedPaths, rejected } = counters;
  if (droppedPaths === 0 && rejected === 0) return null;
  const parts = [
    droppedPaths > 0 ? `${droppedPaths} path${droppedPaths === 1 ? "" : "s"} dropped` : null,
    rejected > 0 ? `${rejected} event${rejected === 1 ? "" : "s"} rejected` : null,
  ].filter((p): p is string => p !== null);

  return (
    <div className="honesty" role="status">
      <strong>Incomplete</strong> — {parts.join(", ")}. This map is missing work that happened.
    </div>
  );
}
