/**
 * The SSH probe sees every Claude profile, not just the default.
 *
 * `${SHELL:-/bin/sh} -lc "claude agents --json"` carries no `CLAUDE_CONFIG_DIR`,
 * so `claude` reads `~/.claude` and a machine whose sessions live anywhere else
 * reports nothing. Measured on the host this polls: **0** sessions from the bare
 * command, **4** with the profile set, **6** across all four profiles once the
 * probe enumerates them.
 *
 * This is the same blindness for the third time — local discovery had it and
 * gained `candidateConfigDirs`, sidecar reading had it and was fixed in #55 —
 * and each time it survives because a miss is indistinguishable from "nothing
 * is running there". It fails quiet.
 *
 * And it fails quiet in the worst place: this poll is DMN-09's FALLBACK for
 * when a machine's daemon is down. On such a host it returned `[]` forever, so
 * the fallback was not degraded but absent, and identical on screen to a
 * machine with nothing running.
 */

import { describe, expect, it } from "vitest";
import { PROFILE_SEPARATOR, parseProfileLines, sshArgs } from "../src/discovery/remote.js";

const agent = (id: string, over: Record<string, unknown> = {}) =>
  JSON.stringify([{ sessionId: id, cwd: "/repo", pid: 1, status: "idle", ...over }]);

const probe = (...chunks: string[]) => chunks.map((c) => `${c}\n${PROFILE_SEPARATOR}`).join("\n");

describe("the probe command asks each profile", () => {
  const cmd = sshArgs("somehost").at(-1) ?? "";

  it("sets CLAUDE_CONFIG_DIR, which is the entire bug", () => {
    expect(cmd).toContain("CLAUDE_CONFIG_DIR=");
  });

  it("iterates every ~/.claude* directory rather than naming one", () => {
    expect(cmd).toContain('"$HOME"/.claude*');
    expect(cmd).toContain("[ -d ");
  });

  it("does not let one profile's failure end the loop", () => {
    // A profile whose `claude` errors must not silence the profiles after it.
    expect(cmd).toContain("|| true");
  });

  it("still runs through a login shell", () => {
    // The ORIGINAL fix in this function: `ssh host cmd` sources no profile, so
    // a version-managed `claude` is not on PATH and the probe returns "command
    // not found" — indistinguishable from a host with nothing running.
    expect(cmd).toContain("-lc");
    expect(cmd).toContain("${SHELL:-/bin/sh}");
  });
});

describe("merging what the profiles answered", () => {
  it("combines sessions across profiles", () => {
    const got = parseProfileLines(probe(agent("a"), agent("b")));
    expect(got?.map((s) => s.sessionId)).toEqual(["a", "b"]);
  });

  it("does not double a session two profiles both report", () => {
    // Two profiles can name one session when one is a symlink of the other. A
    // doubled row is worse than a missing one: nothing downstream can tell.
    const got = parseProfileLines(probe(agent("a"), agent("a")));
    expect(got?.map((s) => s.sessionId)).toEqual(["a"]);
  });

  it("keeps the profiles that worked when one did not", () => {
    const got = parseProfileLines(probe("command not found", agent("a")));
    expect(got?.map((s) => s.sessionId)).toEqual(["a"]);
  });

  it("reports a total failure as null, NOT as an empty list", () => {
    // The distinction the undiscovered sweep and the prune both key off. A
    // failed probe masquerading as "nothing running" is how a live session gets
    // reaped, and it is the reason `parseAgentsJson` returns null at all.
    expect(parseProfileLines(probe("command not found", "also broken"))).toBeNull();
    expect(parseProfileLines("")).toBeNull();
  });

  it("reports profiles that answered with nothing as an empty list", () => {
    // Genuinely nothing running is an ANSWER, and must not read as a failure.
    expect(parseProfileLines(probe("[]", "[]"))).toEqual([]);
  });

  it("survives a pretty-printed answer, which a flattening probe would not", () => {
    // Splitting on the separator rather than on newlines is what makes this
    // work — and avoids escaping a backslash through a JS literal, a login
    // shell and an inner shell.
    const pretty = JSON.stringify([{ sessionId: "a", cwd: "/repo", pid: 1, status: "idle" }], null, 2);
    expect(parseProfileLines(probe(pretty))?.map((s) => s.sessionId)).toEqual(["a"]);
  });
});
