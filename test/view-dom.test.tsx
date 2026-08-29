// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FileFrame } from "../src/status/frames.js";
import { Agents, Honesty, Hottest, Legend } from "../view/src/Sidebar.js";

afterEach(cleanup);

const DECAY = { halfLifeMs: 300_000, referenceHeat: 2, idleFloor: 0.05 };

const file = (path: string, total: number, heat = total, ageMs = 0): FileFrame => ({
  path,
  total,
  heat,
  ageMs,
});

const props = (files: FileFrame[], over: Partial<Parameters<typeof Hottest>[0]> = {}) => ({
  files,
  decay: DECAY,
  mode: "live" as const,
  elapsed: 0,
  selected: null,
  onSelect: () => {},
  ...over,
});

describe("VIEW-03 — updating must not destroy and recreate the DOM", () => {
  it("keeps the same element for a file across a frame", () => {
    // The spec's own test. If React remounts rows, everything below — scroll,
    // focus, text selection — is lost on every frame, which for a surface that
    // updates once a second means it can never be interacted with at all.
    const first = [file("src/a.ts", 3), file("src/b.ts", 1)];
    const view = render(<Hottest {...props(first)} />);
    const before = view.container.querySelector('[title="src/a.ts"]');

    view.rerender(<Hottest {...props([file("src/a.ts", 9), file("src/b.ts", 1)])} />);
    const after = view.container.querySelector('[title="src/a.ts"]');

    expect(before).not.toBeNull();
    expect(after).toBe(before); // the SAME node, not an equal one
  });

  it("keeps identity even when the ranking reorders", () => {
    // Reordering is where a key-less list silently recycles nodes and swaps
    // their contents — every element survives, and every one is now wrong.
    const view = render(<Hottest {...props([file("a.ts", 9), file("b.ts", 1)])} />);
    const a = view.container.querySelector('[title="a.ts"]');
    const b = view.container.querySelector('[title="b.ts"]');

    view.rerender(<Hottest {...props([file("a.ts", 9, 0.01, 600_000), file("b.ts", 40)])} />);

    expect(view.container.querySelector('[title="a.ts"]')).toBe(a);
    expect(view.container.querySelector('[title="b.ts"]')).toBe(b);
    // …and the reorder actually happened, so this is not passing trivially.
    const order = [...view.container.querySelectorAll(".path")].map((n) => n.textContent);
    expect(order[0]).toBe("b.ts");
  });

  it("preserves scroll position across a frame", () => {
    const many = Array.from({ length: 25 }, (_, i) => file(`src/f${i}.ts`, 25 - i));
    const view = render(<Hottest {...props(many)} />);
    const list = view.container.querySelector("ol") as HTMLElement;

    list.scrollTop = 120;
    view.rerender(<Hottest {...props(many.map((f) => file(f.path, f.total + 1)))} />);

    // Re-QUERY rather than reuse the reference: a detached node keeps its
    // scrollTop, so asserting on the old handle would pass even if React had
    // replaced the list entirely — which is the failure being tested for.
    const after = view.container.querySelector("ol") as HTMLElement;
    expect(after).toBe(list);
    expect(after.scrollTop).toBe(120);
  });

  it("preserves keyboard focus across a frame", () => {
    // VIEW-07 — the list IS the map for anyone using a keyboard. Losing focus
    // every second makes it unusable in exactly the case it exists to serve.
    const many = Array.from({ length: 6 }, (_, i) => file(`f${i}.ts`, 6 - i));
    const view = render(<Hottest {...props(many)} />);
    const target = view.container.querySelectorAll("button")[2] as HTMLButtonElement;
    target.focus();

    view.rerender(<Hottest {...props(many.map((f) => file(f.path, f.total + 2)))} />);

    expect(document.activeElement).toBe(target);
  });
});

