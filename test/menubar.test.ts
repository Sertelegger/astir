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
  cwd: "/Users/sascha/Projects/astir",
  name: null,
  status: null,
  pid: null,
  agents: [],
  ...over,
});

const NODE = "/opt/node/bin/node";
const SCRIPT = "/usr/local/lib/astir/main.js";
const OPTS = { invocation: [NODE, SCRIPT] };

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
              name: "astir-ac",
              agents: [agent("blocked", { inStateMs: 125_000 })],
            }),
          ],
        },
      },
      OPTS,
    );
    expect(out).toContain("astir-ac");
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
    expect(out).toContain(`param2=dismiss param3=sid-1`);
    expect(out).toContain(`param2=forget param3=sid-1`);
    expect(out).toContain(`param2=focus param3=sid-1`);
    expect(out).toContain(`Dismiss all | bash=${NODE} param1=${SCRIPT} param2=dismiss`);
    // A bare `astir` would not resolve under SwiftBar's PATH.
    expect(out).not.toMatch(/bash=astir\b/);
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
    expect(out).toContain("astir");
  });
});

describe("naming a session", () => {
  const titleOf = (out: string): string =>
    (out.split("\n").find((l) => !l.startsWith("--") && l.includes("param2=focus")) ?? "")
      .split("|")[0]
      ?.trim() ?? "";

  it("leads with the repo, not the generated session slug", () => {
    // "seenthat-bd" tells you nothing about which project it is, and its suffix
    // is generated — as a primary label it is close to useless.
    const out = renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: 0,
          sessions: [session({ name: "seenthat-bd", cwd: "/x/seenthat", agents: [agent("idle")] })],
        },
      },
      OPTS,
    );
    // The repo leads; the state rides along so it is readable without opening
    // the submenu.
    expect(titleOf(out).startsWith("seenthat")).toBe(true);
    expect(titleOf(out)).not.toContain("seenthat-bd");
  });

  it("keeps the slug and full path as submenu detail", () => {
    const out = renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: 0,
          sessions: [session({ name: "astir-56", agents: [agent("idle")] })],
        },
      },
      OPTS,
    );
    expect(out).toContain("-- /Users/sascha/Projects/astir  ·  astir-56");
  });

  it("numbers sessions only when the repo alone is ambiguous", () => {
    const out = renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: 0,
          sessions: [
            session({ sessionId: "a", name: "astir-56", agents: [agent("idle")] }),
            session({ sessionId: "b", name: "astir-99", agents: [agent("idle")] }),
            session({ sessionId: "c", cwd: "/x/other", name: "other-aa", agents: [agent("idle")] }),
          ],
        },
      },
      OPTS,
    );
    expect(out).toContain("astir (1)");
    expect(out).toContain("astir (2)");
    // A solitary session gets no "(1)" — that would be noise on every row.
    expect(out).toMatch(/\nother {2}·/);
  });

  it("uses the repo for silent sessions too", () => {
    const out = renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: 0,
          sessions: [],
          silent: [{ sessionId: "s2", cwd: "/x/seenthat", name: "seenthat-bd" }],
        },
      },
      OPTS,
    );
    // The repo leads at top level; the path and slug are detail beneath it.
    expect(out).toContain("seenthat  ·  not connected");
    expect(out).toContain("-- /x/seenthat  ·  seenthat-bd");
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

