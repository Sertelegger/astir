// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { overview } from "../src/status/overview.js";
import type { StatusAgent, StatusBody, StatusSession } from "../src/status/types.js";
import { Overview } from "../view/src/Overview.js";

afterEach(cleanup);

const agent = (over: Partial<StatusAgent> = {}): StatusAgent => ({
  id: "a1",
  state: "thinking",
  agentType: null,
  activeMs: 0,
  blockedMs: 0,
  inStateMs: 4_000,
  acknowledged: false,
  ...over,
});

const session = (over: Partial<StatusSession> = {}): StatusSession => ({
  sessionId: "s1",
  cwd: "/p/repo",
  name: null,
  status: "busy",
  pid: 1,
  agents: [agent()],
  ...over,
});

const show = (body: Partial<StatusBody>, onOpen: (id: string) => void = () => {}) =>
  render(
    <Overview
      sessions={overview({ blockedCount: 0, sessions: [], ...body })}
      receivedAt={0}
      now={0}
      onOpen={onOpen}
      reachable={true}
    />,
  );

describe("VIEW-09 — the overview renders what needs a human first", () => {
  it("renders the blocked agent's session first, out of three", () => {
    // The spec's own test, end to end through the component.
    const view = show({
      sessions: [
        session({ sessionId: "a", cwd: "/p/alpha", agents: [agent({ state: "idle" })] }),
        session({ sessionId: "b", cwd: "/p/beta", agents: [agent({ state: "tool-running" })] }),
        session({ sessionId: "c", cwd: "/p/gamma", agents: [agent({ state: "blocked" })] }),
      ],
    });

    const projects = [...view.container.querySelectorAll(".project")].map((n) => n.textContent);
    // gamma is blocked, beta is working, alpha is idle — in that order, and
    // deliberately the reverse of the order they were passed in.
    expect(projects).toEqual(["gamma", "beta", "alpha"]);
    expect(view.container.querySelector(".session")?.className).toContain("blocked");
  });

  it("says how many are waiting, at the top, in words", () => {
    const view = show({
      sessions: [
        session({ sessionId: "a", cwd: "/p/a", agents: [agent({ state: "blocked" })] }),
        session({ sessionId: "b", cwd: "/p/b", agents: [agent({ state: "blocked" })] }),
      ],
    });
    expect(view.container.textContent).toContain("2 agents");
    expect(view.container.textContent).toContain("waiting on you");
  });

  it("gets the singular right for one", () => {
    const view = show({ sessions: [session({ agents: [agent({ state: "blocked" })] })] });
    expect(view.container.textContent).toContain("1 agent waiting on you");
  });

  it("stays quiet when nothing needs you", () => {
    const view = show({ sessions: [session()] });
    expect(view.container.querySelector(".waiting-banner")).toBeNull();
  });

  it("shows every agent across every session, with what it is doing", () => {
    const view = show({
      sessions: [
        session({
          sessionId: "a",
          cwd: "/p/a",
          agents: [
            agent({ id: "m", tool: "Edit", toolPath: "src/a.ts" }),
            agent({ id: "x", agentType: "Explore", description: "Find the leak" }),
          ],
        }),
        session({ sessionId: "b", cwd: "/p/b", agents: [agent({ id: "n", state: "waiting" })] }),
      ],
    });
    const text = view.container.textContent ?? "";
    expect(view.container.querySelectorAll(".session-agents li")).toHaveLength(3);
    expect(text).toContain("Edit src/a.ts");
    expect(text).toContain("Find the leak");
  });
});

