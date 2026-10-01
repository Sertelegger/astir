/**
 * `astir menubar --json` — the contract the macOS app (#64) decodes.
 *
 * The Swift side mirrors these field names exactly (`macos/Sources/AstirBar/
 * MenuModel.swift`) and cannot be compiled on the machine this suite usually
 * runs on, so the shape is pinned HERE. A change that renames a field passes
 * every Swift-free test and breaks the app silently; this is where it fails.
 */

import { describe, expect, it } from "vitest";
import { colourPair, MENU_JSON_VERSION, type Menu, menuJson } from "../src/status/menu.js";

const menu: Menu = {
  badge: { text: "2", depth: 0, colour: "#c93400,#ffb340", symbol: "bell.badge.fill", monospace: true },
  items: [
    {
      text: "a session",
      depth: 0,
      symbol: "hammer.fill",
      symbolColour: "#248a3d,#30db5b",
      action: { argv: ["/bin/node", "/x/main.js", "focus", "s1"] },
    },
    { separator: true },
    {
      text: "Start the daemon",
      depth: 0,
      action: { argv: ["/bin/node", "/x/main.js", "daemon"], terminal: true },
    },
    { text: "Refresh", depth: 0, refresh: true },
    { text: "a detail", depth: 1, colour: "#6c6c70,#98989d" },
  ],
};

describe("the JSON the app decodes", () => {
  const json = menuJson(menu);

  it("is versioned, so the app can refuse a major it cannot read", () => {
    // VER-01, the same rule frames follow. The app and the CLI ship separately,
    // so one will be older; drawing from a misread shape is the worse failure.
    expect(json.v).toEqual(MENU_JSON_VERSION);
    expect(json.v.major).toBe(1);
  });

  it("keeps the badge separate from the items", () => {
    // The bar is the product. A host MUST render this; leaving it at items[0]
    // would make every host rediscover that by position.
    expect(json.badge.text).toBe("2");
    expect(json.badge.symbol).toBe("bell.badge.fill");
  });

  it("splits colour pairs, so Swift never parses '#a,#b'", () => {
    expect(json.badge.colour).toEqual({ light: "#c93400", dark: "#ffb340" });
  });

  it("states `terminal` on every action, rather than leaving it to a default", () => {
    // The Swift `MenuAction` declares `terminal: Bool` as non-optional. An
    // action without it would fail to decode and the whole menu with it.
    const actions = json.items.flatMap((n) => ("separator" in n ? [] : n.action ? [n.action] : []));
    expect(actions.length).toBe(2);
    for (const a of actions) expect(typeof a.terminal).toBe("boolean");
    expect(actions.map((a) => a.terminal)).toEqual([false, true]);
  });

  it("passes separators through unchanged", () => {
    expect(json.items[1]).toEqual({ separator: true });
  });

  it("omits absent fields rather than sending nulls", () => {
    // The Swift optionals decode a missing key as nil and would decode an
    // explicit null the same way — but omission keeps the payload honest about
    // what was actually said.
    const detail = json.items[4];
    expect(detail).toEqual({ text: "a detail", depth: 1, colour: { light: "#6c6c70", dark: "#98989d" } });
  });

  it("carries refresh as its own flag", () => {
    expect(json.items[3]).toEqual({ text: "Refresh", depth: 0, refresh: true });
  });
});

describe("colourPair", () => {
  it("uses one value for both appearances, as SwiftBar does", () => {
    expect(colourPair("#888888")).toEqual({ light: "#888888", dark: "#888888" });
  });

  it("tolerates spaces around the comma", () => {
    expect(colourPair("#111 , #222")).toEqual({ light: "#111", dark: "#222" });
  });
});
