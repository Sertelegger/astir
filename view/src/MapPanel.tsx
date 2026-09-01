import { type JSX, type MouseEvent, useEffect, useRef, useState } from "react";
import { type FileFrame, type MapMode, shades } from "../../src/status/frames";
import { layout, type Tile } from "../../src/status/layout";
import { css, labelOn, ramp } from "../../src/status/ramp";

export interface MapPanelProps {
  files: FileFrame[];
  decay: { halfLifeMs: number; referenceHeat: number; idleFloor: number };
  mode: MapMode;
  receivedAt: number;
  onSelect: (path: string) => void;
  selected: string | null;
}

interface Hover {
  path: string;
  value: number;
  total: number;
  x: number;
  y: number;
}

/**
 * The map, drawn on a canvas.
 *
 * Canvas rather than SVG or DOM nodes because the whole surface is repainted on
 * every animation frame — heat decays continuously between deltas, which is the
 * entire reason frames carry an age instead of a heat — and a thousand DOM nodes
 * restyled sixty times a second is a different order of cost from a thousand
 * `fillRect` calls.
 *
 * VIEW-03's "must not destroy and recreate the DOM" is satisfied trivially here:
 * there is one element and it is never replaced. The requirement has teeth for
 * the hottest-files list, which is real DOM and is keyed by path.
 */
export function MapPanel(props: MapPanelProps): JSX.Element {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<Hover | null>(null);
  // Read inside the animation loop, which must not be re-created per frame.
  const latest = useRef(props);
  latest.current = props;
  const tiles = useRef<Tile[]>([]);

  useEffect(() => {
    const el = wrap.current;
    if (el === null) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box !== undefined) setSize({ w: Math.floor(box.width), h: Math.floor(box.height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (el === null || size.w === 0 || size.h === 0) return;

    let frame = 0;
    const draw = (): void => {
      frame = window.requestAnimationFrame(draw);
      // VIEW-03 — a hidden tab renders nothing. Browsers throttle rAF already,
      // but throttling is not a guarantee and the work behind it still runs.
      if (document.hidden) return;

      const { files, decay, mode, receivedAt, selected } = latest.current;
      const ctx = el.getContext("2d");
      if (ctx === null) return;

      const dpr = window.devicePixelRatio || 1;
      const [w, h] = [size.w, size.h];
      if (el.width !== w * dpr || el.height !== h * dpr) {
        el.width = w * dpr;
        el.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Geometry from totals only, so it is identical in both modes (VIEW-10).
      const { tiles: placed, groups } = layout(files, { x: 0, y: 0, w, h });
      tiles.current = placed;

      const elapsed = mode === "live" ? performance.now() - receivedAt : 0;
      const shaded = new Map(shades(files, mode, elapsed, decay).map((s) => [s.path, s]));

      for (const g of groups) {
        ctx.strokeStyle = "rgb(60 60 68)";
        ctx.lineWidth = 1;
        ctx.strokeRect(g.x + 0.5, g.y + 0.5, Math.max(0, g.w - 1), Math.max(0, g.h - 1));
        if (g.h > 40 && g.w > 52) {
          ctx.fillStyle = "rgb(150 150 160)";
          ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
          ctx.fillText(clip(ctx, g.label, g.w - 8), g.x + 4, g.y + 10);
        }
      }

      for (const tile of placed) {
        if (tile.w < 1 || tile.h < 1) continue;
        const shade = shaded.get(tile.path);
        const intensity = shade?.intensity ?? 0;
        const fill = ramp(intensity);
        ctx.fillStyle = css(fill);
        ctx.fillRect(tile.x, tile.y, tile.w - 1, tile.h - 1);

        // VIEW-04 — heat is NOT encoded by colour alone. This bar carries the
        // same number as a LENGTH, which survives greyscale, a bad panel and
        // every form of colour-vision deficiency at once.
        const barW = Math.max(0, (tile.w - 3) * intensity);
        if (tile.h >= 8 && barW > 0.5) {
          ctx.fillStyle = "rgb(255 255 255 / 0.55)";
          ctx.fillRect(tile.x + 1, tile.y + tile.h - 4, barW, 2);
        }

        if (tile.path === selected) {
          ctx.strokeStyle = "rgb(120 220 255)";
          ctx.lineWidth = 2;
          ctx.strokeRect(tile.x + 1, tile.y + 1, Math.max(0, tile.w - 3), Math.max(0, tile.h - 3));
        }

        if (tile.w > 44 && tile.h > 18) {
          ctx.fillStyle = css(labelOn(fill));
          ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
          const name = tile.path.slice(tile.path.lastIndexOf("/") + 1);
          ctx.fillText(clip(ctx, name, tile.w - 8), tile.x + 3, tile.y + 12);
        }
      }
    };

    frame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(frame);
  }, [size]);

  const hit = (event: MouseEvent<HTMLCanvasElement>): Tile | null => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    // Last match wins: later tiles are drawn on top, so they are what was
    // actually clicked where rounding makes two rectangles share an edge.
    let found: Tile | null = null;
    for (const t of tiles.current) {
      if (x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h) found = t;
    }
    return found;
  };

  return (
    <div className="map" ref={wrap}>
      <canvas
        ref={canvas}
        style={{ width: "100%", height: "100%", display: "block" }}
        onMouseMove={(e) => {
          const tile = hit(e);
          if (tile === null) return setHover(null);
          const shade = shades(props.files, props.mode, 0, props.decay).find((s) => s.path === tile.path);
          const box = e.currentTarget.getBoundingClientRect();
          setHover({
            path: tile.path,
            value: shade?.value ?? 0,
            total: tile.total,
            x: e.clientX - box.left,
            y: e.clientY - box.top,
          });
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const tile = hit(e);
          if (tile !== null) props.onSelect(tile.path);
        }}
      />
      {hover !== null && (
        <div className="tooltip" style={{ left: Math.min(hover.x + 12, size.w - 240), top: hover.y + 12 }}>
          <div className="tooltip-path">{hover.path}</div>
          <div className="tooltip-nums">
            {props.mode === "live" ? "heat" : "touches"} {format(hover.value)} · {hover.total} total
          </div>
        </div>
      )}
    </div>
  );
}

const format = (n: number): string => (n >= 10 ? n.toFixed(0) : n.toFixed(2));

/** Trim to fit, with an ellipsis, so a label never spills over its neighbour. */
function clip(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (max <= 0) return "";
  if (ctx.measureText(text).width <= max) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > max) out = out.slice(0, -1);
  return `${out}…`;
}
