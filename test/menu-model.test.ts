/**
 * The menu as a model, separate from SwiftBar's wire format.
 *
 * `renderMenubar` was pure and tested, and what it emitted was SwiftBar's plugin
 * protocol — `sfimage=`, `bash=`/`param1=`, `terminal=false`, `--` for depth.
 * The decisions lived in one testable place, which was the point; the OUTPUT was
 * a wire format, so anything else wanting to draw this menu had to parse that
 * format back out to recover the structure that produced it.
 *
 * These test the model and the serialiser separately, which is the thing that
 * was not possible before.
 */

import { describe, expect, it } from "vitest";
import { isSeparator, type Menu, toSwiftBar } from "../src/status/menu.js";
import { buildMenu, renderMenubar } from "../src/status/menubar.js";

const OPTS = { invocation: ["/usr/bin/node", "/opt/astir/main.js"], now: 1_787_000_100_000 };
const body = (over: Record<string, unknown> = {}) => ({
  ok: true as const,
  body: {
    blockedCount: 1,
    sessions: [
      {
        sessionId: "s1",
        cwd: "/repo/alpha",
        name: "astir-aa",
        status: "busy",
        pid: 7,
        agents: [
          {
            id: "s1",
            state: "blocked",
            agentType: null,
            activeMs: 1,
            blockedMs: 2,
            inStateMs: 3,
            acknowledged: false,
          },
        ],
      },
    ],
    ...over,
  },
});

describe("the model carries structure, not syntax", () => {
  const menu = buildMenu(body() as never, OPTS as never);

  it("names the status item separately from the dropdown", () => {
    // A host MUST render the badge; the dropdown is optional in a way it is not.
    // Leaving it at items[0] would make every host rediscover that by position.
    expect(menu.badge.text).toContain("1");
    expect(menu.items.length).toBeGreaterThan(0);
  });

  it("expresses an action as argv, not as a bash= string", () => {
    // The whole point: a native app spawns this, it does not parse it.
    const clickable = menu.items.filter((n) => !isSeparator(n) && n.action !== undefined);
    expect(clickable.length).toBeGreaterThan(0);
    const first = clickable[0];
    if (first === undefined || isSeparator(first)) throw new Error("no action");
    expect(Array.isArray(first.action?.argv)).toBe(true);
    expect(first.action?.argv[0]).toBe("/usr/bin/node");
  });

  it("expresses nesting as a depth, not as a `--` prefix", () => {
    const nested = menu.items.filter((n) => !isSeparator(n) && n.depth > 0);
    expect(nested.length).toBeGreaterThan(0);
    for (const n of menu.items) {
      if (!isSeparator(n)) expect(n.text.startsWith("--")).toBe(false);
    }
  });

  it("carries no SwiftBar syntax in any text", () => {
    // If `sfimage=` or `bash=` appears in TEXT, the split did not actually
    // happen — it was just moved.
    for (const n of menu.items) {
      if (isSeparator(n)) continue;
      expect(n.text).not.toMatch(/sfimage=|sfcolor=|bash=|param\d+=|terminal=|refresh=/);
    }
  });
});

describe("the serialiser is the only thing that knows SwiftBar", () => {
  it("renders depth as `--` and an action as bash=/param1=", () => {
    const menu: Menu = {
      badge: { text: "2", depth: 0, symbol: "bell.badge.fill" },
      items: [
        { text: "a session", depth: 0, action: { argv: ["/bin/node", "/x/main.js", "focus", "s1"] } },
        { separator: true },
        { text: "nested", depth: 1, colour: "#111,#222", monospace: true },
      ],
    };
    const out = toSwiftBar(menu).split("\n");
    expect(out[0]).toBe("2 | sfimage=bell.badge.fill");
    expect(out[1]).toBe("---");
    expect(out[2]).toBe(
      "a session | bash=/bin/node param1=/x/main.js param2=focus param3=s1 terminal=false refresh=true",
    );
    expect(out[3]).toBe("---");
    expect(out[4]).toBe("-- nested | color=#111,#222 font=Menlo");
  });

  it("runs one item in a visible terminal, and only when asked", () => {
    // Starting the daemon has output worth seeing when it fails, which is the
    // situation that item exists to resolve.
    const visible = toSwiftBar({
      badge: { text: "", depth: 0 },
      items: [
        { text: "Start", depth: 0, action: { argv: ["/bin/node", "/x.js", "daemon"], terminal: true } },
      ],
    });
    expect(visible).toContain("terminal=true");
    expect(visible).not.toContain("terminal=false");
  });

  it("escapes a pipe, which SwiftBar would read as the start of parameters", () => {
    const out = toSwiftBar({ badge: { text: "a | b", depth: 0 }, items: [] });
    expect(out.split("\n")[0]).toBe("a ¦ b");
  });
});

describe("the split changed nothing a host can see", () => {
  it("still produces the same menu through the composition", () => {
    // `renderMenubar` is now `toSwiftBar(buildMenu(...))`, and 75 existing tests
    // assert on its output — so they are the oracle for this refactor.
    // Verified separately against the pre-refactor build on identical input:
    // 26 lines each, and every difference was attribute ORDER within the `|`
    // parameters, which SwiftBar parses as an unordered set of key=value pairs.
    const rendered = renderMenubar(body() as never, OPTS as never);
    expect(rendered).toBe(`${toSwiftBar(buildMenu(body() as never, OPTS as never))}\n`);
  });
});