describe("why a session is silent", () => {
  const silentBody = (over: Partial<StatusBody> = {}, silentOver: Record<string, unknown> = {}): string =>
    renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: 0,
          sessions: [],
          silent: [{ sessionId: "s2", cwd: "/x/y", name: "y-aa", ...silentOver }],
          ...over,
        },
      },
      { ...OPTS, now: 1_000_000 },
    );

  it("lists silent sessions BELOW the ones we can hear, not above them", () => {
    // A warning banner above the live view made the thing you actually wanted
    // to see the second thing on screen.
    const out = renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: 0,
          sessions: [session({ agents: [agent("tool-running")] })],
          silent: [{ sessionId: "s2", cwd: "/x/y", name: "y-aa" }],
        },
      },
      OPTS,
    );
    const lines = out.split("\n");
    const live = lines.findIndex((l) => l.startsWith("astir ") && l.includes("param2=focus"));
    const quiet = lines.findIndex((l) => l.startsWith("y  ·  not connected"));
    expect(live).toBeGreaterThanOrEqual(0);
    expect(quiet).toBeGreaterThan(live);
  });

  it("dims a silent session so it does not read as live", () => {
    const line = silentBody()
      .split("\n")
      .find((l) => l.startsWith("y  ·  not connected"));
    expect(line).toContain("color=");
  });

  it("blames the token only while it is ACTUALLY being rejected", () => {
    expect(silentBody({ unauthorizedIngest: 4, lastUnauthorizedAt: 1_000_000 - 5_000 })).toContain(
      "token is rejected",
    );
  });

  it("stops blaming the token once the rejections stop", () => {
    // The regression: `unauthorizedIngest` is a LIFETIME total, so testing it for
    // non-zero pinned "run astir install to repair the token" on screen forever
    // after one historical rejection — telling the user to fix something already
    // correct while the real cause went unnamed.
    const out = silentBody({ unauthorizedIngest: 93, lastUnauthorizedAt: 1_000_000 - 3 * 3600_000 });
    expect(out).not.toContain("token is rejected");
    expect(out).not.toContain("repair the token");
  });

  it("states the sandbox cause when it can prove it, and offers the fix", () => {
    // A sandboxed project's hook POST is refused by the proxy before it reaches
    // the daemon, so no astir counter moves — undiagnosable from counters alone,
    // but provable from the project's own settings.
    const out = silentBody({}, { sandboxBlocked: true });
    expect(out).toContain("This project is sandboxed");
    expect(out).toContain("param2=allow-sandbox param3=/x/y");
  });

  it("numbers colliding silent repos, same as live ones", () => {
    // Two identical dim rows with no way to tell them apart is the same problem
    // the live numbering exists to solve.
    const out = renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: 0,
          sessions: [],
          silent: [
            { sessionId: "s1", cwd: "/a/observer", name: "observer-27" },
            { sessionId: "s2", cwd: "/a/observer", name: "observer-45" },
          ],
        },
      },
      OPTS,
    );
    expect(out).toContain("observer (1)  ·  not connected");
    expect(out).toContain("observer (2)  ·  not connected");
  });

  it("does not call a session unwired when it predates the daemon", () => {
    // The daemon keeps state in memory, so a restart forgets every running
    // session. Their hooks fire on activity and an idle session emits nothing —
    // telling the user to restart it would send them to fix something that
    // works and will reappear on its own.
    const out = silentBody({ daemonStartedAt: 500_000 }, { startedAt: 400_000 });
    expect(out).toContain("Started before astir was listening");
    expect(out).not.toContain("restart it");
  });

  it("still calls out a session that started AFTER the daemon and stayed quiet", () => {
    // Here silence is real evidence: astir was listening the whole time.
    const out = silentBody({ daemonStartedAt: 500_000 }, { startedAt: 600_000 });
    expect(out).toContain("restart it");
    expect(out).not.toContain("Started before astir was listening");
  });

  it("prefers the sandbox diagnosis over the age one, since it is provable", () => {
    const out = silentBody({ daemonStartedAt: 500_000 }, { startedAt: 400_000, sandboxBlocked: true });
    expect(out).toContain("This project is sandboxed");
  });

  it("does not offer the sandbox fix to a session that is not sandboxed", () => {
    const out = silentBody({}, { sandboxBlocked: false });
    expect(out).not.toContain("allow-sandbox");
    expect(out).toContain("restart it");
  });
});