describe("VIEW-07 — the map's fallback is real, reachable UI", () => {
  it("renders every file as a focusable control, not a decoration", () => {
    const view = render(<Hottest {...props([file("a.ts", 2), file("b.ts", 1)])} />);
    const buttons = view.container.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    for (const b of buttons) expect(b.tagName).toBe("BUTTON");
  });

  it("labels each row with its full path, not just the filename", () => {
    const view = render(<Hottest {...props([file("src/deep/nested/thing.ts", 2)])} />);
    expect(view.container.querySelector('[title="src/deep/nested/thing.ts"]')).not.toBeNull();
  });

  it("says so plainly when nothing has been touched", () => {
    const view = render(<Hottest {...props([])} />);
    expect(view.container.textContent).toContain("No files touched yet");
  });

  it("shows cumulative totals in session mode and heat in live mode", () => {
    const files = [file("early.ts", 20, 0.001, 3_600_000)];
    const live = render(<Hottest {...props(files)} />);
    expect(live.container.querySelector(".num")?.textContent).toBe("0.0");
    cleanup();

    const session = render(<Hottest {...props(files, { mode: "session" })} />);
    expect(session.container.querySelector(".num")?.textContent).toBe("20");
  });
});

describe("VIEW-04 — the legend says what the colours mean", () => {
  it("labels both ends, and differently per mode", () => {
    const live = render(<Legend mode="live" />);
    expect(live.container.textContent).toContain("idle");
    expect(live.container.textContent).toContain("active now");
    cleanup();

    const session = render(<Legend mode="session" />);
    expect(session.container.textContent).toContain("most touched");
    expect(session.container.textContent).not.toContain("active now");
  });

  it("explains that area is not the same channel as colour", () => {
    const view = render(<Legend mode="live" />);
    expect(view.container.textContent).toMatch(/area/i);
  });
});

describe("VIEW-06 — the view admits what it is missing", () => {
  it("stays silent when nothing was dropped", () => {
    const view = render(<Honesty counters={{ pathsOutsideRepo: 0, invalidEvents: 0 }} />);
    expect(view.container.textContent).toBe("");
  });

  it("does not call an out-of-repo path a malfunction", () => {
    // The wording that shipped read "Incomplete — 7 paths dropped. This map is
    // missing work that happened." for a session whose agent had merely read a
    // file outside the repo. Alarming, unactionable, and it spends on a
    // non-event the credibility the banner needs for a real gap.
    const view = render(<Honesty counters={{ pathsOutsideRepo: 7, invalidEvents: 0 }} />);
    const text = view.container.textContent ?? "";

    expect(text).toContain("7 paths outside this repo");
    expect(text).toContain("Nothing was lost");
    expect(text).not.toMatch(/incomplete/i);
    expect(view.container.querySelector(".honesty.note")).not.toBeNull();
    expect(view.container.querySelector(".honesty.warn")).toBeNull();
  });

  it("DOES warn when events could not be read, which is a real gap", () => {
    const view = render(<Honesty counters={{ pathsOutsideRepo: 0, invalidEvents: 2 }} />);
    const text = view.container.textContent ?? "";

    expect(text).toMatch(/incomplete/i);
    expect(text).toContain("2 events could not be read");
    expect(text).toContain("missing work that happened");
    expect(view.container.querySelector(".honesty.warn")).not.toBeNull();
  });

  it("leads with the fault when both are present", () => {
    const view = render(<Honesty counters={{ pathsOutsideRepo: 7, invalidEvents: 1 }} />);
    expect(view.container.querySelector(".honesty.warn")).not.toBeNull();
    expect(view.container.textContent).toContain("7 paths fell outside this repo");
  });

  it("gets its singulars right", () => {
    const one = render(<Honesty counters={{ pathsOutsideRepo: 1, invalidEvents: 0 }} />);
    expect(one.container.textContent).toContain("1 path outside this repo is not on the map");
    cleanup();
    const many = render(<Honesty counters={{ pathsOutsideRepo: 2, invalidEvents: 0 }} />);
    expect(many.container.textContent).toContain("2 paths outside this repo are not");
  });

  it("is announced to assistive technology rather than only drawn", () => {
    const view = render(<Honesty counters={{ pathsOutsideRepo: 2, invalidEvents: 0 }} />);
    expect(view.container.querySelector('[role="status"]')).not.toBeNull();
  });
});

