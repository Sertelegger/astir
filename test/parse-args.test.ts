/**
 * The CLI's argument parsing. `--` ends the options, so an id a caller did
 * not write can never be read as a flag, whatever it begins with.
 */

import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";

describe("parseArgs", () => {
  it("reads flags with values, bare flags and positionals", () => {
    const a = parseArgs(["status", "--line", "--session", "abc", "--json"]);
    expect(a.command).toBe("status");
    expect(a.flags.get("line")).toBe(true);
    expect(a.flags.get("session")).toBe("abc");
    expect(a.flags.get("json")).toBe(true);
    expect(a.positional).toEqual([]);
  });

  it("takes everything after `--` as positional, even what looks like a flag", () => {
    const a = parseArgs(["focus", "--", "--port"]);
    expect(a.positional).toEqual(["--port"]);
    expect(a.flags.has("port")).toBe(false);
  });

  it("still reads flags before `--`", () => {
    const a = parseArgs(["dismiss", "--port", "47100", "--", "s-1"]);
    expect(a.flags.get("port")).toBe("47100");
    expect(a.positional).toEqual(["s-1"]);
  });
});
