import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Arrangement,
  defaultArrangement,
  move,
  type PanelId,
  type Region,
  reconcile,
  reorder,
  serialise,
  setHidden,
} from "../../src/status/panels";

/**
 * VIEW-01 — the arrangement, remembered.
 *
 * ## Why this is keyed by PROJECT and not by session
 *
 * A session id is minted per run. Keying a saved layout by one means it is
 * never restored: you arrange the panels, the session ends, and the next
 * session — same repo, same work — has a different id and gets the default
 * back. The persistence would technically exist and never once do anything.
 *
 * A project path is stable across sessions and restarts, and it is also the
 * grain people actually want: a small library and a large monorepo do not want
 * the same layout. It satisfies VIEW-08's "switching preserves each one's
 * arrangement" for the case that matters — two sessions in different projects —
 * and two sessions in the SAME project sharing a layout is right rather than a
 * compromise.
 */
const KEY_PREFIX = "astir.panels.v1:";

const keyFor = (project: string): string => `${KEY_PREFIX}${project}`;

function load(project: string | null): Arrangement {
  if (project === null) return defaultArrangement();
  try {
    const raw = window.localStorage.getItem(keyFor(project));
    // `reconcile` handles null, garbage, unknown panels and missing ones.
    return reconcile(raw === null ? null : JSON.parse(raw));
  } catch {
    // Private mode, disabled storage, or a value that is not JSON at all.
    return defaultArrangement();
  }
}

export interface Panels {
  arrangement: Arrangement;
  move: (id: PanelId, region: Region, index?: number) => void;
  nudge: (id: PanelId, delta: number) => void;
  hide: (id: PanelId, hidden: boolean) => void;
  reset: () => void;
  /** Which project's layout this is, or null before one is known. */
  project: string | null;
}

export function usePanels(project: string | null): Panels {
  const [arrangement, setArrangement] = useState<Arrangement>(() => load(project));

  // The live value and the project it belongs to, read by the actions below.
  // A ref rather than the state variable so an action never computes from a
  // closure captured before the last change, and never persists under the key
  // of a project the user has already switched away from.
  const current = useRef(arrangement);
  const owner = useRef(project);
  /** Whether the user has arranged anything since the last load. */
  const touched = useRef(false);

  const persist = useCallback((target: string | null, value: Arrangement) => {
    if (target === null) return; // nothing to key it by yet; keep it in memory
    try {
      window.localStorage.setItem(keyFor(target), serialise(value));
    } catch {
      // Storage full or unavailable. The arrangement still applies for this
      // session — losing the save is worth less than losing the interaction.
    }
  }, []);

  useEffect(() => {
    const previous = owner.current;
    owner.current = project;

    // The project becomes known a moment AFTER the view opens — it arrives with
    // the first frame. Someone who arranged a panel in that window has already
    // acted, and reloading over them here is a silent revert of something they
    // just did. So their arrangement is carried onto the project that turned
    // out to be current, and saved there.
    //
    // Only from `null`: moving between two real projects means the change was
    // already persisted under the old key, and the new project's own layout is
    // what should appear.
    if (touched.current && previous === null && project !== null) {
      persist(project, current.current);
      return;
    }

    const loaded = load(project);
    current.current = loaded;
    touched.current = false;
    setArrangement(loaded);
  }, [project, persist]);

  const commit = useCallback(
    (next: Arrangement) => {
      if (next === current.current) return; // a no-op, e.g. nudging past an end
      current.current = next;
      touched.current = true;
      setArrangement(next);
      persist(owner.current, next);
    },
    [persist],
  );

  return {
    arrangement,
    project,
    move: useCallback((id, region, index) => commit(move(current.current, id, region, index)), [commit]),
    nudge: useCallback((id, delta) => commit(reorder(current.current, id, delta)), [commit]),
    hide: useCallback((id, hidden) => commit(setHidden(current.current, id, hidden)), [commit]),
    reset: useCallback(() => commit(defaultArrangement()), [commit]),
  };
}
