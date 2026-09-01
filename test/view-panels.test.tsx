// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultArrangement, type PanelId, PANELS } from "../src/status/panels.js";
import { HiddenPanels, Panel } from "../view/src/Panel.js";
import { usePanels } from "../view/src/usePanels.js";

afterEach(cleanup);
beforeEach(() => window.localStorage.clear());

/** Drives the hook from a component, since hooks need one. */
function harness(project: string | null) {
  const seen: Array<ReturnType<typeof usePanels>> = [];
  function Probe({ p }: { p: string | null }) {
    seen.push(usePanels(p));
    return null;
  }
  const view = render(<Probe p={project} />);
  return {
    view,
    get latest() {
      return seen[seen.length - 1] as ReturnType<typeof usePanels>;
    },
    rerender: (p: string | null) => view.rerender(<Probe p={p} />),
  };
}

describe("VIEW-01 — the arrangement is persisted", () => {
  it("survives a remount", () => {
    const h = harness("/repos/astir");
    act(() => h.latest.move("map", "side"));
    expect(h.latest.arrangement.side).toContain("map");
    cleanup();

    expect(harness("/repos/astir").latest.arrangement.side).toContain("map");
  });

  it("is keyed by PROJECT, so two projects keep their own layouts", () => {
    const h = harness("/repos/astir");
    act(() => h.latest.hide("legend", true));
    expect(h.latest.arrangement.hidden).toContain("legend");

    act(() => h.rerender("/repos/other"));
    expect(h.latest.arrangement.hidden, "a different project starts clean").toEqual([]);

    act(() => h.rerender("/repos/astir"));
    expect(h.latest.arrangement.hidden, "and switching back restores it").toContain("legend");
  });

  it("does NOT key by session id, which would never restore anything", () => {
    // A session id is minted per run, so a layout keyed by one is written and
    // never read again. This asserts the key is the project by showing that a
    // second, differently-identified visit to the same path sees the layout.
    const first = harness("/repos/astir");
    act(() => first.latest.move("agents", "main"));
    cleanup();

    const second = harness("/repos/astir");
    expect(second.latest.arrangement.main).toContain("agents");
  });

  it("holds an arrangement in memory before a project is known", () => {
    // The first frame has not arrived yet; arranging must still work rather
    // than silently reverting.
    const h = harness(null);
    act(() => h.latest.hide("map", true));
    expect(h.latest.arrangement.hidden).toContain("map");
  });

  it("carries an arrangement made BEFORE the project resolved", () => {
    // The project is only known once the first frame lands, so there is a
    // window in which someone can arrange a panel against a null project. The
    // effect that runs when it resolves used to reload over them — a silent
    // revert of something they had just done, a second earlier.
    //
    // CI caught this: the same test passed on node 20 and 24 and failed on 22,
    // purely because the ordering of the click and the frame differed.
    const h = harness(null);
    act(() => h.latest.hide("map", true));

    act(() => h.rerender("/repos/astir"));

    expect(h.latest.arrangement.hidden, "still hidden after the project arrived").toContain("map");
    // …and it was saved under the project that turned out to be current.
    expect(window.localStorage.getItem("astir.panels.v1:/repos/astir")).toContain("map");
  });

  it("does NOT carry it across two real projects", () => {
    // Switching sessions is different: the change was already saved under the
    // old key, and the new project's own layout is what should appear.
    const h = harness("/repos/astir");
    act(() => h.latest.hide("map", true));

    act(() => h.rerender("/repos/other"));
    expect(h.latest.arrangement.hidden).toEqual([]);
  });

  it("prefers a stored layout when the user has not touched anything", () => {
    // The carry-over must not fire for someone who simply opened the view.
    window.localStorage.setItem(
      "astir.panels.v1:/repos/astir",
      JSON.stringify({ main: [], side: ["map", "agents", "files"], hidden: ["legend"] }),
    );
    const h = harness(null);
    act(() => h.rerender("/repos/astir"));

    expect(h.latest.arrangement.hidden).toContain("legend");
    expect(h.latest.arrangement.side).toContain("map");
  });

  it("ignores a corrupt stored value instead of rendering nothing", () => {
    window.localStorage.setItem("astir.panels.v1:/repos/astir", "{not json");
    expect(harness("/repos/astir").latest.arrangement).toEqual(defaultArrangement());
  });

  it("survives storage being unavailable entirely", () => {
    // Private mode. Losing the save is worth less than losing the interaction.
    const real = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error("QuotaExceeded");
    };
    try {
      const h = harness("/repos/astir");
      act(() => h.latest.move("map", "side"));
      expect(h.latest.arrangement.side).toContain("map");
    } finally {
      window.localStorage.setItem = real;
    }
  });

  it("resets to the default", () => {
    const h = harness("/repos/astir");
    act(() => h.latest.hide("map", true));
    act(() => h.latest.reset());
    expect(h.latest.arrangement).toEqual(defaultArrangement());
  });

  it("composes two changes in one tick rather than losing the first", () => {
    const h = harness("/repos/astir");
    act(() => {
      h.latest.hide("legend", true);
      h.latest.move("map", "side");
    });
    expect(h.latest.arrangement.hidden).toContain("legend");
    expect(h.latest.arrangement.side).toContain("map");
  });
});