describe("state on the session row (VIEW-12)", () => {
  const rowFor = (out: string, repo: string): string =>
    out.split("\n").find((l) => l.startsWith(repo) && l.includes("param2=focus")) ?? "";

  const withState = (...states: string[]): string =>
    renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: states.includes("blocked") ? 1 : 0,
          sessions: [session({ agents: states.map((st) => agent(st)) })],
        },
      },
      OPTS,
    );

  it("says what a session is doing without opening the submenu", () => {
    // The whole point: answering "is anything working right now" used to mean
    // opening each session in turn.
    const row = rowFor(withState("tool-running"), "astir");
    expect(row).toContain("running");
    // A cog reads as settings rather than work in progress.
    expect(row).toContain("sfimage=hammer.fill");
  });

  it("carries both an icon and a word, not one or the other", () => {
    // Colour alone fails for a colour vision deficiency and vanishes in a
    // screenshot; a word alone is slower to scan.
    const row = rowFor(withState("thinking"), "astir");
    expect(row).toContain("thinking");
    expect(row).toMatch(/sfimage=\S+/);
    expect(row).toMatch(/sfcolor=#[0-9a-f]{6},#[0-9a-f]{6}/);
  });

  it("lets a blocked agent outrank five busy ones", () => {
    // Ranked by what it asks of the reader: the busy ones need nothing.
    const row = rowFor(withState("tool-running", "thinking", "blocked", "thinking"), "astir");
    expect(row).toContain("waiting on you");
    expect(row).toContain("bell.badge.fill");
  });

  it("reads as working when a subagent finished but the main one has not", () => {
    // Terminal states rank last, or a session would look done while it works.
    const row = rowFor(withState("done", "tool-running"), "astir");
    expect(row).toContain("running");
  });

  it("does not shout about an agent the human already dismissed", () => {
    const out = renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: 0,
          sessions: [session({ agents: [agent("blocked", { acknowledged: true })] })],
        },
      },
      OPTS,
    );
    const row = rowFor(out, "astir");
    expect(row).not.toContain("waiting on you");
    expect(row).toContain("waiting");
  });

  it("says nothing at all once every agent has aged out", () => {
    // The row must not announce a state for an agent no longer listed beneath it.
    const out = renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: 0,
          sessions: [session({ agents: [agent("done", { inStateMs: 600_000 })] })],
        },
      },
      OPTS,
    );
    const row = rowFor(out, "astir");
    expect(row).not.toContain("sfimage=");
    expect(row.split("|")[0]?.trim()).toBe("astir");
  });

  it("colours the icon, not the title text", () => {
    // The title stays the system label colour so it is legible in both
    // appearances; the state rides on the symbol.
    const row = rowFor(withState("idle"), "astir");
    expect(row).toMatch(/sfcolor=/);
    expect(row).not.toMatch(/(^|\s)color=/);
  });
});

describe("sessions nobody is sitting at (DMN-11)", () => {
  const chores = (out: string): string => out.split("background session").at(-1) ?? "";

  it("keeps a plugin-launched session out of the list of your work", () => {
    // claude-mem runs observer sessions; they are real, but they are not yours,
    // and they crowded out the two repos actually being worked in.
    const out = renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: 0,
          sessions: [
            session({ sessionId: "a", cwd: "/x/astir", agents: [agent("idle")] }),
            session({
              sessionId: "b",
              cwd: "/x/.claude-mem/observer-sessions",
              attended: false,
              agents: [agent("idle")],
            }),
          ],
        },
      },
      OPTS,
    );
    expect(out).toContain("1 background session");
    expect(chores(out)).toContain("observer-sessions");
    // The top of the menu is only the session you care about.
    const titles = out.split("\n").filter((l) => l.includes("param2=focus") && !l.startsWith("--"));
    expect(titles).toHaveLength(1);
  });

  it("treats an unclassified session as yours", () => {
    // `ps` is absent on Windows and a pid can exit mid-poll. Demoting a session
    // someone is working in is the one failure this must not have.
    const out = renderMenubar(
      {
        ok: true,
        body: { blockedCount: 0, sessions: [session({ agents: [agent("idle")] })] },
      },
      OPTS,
    );
    expect(out).not.toContain("background session");
  });

  it("groups a silent background session too, without nagging about it", () => {
    const out = renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: 0,
          sessions: [],
          silent: [{ sessionId: "s", cwd: "/x/.claude-mem/obs", name: "obs-1", attended: false }],
        },
      },
      OPTS,
    );
    expect(out).toContain("1 background session");
    expect(out).not.toContain("not connected");
  });

  it("groups a remote background session and says which machine it is on", () => {
    // Only the push route can know this: a controlling terminal is a local fact
    // and `claude agents --json` does not report one.
    const out = renderMenubar(
      { ok: true, body: { blockedCount: 0, sessions: [] } },
      {
        ...OPTS,
        remote: {
          agents: [],
          sessions: [
            {
              host: "megabrain-dev",
              sessionId: "r",
              cwd: "/home/dev/.claude-mem/obs",
              name: null,
              status: "running",
              source: "push",
              attended: false,
              lastSeen: 0,
            },
          ],
        },
      },
    );
    expect(chores(out)).toContain("obs  ·  megabrain-dev");
    expect(out).not.toContain("Other machines");
  });

  it("counts them, so a machine quietly running six is still visible", () => {
    const out = renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: 0,
          sessions: [0, 1, 2].map((i) =>
            session({ sessionId: `b${i}`, cwd: `/x/obs${i}`, attended: false, agents: [] }),
          ),
        },
      },
      OPTS,
    );
    expect(out).toContain("3 background sessions");
  });
});

