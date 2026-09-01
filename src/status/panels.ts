/**
 * VIEW-01 — panels the user arranges, and nothing the implementation privileges.
 *
 * The last clause is the hard one and it is a claim about the CODE, not about
 * the UI: before this, the map was `<main>` and everything else lived in a
 * fixed three-section `<aside>`. Even if that had grown drag handles, the map
 * would still have been structurally special — unmovable, unhideable, and the
 * only panel the layout was built around.
 *
 * So layout here is DATA. An `Arrangement` says which panels sit in which
 * region and in what order; the renderer walks it. The map is an entry in a
 * list, it can be sent to the side or hidden entirely, and no code path asks
 * whether a panel happens to be the map.
 *
 * ## Why a stored arrangement is a preference, not a schema
 *
 * Everything interesting here is in `reconcile`. A layout persisted by an
 * earlier release will not mention panels added since; one written by a later
 * release may mention panels this build has never heard of. The naive
 * implementations both fail in the same quiet way — a new panel that never
 * appears, or a crash on a name nothing can render — so the stored value is
 * treated as a set of *hints* about panels this build knows, never as the list
 * of panels that exist.
 */

export type Region = "main" | "side";

export type PanelId = "map" | "agents" | "files" | "legend";

export interface PanelSpec {
  id: PanelId;
  title: string;
  /**
   * Where it lands before anyone has an opinion, and how much room it asks for.
   *
   * A default, never a privilege: the weight is what the panel gets IF it is in
   * a region, and every panel can be in every region.
   */
  defaultRegion: Region;
  defaultWeight: number;
}

/**
 * Every panel this build can render. Order here is the default order.
 *
 * Adding one is a one-line change and existing users get it automatically —
 * `reconcile` appends panels a stored arrangement does not mention rather than
 * treating their absence as "hidden".
 */
export const PANELS: readonly PanelSpec[] = [
  { id: "map", title: "Repo map", defaultRegion: "main", defaultWeight: 3 },
  { id: "agents", title: "Agents", defaultRegion: "side", defaultWeight: 1 },
  { id: "files", title: "Files", defaultRegion: "side", defaultWeight: 2 },
  { id: "legend", title: "Legend", defaultRegion: "side", defaultWeight: 0 },
];

const KNOWN = new Set<string>(PANELS.map((p) => p.id));
const spec = (id: PanelId): PanelSpec => PANELS.find((p) => p.id === id) as PanelSpec;

export interface Arrangement {
  main: PanelId[];
  side: PanelId[];
  /** Order is retained so unhiding can restore a sensible position. */
  hidden: PanelId[];
}

export function defaultArrangement(): Arrangement {
  return {
    main: PANELS.filter((p) => p.defaultRegion === "main").map((p) => p.id),
    side: PANELS.filter((p) => p.defaultRegion === "side").map((p) => p.id),
    hidden: [],
  };
}

const asIds = (value: unknown): PanelId[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is PanelId => typeof v === "string" && KNOWN.has(v));
};

/**
 * Turn whatever was stored into an arrangement this build can render.
 *
 * Guarantees, each of which is a bug someone has shipped:
 *   - every known panel appears exactly once, across all three lists
 *   - a panel the stored value never mentions is APPENDED to its default
 *     region, not silently hidden — otherwise a panel added in a new release is
 *     invisible to every existing user and looks like it was never built
 *   - a name this build does not know is dropped rather than thrown on
 *   - a duplicate keeps its first position
 *   - anything unparseable falls back to the default rather than to empty
 */
export function reconcile(stored: unknown): Arrangement {
  if (typeof stored !== "object" || stored === null) return defaultArrangement();
  const raw = stored as Record<string, unknown>;

  const seen = new Set<PanelId>();
  const take = (value: unknown): PanelId[] => {
    const out: PanelId[] = [];
    for (const id of asIds(value)) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  };

  const arrangement: Arrangement = {
    main: take(raw.main),
    side: take(raw.side),
    hidden: take(raw.hidden),
  };

  // Nothing recognisable in there at all — a corrupt or foreign value, not a
  // deliberate "hide everything".
  if (seen.size === 0) return defaultArrangement();

  for (const panel of PANELS) {
    if (!seen.has(panel.id)) arrangement[panel.defaultRegion].push(panel.id);
  }
  return arrangement;
}

const without = (ids: PanelId[], id: PanelId): PanelId[] => ids.filter((x) => x !== id);

/** Where a panel currently lives. */
export function regionOf(a: Arrangement, id: PanelId): Region | "hidden" {
  if (a.main.includes(id)) return "main";
  if (a.side.includes(id)) return "side";
  return "hidden";
}

/** Put a panel in a region, optionally at a position. Visible either way. */
export function move(a: Arrangement, id: PanelId, region: Region, index?: number): Arrangement {
  if (!KNOWN.has(id)) return a;
  const next: Arrangement = {
    main: without(a.main, id),
    side: without(a.side, id),
    hidden: without(a.hidden, id),
  };
  const target = next[region];
  const at = index === undefined ? target.length : Math.max(0, Math.min(index, target.length));
  target.splice(at, 0, id);
  return next;
}

/**
 * Nudge a panel within its own region.
 *
 * A no-op at the ends rather than wrapping: a control that jumps a panel from
 * top to bottom because it was already at the top is a control people stop
 * trusting.
 */
export function reorder(a: Arrangement, id: PanelId, delta: number): Arrangement {
  const region = regionOf(a, id);
  if (region === "hidden") return a;
  const list = a[region];
  const from = list.indexOf(id);
  const to = from + delta;
  if (to < 0 || to >= list.length) return a;
  return move(a, id, region, to);
}

/**
 * Hide or restore a panel.
 *
 * Restoring returns it to its DEFAULT region rather than wherever it was: the
 * alternative is remembering a position that may no longer exist, and a panel
 * reappearing somewhere plausible beats one reappearing somewhere surprising.
 */
export function setHidden(a: Arrangement, id: PanelId, hidden: boolean): Arrangement {
  if (!KNOWN.has(id)) return a;
  if (hidden) {
    if (regionOf(a, id) === "hidden") return a;
    return {
      main: without(a.main, id),
      side: without(a.side, id),
      hidden: [...a.hidden, id],
    };
  }
  if (regionOf(a, id) !== "hidden") return a;
  return move(a, id, spec(id).defaultRegion);
}

/** Visible panels in a region, in order. */
export const panelsIn = (a: Arrangement, region: Region): PanelId[] => [...a[region]];

/**
 * Total default weight of a region, for sizing it against the other.
 *
 * Computed from whatever is actually in the region — which is what keeps the
 * map from being privileged. Move it to the side and the side becomes the big
 * one; the layout follows the arrangement rather than the other way round.
 */
export function weightOf(a: Arrangement, region: Region): number {
  return a[region].reduce((sum, id) => sum + spec(id).defaultWeight, 0);
}

export const titleOf = (id: PanelId): string => spec(id).title;

/** True when the user has hidden everything — a state the view must render. */
export const allHidden = (a: Arrangement): boolean => a.main.length === 0 && a.side.length === 0;

/** Serialised form. Deliberately just the arrangement; specs live in code. */
export const serialise = (a: Arrangement): string => JSON.stringify(a);