/* ── the chrome ──────────────────────────────────────────────────────────── */

const chrome = (over: Partial<Parameters<typeof Panel>[0]> = {}) => {
  const calls: string[] = [];
  const view = render(
    <Panel
      id="map"
      region="main"
      index={0}
      count={2}
      onMove={(id, r) => calls.push(`move:${id}:${r}`)}
      onNudge={(id, d) => calls.push(`nudge:${id}:${d}`)}
      onHide={(id) => calls.push(`hide:${id}`)}
      {...over}
    >
      <p>body</p>
    </Panel>,
  );
  return { view, calls };
};

const click = (view: ReturnType<typeof render>, label: string) =>
  view.container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.click();

describe("VIEW-01/07 — arranging is reachable without a mouse", () => {
  it("exposes every control as a labelled button", () => {
    // Drag handles are nicer and are the obvious visual-pass addition, but on
    // their own they are unreachable by keyboard and invisible to assistive
    // technology — so the accessible mechanism is the one that exists first.
    const { view } = chrome();
    for (const label of [
      "Move Repo map earlier",
      "Move Repo map later",
      "Move Repo map to the side region",
      "Hide Repo map",
    ]) {
      const button = view.container.querySelector(`[aria-label="${label}"]`);
      expect(button, label).not.toBeNull();
      expect(button?.tagName).toBe("BUTTON");
    }
  });

  it("reports which way it is moving", () => {
    const { view, calls } = chrome({ index: 1, count: 3 });
    click(view, "Move Repo map earlier");
    click(view, "Move Repo map later");
    click(view, "Move Repo map to the side region");
    click(view, "Hide Repo map");
    expect(calls).toEqual(["nudge:map:-1", "nudge:map:1", "move:map:side", "hide:map"]);
  });

  it("disables the nudge that would do nothing", () => {
    const first = chrome({ index: 0, count: 3 });
    expect(
      first.view.container.querySelector<HTMLButtonElement>('[aria-label="Move Repo map earlier"]')
        ?.disabled,
    ).toBe(true);
    cleanup();

    const last = chrome({ index: 2, count: 3 });
    expect(
      last.view.container.querySelector<HTMLButtonElement>('[aria-label="Move Repo map later"]')
        ?.disabled,
    ).toBe(true);
  });

  it("offers the OTHER region, whichever one it is in", () => {
    const side = chrome({ region: "side" });
    expect(
      side.view.container.querySelector('[aria-label="Move Repo map to the main region"]'),
    ).not.toBeNull();
  });

  it("gives every panel the identical chrome", () => {
    // The structural form of "no panel is privileged": if the map rendered its
    // own frame, its header would differ from the rest.
    for (const panel of PANELS) {
      const { view } = chrome({ id: panel.id });
      expect(view.container.querySelectorAll(".panel-head")).toHaveLength(1);
      expect(view.container.querySelectorAll(".panel-controls button")).toHaveLength(4);
      expect(view.container.querySelector(".panel-head h2")?.textContent, panel.id).toBe(
        panel.title,
      );
      cleanup();
    }
  });
});

describe("hiding has a visible way back", () => {
  it("renders nothing when nothing is hidden", () => {
    const view = render(<HiddenPanels hidden={[]} onShow={() => {}} onReset={() => {}} />);
    expect(view.container.textContent).toBe("");
  });

  it("offers each hidden panel by name, plus a reset", () => {
    const shown: PanelId[] = [];
    let reset = 0;
    const view = render(
      <HiddenPanels
        hidden={["map", "legend"]}
        onShow={(id) => shown.push(id)}
        onReset={() => {
          reset++;
        }}
      />,
    );
    const buttons = [...view.container.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons).toHaveLength(3); // two panels + reset

    buttons[0]?.click();
    buttons.at(-1)?.click();
    expect(shown).toEqual(["map"]);
    expect(reset).toBe(1);
  });
});