describe("finished agents", () => {
  const withAgents = (...agents: ReturnType<typeof agent>[]): string =>
    renderMenubar({ ok: true, body: { blockedCount: 0, sessions: [session({ agents })] } }, OPTS);

  it("shows a just-finished agent, so you see that it landed", () => {
    expect(withAgents(agent("done", { inStateMs: 5_000 }))).toContain("done");
  });

  it("drops it once it has been done for a while", () => {
    // A session that has run a few subagents otherwise accumulates a stack of
    // `done` lines that push the live one out of sight.
    // The submenu line goes; the row follows it, rather than still announcing a
    // state for an agent that is no longer listed.
    const out = withAgents(agent("done", { inStateMs: 120_000 }));
    expect(out).not.toContain("-- done");
    expect(out).not.toContain("·  done");
  });

  it("keeps a failed agent listed regardless of age", () => {
    // An agent that errored is not clutter — it is the thing you most need to
    // still be there when you look up.
    expect(withAgents(agent("error", { inStateMs: 600_000 }))).toContain("error");
  });

  it("never hides an agent that is still working or blocked", () => {
    const out = withAgents(
      agent("blocked", { inStateMs: 600_000 }),
      agent("tool-running", { inStateMs: 600_000 }),
    );
    expect(out).toContain("blocked");
    expect(out).toContain("tool-running");
  });

  it("still lists the session once its agents have aged out", () => {
    const out = withAgents(agent("done", { inStateMs: 600_000 }));
    expect(out).toContain("/Users/sascha/Projects/astir");
  });
});

describe("clickability under SwiftBar's PATH", () => {
  const clickable = (out: string): string[] => out.split("\n").filter((l) => l.includes("bash="));

  it("runs the interpreter and passes the script, never the script alone", () => {
    // SwiftBar launches `bash=` from launchd, whose PATH has no version-manager
    // node. Exec'ing main.js relies on its `#!/usr/bin/env node` shebang finding
    // one there; it does not, the exec fails 127, and the item looks inert.
    const out = renderMenubar(
      {
        ok: true,
        body: { blockedCount: 1, sessions: [session({ agents: [agent("blocked")] })] },
      },
      OPTS,
    );
    const lines = clickable(out);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toContain(`bash=${NODE}`);
      expect(line).toContain(`param1=${SCRIPT}`);
    }
  });

  it("makes every line of a session block go somewhere", () => {
    // A path line and a state line look no different from the title, so a click
    // that does nothing reads as broken rather than as "that one is not a button".
    const out = renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: 0,
          sessions: [session({ sessionId: "sid-1", agents: [agent("tool-running")] })],
        },
      },
      OPTS,
    );
    const block = out.split("\n").filter((l) => l.startsWith("-- ") && !l.includes("Forget"));
    expect(block.length).toBeGreaterThan(0);
    for (const line of block) {
      expect(line).toContain("param2=focus param3=sid-1");
    }
  });

  it("passes the interpreter on the daemon-unreachable action too", () => {
    const out = renderMenubar({ ok: false, reason: "connection refused" }, OPTS);
    expect(out).toContain(`bash=${NODE} param1=${SCRIPT} param2=daemon`);
    // Starting the daemon is the one action that should show its output.
    expect(out).toContain("terminal=true");
  });
});

describe("legibility in both appearances", () => {
  const colours = (out: string): string[] => [...out.matchAll(/color=([^\s|]+)/g)].map((m) => m[1] ?? "");

  const fullMenu = (): string =>
    renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: 1,
          sessions: [
            session({
              agents: [agent("blocked"), agent("thinking"), agent("blocked", { acknowledged: true })],
            }),
          ],
          silent: [{ sessionId: "s2", cwd: "/x/y", name: "other" }],
          unauthorizedIngest: 4,
        },
      },
      { ...OPTS, remote: { agents: [] } },
    );

  it("gives every colour a light and a dark variant", () => {
    // A single value is used for BOTH appearances, which is how #ffffff titles
    // and #cccccc detail became white-on-light-grey in light mode.
    for (const colour of colours(fullMenu())) {
      expect(colour).toMatch(/^#[0-9a-f]{6},#[0-9a-f]{6}$/);
    }
  });

  it("leaves the session title uncoloured so it uses the system label colour", () => {
    const out = renderMenubar(
      {
        ok: true,
        body: { blockedCount: 0, sessions: [session({ name: "astir-56", agents: [agent("idle")] })] },
      },
      OPTS,
    );
    const titleLine = out.split("\n").find((l) => !l.startsWith("--") && l.includes("param2=focus"));
    expect(titleLine).toBeDefined();
    // `sfcolor=` colours the status icon and is expected; what must be absent is
    // a text colour, which would override the system label colour.
    expect(titleLine).not.toMatch(/(^|\s)color=/);
  });

  it("still colours a blocked session title, which must not read as body text", () => {
    const out = renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: 1,
          sessions: [session({ name: "astir-56", agents: [agent("blocked")] })],
        },
      },
      OPTS,
    );
    const titleLine = out.split("\n").find((l) => !l.startsWith("--") && l.includes("param2=focus"));
    expect(titleLine).toContain("color=");
  });

  it("never emits the old dark-only values", () => {
    const out = fullMenu();
    for (const dead of ["#ffffff", "#cccccc", "#888888", "#666666"]) {
      expect(out).not.toContain(`color=${dead}`);
    }
  });
});

