import { describe, expect, it } from "vitest";
import { renderMenubar } from "../src/status/menubar.js";
import type { StatusBody, StatusSession } from "../src/status/types.js";

const agent = (state: string, over: Partial<StatusBody["sessions"][0]["agents"][0]> = {}) => ({
  id: "a1",
  state,
  agentType: null,
  activeMs: 0,
  blockedMs: 0,
  inStateMs: 0,
  acknowledged: false,
  ...over,
});

const session = (over: Partial<StatusSession> = {}): StatusSession => ({
  sessionId: "c56a03dd-1111-2222-3333-444444444444",
  cwd: "/Users/sascha/Projects/clide",
  name: null,
  status: null,
  pid: null,
  agents: [],
  ...over,
});

const OPTS = { exe: "/usr/local/bin/clide" };

/** The first line is what actually appears in the menu bar. */
const bar = (out: string): string => out.split("\n")[0] ?? "";
/** Just the visible text of the menu bar line, without SwiftBar's `|` parameters. */
const barText = (out: string): string => (bar(out).split("|")[0] ?? "").trim();

describe("menu bar line", () => {
  it("shows the blocked count, and blocked beats working", () => {
    const out = renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: 2,
          sessions: [session({ agents: [agent("blocked"), agent("thinking")] })],
        },
      },
      OPTS,
    );
    // The whole surface exists for the blocked case, so it must win the badge
    // even while other agents are busy.
    expect(bar(out)).toContain("2");
    expect(bar(out)).toContain("bell.badge.fill");
  });

  it("shows a working count when nothing is blocked", () => {
    const out = renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: 0,
          sessions: [session({ agents: [agent("thinking"), agent("tool-running")] })],
        },
      },
      OPTS,
    );
    expect(bar(out)).toContain("2");
    expect(bar(out)).toContain("circle.fill");
  });

  it("renders quietly when sessions exist but nothing is happening", () => {
    const out = renderMenubar(
      {
        ok: true,
        body: { blockedCount: 0, sessions: [session({ agents: [agent("idle")] })] },
      },
      OPTS,
    );
    // No badge number at all — an idle menu bar should be visually silent.
    expect(barText(out)).toBe("");
    expect(bar(out)).toContain("circle");
  });

  it("distinguishes an unreachable daemon from an idle one (PSH-04)", () => {
    const dead = renderMenubar({ ok: false, reason: "no daemon on 127.0.0.1:47000" }, OPTS);
    const idle = renderMenubar({ ok: true, body: { blockedCount: 0, sessions: [] } }, OPTS);

    // Rendering a dead daemon as calm would be a lie — that is the failure mode
    // the whole project is downstream of.
    expect(bar(dead)).toContain("exclamationmark.triangle");
    expect(bar(dead)).not.toBe(bar(idle));
    expect(dead).toContain("no daemon on 127.0.0.1:47000");
  });
});

