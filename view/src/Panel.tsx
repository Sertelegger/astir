import type { JSX, ReactNode } from "react";
import type { PanelId, Region } from "../../src/status/panels";
import { titleOf } from "../../src/status/panels";

export interface PanelProps {
  id: PanelId;
  region: Region;
  /** Position within its region, for enabling/disabling the nudge controls. */
  index: number;
  count: number;
  onMove: (id: PanelId, region: Region) => void;
  onNudge: (id: PanelId, delta: number) => void;
  onHide: (id: PanelId) => void;
  children: ReactNode;
}

/**
 * VIEW-01 — one panel, plus the controls that arrange it.
 *
 * Identical chrome for every panel, which is the point: the map gets the same
 * header, the same move/hide buttons and the same treatment as the legend. A
 * panel that rendered its own frame would be a panel the layout knows about.
 *
 * The controls are BUTTONS rather than drag handles. Dragging is nicer to use
 * and is the obvious thing to add in the visual pass, but on its own it is
 * unreachable by keyboard and invisible to assistive technology — so the
 * accessible mechanism is the one that exists first, not the one bolted on
 * afterwards (VIEW-07).
 */
export function Panel(props: PanelProps): JSX.Element {
  const { id, region, index, count } = props;
  const elsewhere: Region = region === "main" ? "side" : "main";
  const title = titleOf(id);

  return (
    <section className={`panel panel-${id}`} aria-label={title}>
      <header className="panel-head">
        <h2>{title}</h2>
        <div className="panel-controls">
          <button
            type="button"
            onClick={() => props.onNudge(id, -1)}
            disabled={index === 0}
            aria-label={`Move ${title} earlier`}
            title="Move earlier"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => props.onNudge(id, 1)}
            disabled={index === count - 1}
            aria-label={`Move ${title} later`}
            title="Move later"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={() => props.onMove(id, elsewhere)}
            aria-label={`Move ${title} to the ${elsewhere} region`}
            title={`Move to ${elsewhere}`}
          >
            {region === "main" ? "→" : "←"}
          </button>
          <button type="button" onClick={() => props.onHide(id)} aria-label={`Hide ${title}`} title="Hide">
            ✕
          </button>
        </div>
      </header>
      <div className="panel-body">{props.children}</div>
    </section>
  );
}

export interface HiddenPanelsProps {
  hidden: PanelId[];
  onShow: (id: PanelId) => void;
  onReset: () => void;
}

/**
 * The way back.
 *
 * Hiding every panel is allowed — refusing the last one would make whichever
 * panel happened to be last privileged, which is the thing VIEW-01 forbids. So
 * the restore affordance has to be outside the panels themselves, and it has to
 * be visible whenever anything is hidden rather than tucked behind a menu: a
 * layout you cannot undo is one people avoid touching at all.
 */
export function HiddenPanels(props: HiddenPanelsProps): JSX.Element | null {
  if (props.hidden.length === 0) return null;
  return (
    <div className="hidden-panels">
      <span className="muted">Hidden:</span>
      {props.hidden.map((id) => (
        <button key={id} type="button" onClick={() => props.onShow(id)}>
          {titleOf(id)} <span aria-hidden="true">+</span>
        </button>
      ))}
      <button type="button" className="reset" onClick={props.onReset}>
        Reset layout
      </button>
    </div>
  );
}