describe("VIEW-09 — it does not hide what it cannot see", () => {
  it("lists a silent session and says why it is quiet", () => {
    const view = show({
      sessions: [session({ sessionId: "live", cwd: "/p/a" })],
      silent: [{ sessionId: "q", cwd: "/p/quiet", name: null }],
    });
    const text = view.container.textContent ?? "";
    expect(text).toContain("quiet");
    expect(text).toContain("Not connected");
  });

  it("marks a remote session we have lost contact with", () => {
    const view = show({
      remote: [
        {
          host: "builder",
          sessionId: "r",
          cwd: "/srv/thing",
          name: null,
          status: null,
          source: "push",
          lastSeen: 1,
          stale: true,
        },
      ],
    });
    const text = view.container.textContent ?? "";
    expect(text).toContain("builder");
    expect(text).toContain("Contact lost");
  });

  it("distinguishes an unreachable daemon from nothing running", () => {
    // Rendering these identically is the same class of lie as showing a dead
    // daemon as idle.
    const dead = render(
      <Overview sessions={[]} receivedAt={0} now={0} onOpen={() => {}} reachable={false} />,
    );
    expect(dead.container.textContent).toContain("Cannot reach");
    cleanup();

    const empty = render(
      <Overview sessions={[]} receivedAt={0} now={0} onOpen={() => {}} reachable={true} />,
    );
    expect(empty.container.textContent).toContain("No sessions running");
  });
});

describe("VIEW-08 — a session is a click away", () => {
  it("opens the session that was clicked", () => {
    const opened: string[] = [];
    const view = show(
      {
        sessions: [
          session({ sessionId: "first", cwd: "/p/a", agents: [agent({ state: "blocked" })] }),
          session({ sessionId: "second", cwd: "/p/b" }),
        ],
      },
      (id) => opened.push(id),
    );

    const rows = view.container.querySelectorAll<HTMLButtonElement>(".session-head");
    rows[1]?.click();
    expect(opened).toEqual(["second"]);
  });

  it("makes every session reachable by keyboard, not just by mouse", () => {
    const view = show({
      sessions: [session({ sessionId: "a", cwd: "/p/a" }), session({ sessionId: "b", cwd: "/p/b" })],
    });
    const heads = view.container.querySelectorAll(".session-head");
    expect(heads).toHaveLength(2);
    for (const h of heads) expect(h.tagName).toBe("BUTTON");
  });

  it("advances agent clocks between polls", () => {
    // Same reason the rail does: /state is polled, and a duration that only
    // moves when a poll lands looks frozen between them.
    const rows = overview({
      blockedCount: 0,
      sessions: [session({ agents: [agent({ inStateMs: 5_000 })] })],
    });
    const view = render(
      <Overview sessions={rows} receivedAt={1_000} now={1_000} onOpen={() => {}} reachable={true} />,
    );
    expect(view.container.querySelector(".session-agents .num")?.textContent).toBe("5s");

    view.rerender(
      <Overview sessions={rows} receivedAt={1_000} now={61_000} onOpen={() => {}} reachable={true} />,
    );
    expect(view.container.querySelector(".session-agents .num")?.textContent).toBe("1m 5s");
  });

  it("keeps element identity as sessions reorder around them", () => {
    // VIEW-03 — a session row that remounts every poll cannot be clicked
    // reliably, and the overview polls every two seconds.
    const first = overview({
      blockedCount: 0,
      sessions: [
        session({ sessionId: "a", cwd: "/p/alpha", agents: [agent({ state: "tool-running" })] }),
        session({ sessionId: "b", cwd: "/p/beta", agents: [agent({ state: "idle" })] }),
      ],
    });
    const view = render(
      <Overview sessions={first} receivedAt={0} now={0} onOpen={() => {}} reachable={true} />,
    );
    const alpha = view.container.querySelector(".session");

    // Now beta blocks and jumps to the top.
    const second = overview({
      blockedCount: 1,
      sessions: [
        session({ sessionId: "a", cwd: "/p/alpha", agents: [agent({ state: "tool-running" })] }),
        session({ sessionId: "b", cwd: "/p/beta", agents: [agent({ state: "blocked" })] }),
      ],
    });
    view.rerender(
      <Overview sessions={second} receivedAt={0} now={0} onOpen={() => {}} reachable={true} />,
    );

    expect(view.container.querySelector(".project")?.textContent, "beta led").toBe("beta");
    const rows = [...view.container.querySelectorAll(".session")];
    expect(rows[1], "alpha is the same node, moved").toBe(alpha);
  });
});
