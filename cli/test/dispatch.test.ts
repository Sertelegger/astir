import { describe, it, expect } from "vitest";
import { parseArgv, COMMANDS } from "../src/dispatch.js";

describe("parseArgv", () => {
  it("parses subcommand + flags + positional args", () => {
    expect(parseArgv(["tui"])).toEqual({ command: "tui", args: [], flags: {} });
    expect(parseArgv(["doctor", "--clean"])).toEqual({ command: "doctor", args: [], flags: { clean: true } });
    expect(parseArgv(["install", "--provider", "codex"])).toEqual({ command: "install", args: [], flags: { provider: "codex" } });
    expect(parseArgv(["install", "--provider", "codex", "--uninstall"])).toEqual({ command: "install", args: [], flags: { provider: "codex", uninstall: true } });
  });
  it("unknown/empty command → help", () => {
    expect(parseArgv([]).command).toBe("help");
    expect(parseArgv(["bogus"]).command).toBe("help");
  });
  it("COMMANDS lists the supported subcommands", () => {
    expect([...COMMANDS].sort()).toEqual(["aggregate", "doctor", "install", "tui", "watch"]);
  });
});
