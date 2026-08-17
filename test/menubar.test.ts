import { describe, expect, it } from "vitest";
import { renderMenubar } from "../src/status/menubar.js";
import type { StatusBody, StatusSession } from "../src/status/types.js";

const agent = (state: string, over: Partial<StatusBody["sessions"][0]["agents"][0]> = {}) => ({
  id: "a1",
  state,
  agentType: null,
  activeMs: 0,
  blockedMs: 0,
  ...over,
});

const session = (over: Partial<StatusSession> = {}): StatusSession => ({
  sessionId: "c56a03dd-1111-2222-3333-444444444444",
  cwd: "/Users/sascha/Projects/clide",
  name: null,
  status: null,
  agents: [],
  ...over,
});

/** The first line is what actually appears in the menu bar. */
const bar = (out: string): string => out.split("\n")[0] ?? "";
/** Just the visible text of the menu bar line, without SwiftBar's `|` parameters. */
const barText = (out: string): string => (bar(out).split("|")[0] ?? "").trim();

describe("menu bar line", () => {
  it("shows the blocked count, and blocked beats working", () => {
    const out = renderMenubar({
      ok: true,
      body: {
        blockedCount: 2,
        sessions: [session({ agents: [agent("blocked"), agent("thinking")] })],
      },
    });
    // The whole surface exists for the blocked case, so it must win the badge
    // even while other agents are busy.
    expect(bar(out)).toContain("2");
    expect(bar(out)).toContain("bell.badge.fill");
  });

  it("shows a working count when nothing is blocked", () => {
    const out = renderMenubar({
      ok: true,
      body: { blockedCount: 0, sessions: [session({ agents: [agent("thinking"), agent("tool-running")] })] },
    });
    expect(bar(out)).toContain("2");
    expect(bar(out)).toContain("circle.fill");
  });

  it("renders quietly when sessions exist but nothing is happening", () => {
    const out = renderMenubar({
      ok: true,
      body: { blockedCount: 0, sessions: [session({ agents: [agent("idle")] })] },
    });
    // No badge number at all — an idle menu bar should be visually silent.
    expect(barText(out)).toBe("");
    expect(bar(out)).toContain("circle");
  });

  it("distinguishes an unreachable daemon from an idle one (PSH-04)", () => {
    const dead = renderMenubar({ ok: false, reason: "no daemon on 127.0.0.1:47000" });
    const idle = renderMenubar({ ok: true, body: { blockedCount: 0, sessions: [] } });

    // Rendering a dead daemon as calm would be a lie — that is the failure mode
    // the whole project is downstream of.
    expect(bar(dead)).toContain("exclamationmark.triangle");
    expect(bar(dead)).not.toBe(bar(idle));
    expect(dead).toContain("no daemon on 127.0.0.1:47000");
  });
});

describe("dropdown", () => {
  it("names which session is waiting, not just that one is (PSH-08)", () => {
    const out = renderMenubar({
      ok: true,
      body: {
        blockedCount: 1,
        sessions: [
          session({ name: "api-work", agents: [agent("thinking")] }),
          session({
            sessionId: "other",
            name: "clide-ac",
            agents: [agent("blocked", { blockedMs: 125_000 })],
          }),
        ],
      },
    });
    expect(out).toContain("clide-ac");
    expect(out).toContain("1 agent waiting on you");
    // Blocked agents report how long they have been waiting, not how long they worked.
    expect(out).toContain("waiting 2m 5s");
  });

  it("falls back to the directory name when a session has no name", () => {
    const out = renderMenubar({
      ok: true,
      body: { blockedCount: 0, sessions: [session({ agents: [agent("idle")] })] },
    });
    expect(out).toContain("clide");
  });

  it("escapes the pipe character, which SwiftBar parses as a parameter delimiter", () => {
    const out = renderMenubar({
      ok: true,
      body: {
        blockedCount: 0,
        sessions: [session({ name: "weird | name", cwd: "/a|b", agents: [agent("idle")] })],
      },
    });
    const nameLine = out.split("\n").find((l) => l.includes("weird"));
    // Exactly one `|` — the real parameter separator, not the one from the title.
    expect((nameLine?.match(/\|/g) ?? []).length).toBe(1);
  });

  it("always offers a refresh action", () => {
    const out = renderMenubar({ ok: true, body: { blockedCount: 0, sessions: [] } });
    expect(out).toContain("refresh=true");
  });
});