describe("dropdown", () => {
  it("names which session is waiting, not just that one is (PSH-08)", () => {
    const out = renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: 1,
          sessions: [
            session({ name: "api-work", agents: [agent("thinking")] }),
            session({
              sessionId: "other",
              name: "clide-ac",
              agents: [agent("blocked", { inStateMs: 125_000 })],
            }),
          ],
        },
      },
      OPTS,
    );
    expect(out).toContain("clide-ac");
    expect(out).toContain("1 agent waiting on you");
    // Blocked agents report how long they have been waiting, not how long they worked.
    expect(out).toContain("waiting 2m 5s");
  });

  it("shows how long the wait has ACTUALLY lasted, not the banked total", () => {
    // Regression. `blockedMs` only accrues when an agent *leaves* the blocked
    // state, so for an agent that is still blocked it is whatever it was on
    // entry — normally zero. Rendering it produced a "waiting 0s" that never
    // moved no matter how long the agent sat there, which is the one number this
    // surface exists to report.
    const out = renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: 1,
          sessions: [session({ agents: [agent("blocked", { blockedMs: 0, inStateMs: 20 * 60_000 })] })],
        },
      },
      OPTS,
    );
    expect(out).toContain("waiting 20m 0s");
    expect(out).not.toContain("waiting 0s");
  });

  it("offers a way out: dismiss, forget, and click-to-focus", () => {
    // Every blocked notification needs an exit that is not "go deal with it".
    const out = renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: 1,
          sessions: [session({ sessionId: "sid-1", agents: [agent("blocked")] })],
        },
      },
      OPTS,
    );
    expect(out).toContain("param1=dismiss param2=sid-1");
    expect(out).toContain("param1=forget param2=sid-1");
    expect(out).toContain("param1=focus param2=sid-1");
    expect(out).toContain("Dismiss all | bash=/usr/local/bin/clide param1=dismiss");
    // A bare `clide` would not resolve under SwiftBar's PATH.
    expect(out).not.toMatch(/bash=clide\b/);
  });

  it("a dismissed agent stays listed but stops shouting", () => {
    const out = renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: 0, // the daemon excludes acknowledged agents from the count
          sessions: [session({ agents: [agent("blocked", { acknowledged: true, inStateMs: 60_000 })] })],
        },
      },
      OPTS,
    );
    expect(out).toContain("(dismissed)");
    expect(out).toContain("waiting 1m 0s"); // still honest about the wait
    expect(out).not.toContain("waiting on you"); // but no longer demanding attention
    expect(bar(out)).not.toContain("bell.badge.fill");
  });

  it("falls back to the directory name when a session has no name", () => {
    const out = renderMenubar(
      {
        ok: true,
        body: { blockedCount: 0, sessions: [session({ agents: [agent("idle")] })] },
      },
      OPTS,
    );
    expect(out).toContain("clide");
  });

  it("escapes the pipe character, which SwiftBar parses as a parameter delimiter", () => {
    const out = renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: 0,
          sessions: [session({ name: "weird | name", cwd: "/a|b", agents: [agent("idle")] })],
        },
      },
      OPTS,
    );
    const nameLine = out.split("\n").find((l) => l.includes("weird"));
    // Exactly one `|` — the real parameter separator, not the one from the title.
    expect((nameLine?.match(/\|/g) ?? []).length).toBe(1);
  });

  it("always offers a refresh action", () => {
    const out = renderMenubar({ ok: true, body: { blockedCount: 0, sessions: [] } }, OPTS);
    expect(out).toContain("refresh=true");
  });
});

describe("PSH-12 — other machines", () => {
  const remoteEntry = (over = {}) => ({
    host: "devbox",
    repo: "payments-api",
    sessionId: "remote-1",
    reason: "permission_prompt",
    since: 0,
    acknowledged: false,
    ...over,
  });

  it("counts remote blocked agents in the badge", () => {
    // The badge would be lying if it only counted agents on this machine —
    // the ones you cannot see are exactly the ones that go unnoticed.
    const out = renderMenubar(
      { ok: true, body: { blockedCount: 1, sessions: [session({ agents: [agent("blocked")] })] } },
      { ...OPTS, remote: { agents: [remoteEntry()] }, now: 60_000 },
    );
    expect(barText(out)).toBe("2");
    expect(out).toContain("2 agents waiting on you");
    expect(out).toContain("devbox · payments-api");
    expect(out).toContain("waiting 1m 0s");
  });

  it("does not offer to focus a window that is on another machine", () => {
    const out = renderMenubar(
      { ok: true, body: { blockedCount: 0, sessions: [] } },
      { ...OPTS, remote: { agents: [remoteEntry()] }, now: 0 },
    );
    expect(out).toContain("param1=dismiss param2=remote-1");
    expect(out).not.toContain("param1=focus param2=remote-1");
  });

  it("never renders a doubled separator", () => {
    const out = renderMenubar(
      { ok: true, body: { blockedCount: 0, sessions: [] } },
      { ...OPTS, remote: { agents: [remoteEntry({ acknowledged: true })] }, now: 0 },
    );
    expect(out).not.toContain("---\n---");
  });
});