describe("sessions on other machines (DMN-09/DMN-10)", () => {
  const remoteSession = (over: Record<string, unknown> = {}) => ({
    host: "megabrain-dev",
    sessionId: "r1",
    cwd: "/home/u/claude-sesh-mover",
    name: "mover-aa",
    status: "idle",
    source: "ssh" as const,
    lastSeen: 0,
    ...over,
  });

  it("lists a remote session that is not blocked, so a quiet machine is visible", () => {
    // Without this a remote session that is working fine does not exist as far
    // as the menu bar is concerned — indistinguishable from an unreachable box.
    const out = renderMenubar(
      { ok: true, body: { blockedCount: 0, sessions: [], remote: [remoteSession()] } },
      OPTS,
    );
    expect(out).toContain("Other machines");
    expect(out).toContain("claude-sesh-mover  ·  megabrain-dev");
    expect(out).toContain("seen over ssh");
  });

  it("says which route knew about it", () => {
    const out = renderMenubar(
      { ok: true, body: { blockedCount: 0, sessions: [] } },
      { ...OPTS, remote: { agents: [], sessions: [remoteSession({ source: "push" })] } },
    );
    expect(out).toContain("reported by its daemon");
  });

  it("merges a session both routes report, instead of listing it twice", () => {
    const out = renderMenubar(
      { ok: true, body: { blockedCount: 0, sessions: [], remote: [remoteSession()] } },
      { ...OPTS, remote: { agents: [], sessions: [remoteSession({ source: "push" })] } },
    );
    const rows = out.split("\n").filter((l) => l.startsWith("claude-sesh-mover"));
    expect(rows).toHaveLength(1);
    expect(out).toContain("reported by its daemon");
  });

  it("does not list a remote session twice when it also has a blocked agent", () => {
    const out = renderMenubar(
      { ok: true, body: { blockedCount: 0, sessions: [], remote: [remoteSession()] } },
      {
        ...OPTS,
        now: 0,
        remote: {
          agents: [
            {
              host: "megabrain-dev",
              repo: "claude-sesh-mover",
              sessionId: "r1",
              reason: "permission_prompt",
              since: 0,
              acknowledged: false,
            },
          ],
        },
      },
    );
    // The blocked rendering already carries its reason and dismiss action.
    expect(out).toContain("megabrain-dev · claude-sesh-mover");
    expect(out).not.toContain("seen over ssh");
  });

  it("renders an unreachable remote session distinctly rather than dropping it", () => {
    const out = renderMenubar(
      { ok: true, body: { blockedCount: 0, sessions: [], remote: [remoteSession({ stale: true })] } },
      OPTS,
    );
    expect(out).toContain("unreachable");
    expect(out).toContain("probably still running");
  });

  it("numbers colliding repos across machines", () => {
    const out = renderMenubar(
      {
        ok: true,
        body: {
          blockedCount: 0,
          sessions: [],
          remote: [
            remoteSession({ sessionId: "r1", host: "box-a" }),
            remoteSession({ sessionId: "r2", host: "box-b" }),
          ],
        },
      },
      OPTS,
    );
    expect(out).toContain("claude-sesh-mover (1)");
    expect(out).toContain("claude-sesh-mover (2)");
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
    expect(out).toContain("param2=dismiss param3=remote-1");
    expect(out).not.toContain("param2=focus param3=remote-1");
  });

  it("never renders a doubled separator", () => {
    const out = renderMenubar(
      { ok: true, body: { blockedCount: 0, sessions: [] } },
      { ...OPTS, remote: { agents: [remoteEntry({ acknowledged: true })] }, now: 0 },
    );
    expect(out).not.toContain("---\n---");
  });
});
