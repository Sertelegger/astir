import { describe, expect, it } from "vitest";
import { isAttended, parseTtyTable } from "../src/discovery/attended.js";

describe("reading the process table", () => {
  it("parses pid and tty columns", () => {
    const t = parseTtyTable("  501 ttys002\n  502 ??\n");
    expect(t.get(501)).toBe("ttys002");
    expect(t.get(502)).toBe("??");
  });

  it("survives a header or junk lines", () => {
    const t = parseTtyTable("PID TTY\n  501 ttys002\n\n");
    expect(t.size).toBe(1);
  });

  it("handles a process with a blank tty column", () => {
    // Linux prints an empty field rather than `?` in some ps builds.
    expect(parseTtyTable("  501 \n").get(501)).toBe("");
  });
});

describe("is a human sitting at it", () => {
  const table = new Map<number, string>([
    [100, "ttys010"],
    [200, "??"],
    [300, "?"],
    [400, ""],
    [500, "-"],
  ]);

  it("says yes for a session on a terminal", () => {
    expect(isAttended(100, table)).toBe(true);
  });

  it("says no for the ?? macOS reports for a program-launched session", () => {
    // Measured on a live machine: two interactive sessions on ttys002/ttys010,
    // a claude-mem observer on ??.
    expect(isAttended(200, table)).toBe(false);
  });

  it("says no for the ? Linux reports", () => {
    expect(isAttended(300, table)).toBe(false);
  });

  it("says no for an empty or dash tty", () => {
    expect(isAttended(400, table)).toBe(false);
    expect(isAttended(500, table)).toBe(false);
  });

  it("does not guess when the pid is unknown", () => {
    // It may have exited between the listing and the lookup.
    expect(isAttended(999, table)).toBeUndefined();
  });

  it("does not guess when there is no pid at all", () => {
    expect(isAttended(null, table)).toBeUndefined();
  });

  it("does not guess when ps produced nothing", () => {
    // No `ps` on native Windows (PLT-02). Claiming every session is a background
    // one there would hide the session the user is actually working in.
    expect(isAttended(100, new Map())).toBeUndefined();
  });
});