/* ── the agent rail ──────────────────────────────────────────────────────── */

const agentFrame = (over: Partial<Parameters<typeof Agents>[0]["agents"][number]> = {}) => ({
  id: "a1",
  agentType: null,
  state: "thinking",
  activeMs: 0,
  blockedMs: 0,
  inStateMs: 0,
  turnMs: 0,
  acknowledged: false,
  ...over,
});

describe("the agent rail says what is happening now", () => {
  it("does not list every agent that has ever finished", () => {
    // What the view actually did: a daemon up for days rendered a wall of
    // "done" rows, burying the one agent still working.
    const agents = [
      agentFrame({ id: "live", state: "tool-running", inStateMs: 4_000 }),
      ...Array.from({ length: 12 }, (_, i) =>
        agentFrame({ id: `old${i}`, state: "done", inStateMs: 232_129_000 }),
      ),
    ];
    const view = render(<Agents agents={agents} receivedAt={0} now={0} />);

    expect(view.container.querySelectorAll("li")).toHaveLength(1);
    expect(view.container.textContent).toContain("tool-running");
  });

  it("says how many it retired, rather than silently omitting them", () => {
    // "Gone because they finished" and "this session never had them" are
    // different facts, and the surface should not merge them.
    const agents = [
      agentFrame({ id: "live", state: "thinking", inStateMs: 1_000 }),
      agentFrame({ id: "old", state: "done", inStateMs: 600_000 }),
      agentFrame({ id: "old2", state: "done", inStateMs: 600_000 }),
    ];
    const view = render(<Agents agents={agents} receivedAt={0} now={0} />);
    expect(view.container.textContent).toContain("2 finished earlier");
  });

  it("keeps a recently finished agent, so it is there when you look back", () => {
    const view = render(
      <Agents agents={[agentFrame({ state: "done", inStateMs: 3_000 })]} receivedAt={0} now={0} />,
    );
    expect(view.container.querySelectorAll("li")).toHaveLength(1);
  });

  it("renders a readable duration, not a raw second count", () => {
    // The bug on screen was `232129s`.
    const view = render(
      <Agents
        agents={[agentFrame({ state: "error", inStateMs: 232_129_000 })]}
        receivedAt={0}
        now={0}
      />,
    );
    expect(view.container.querySelector(".num")?.textContent).toBe("2d 16h");
  });

  it("ADVANCES the clock between frames, which is what `Live` promises", () => {
    // The daemon deliberately does not send a frame merely because a timer
    // moved, so a client that renders `inStateMs` verbatim shows a number
    // frozen at the last real change — under a label vouching for it.
    const agents = [agentFrame({ state: "thinking", inStateMs: 5_000 })];
    const view = render(<Agents agents={agents} receivedAt={1_000} now={1_000} />);
    expect(view.container.querySelector(".num")?.textContent).toBe("5s");

    view.rerender(<Agents agents={agents} receivedAt={1_000} now={41_000} />);
    expect(view.container.querySelector(".num")?.textContent).toBe("45s");
  });

  it("never shows a negative age if the clocks disagree", () => {
    const view = render(
      <Agents agents={[agentFrame({ inStateMs: 5_000 })]} receivedAt={9_000} now={1_000} />,
    );
    expect(view.container.querySelector(".num")?.textContent).toBe("5s");
  });

  it("says nothing is running rather than showing an empty box", () => {
    const view = render(<Agents agents={[]} receivedAt={0} now={0} />);
    expect(view.container.textContent).toContain("Nothing running");
  });
});
