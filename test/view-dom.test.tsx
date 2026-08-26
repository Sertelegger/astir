// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FileFrame } from "../src/status/frames.js";
import { Honesty, Hottest, Legend } from "../view/src/Sidebar.js";

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
    const view = render(<Honesty counters={{ droppedPaths: 0, rejected: 0 }} />);
    expect(view.container.textContent).toBe("");
  });

  it("names the counts when something was", () => {
    const view = render(<Honesty counters={{ droppedPaths: 3, rejected: 1 }} />);
    expect(view.container.textContent).toContain("3 paths dropped");
    expect(view.container.textContent).toContain("1 event rejected");
  });

  it("is announced to assistive technology rather than only drawn", () => {
    const view = render(<Honesty counters={{ droppedPaths: 2, rejected: 0 }} />);
    expect(view.container.querySelector('[role="status"]')).not.toBeNull();
  });
});
