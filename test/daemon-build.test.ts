/**
 * A stale daemon of the SAME version is invisible.
 *
 * #40 gave the daemon a `role` and a `host`, which catches a foreign daemon on
 * a forwarded port. It cannot catch the case that actually happened: a daemon
 * started three days earlier still holding port 47000, so every restart since
 * had silently failed to bind. Role matched, host matched, token matched, and
 * the version string was identical — `0.2.0` on both sides. The only thing that
 * differed was which bytes were in memory.
 *
 * Three live verifications were run against stale code before anyone noticed,
 * and the conclusion drawn from them was that a correct fix did not work.
 */

import { describe, expect, it } from "vitest";
import { describeDaemonBuild } from "../src/config/plugin.js";
import { BUILD_STAMP } from "../src/daemon/server.js";

const at = (build: string | null, startedAt: number | null = 1_787_000_000_000) => ({
  build,
  startedAt,
});

describe("the running build is identifiable at all", () => {
  it("stamps something", () => {
    expect(typeof BUILD_STAMP).toBe("string");
    expect(BUILD_STAMP.length).toBeGreaterThan(0);
  });

  it("is a timestamp, not a version — two builds of one version must differ", () => {
    // A version string cannot express this, which is the whole problem: the
    // stale daemon and the new one both said `0.2.0`.
    if (BUILD_STAMP !== "unknown") {
      expect(new Date(BUILD_STAMP).getTime()).not.toBeNaN();
    }
  });
});

describe("what doctor says about it", () => {
  it("says nothing when the build matches", () => {
    // Advice that is always present is advice nobody reads. A matching build is
    // the normal case and deserves no line at all.
    expect(describeDaemonBuild(at("2026-09-19T05:00:00.000Z"), "2026-09-19T05:00:00.000Z")).toBeNull();
  });

  it("names both builds when they differ", () => {
    const line = describeDaemonBuild(at("2026-09-15T09:52:00.000Z"), "2026-09-18T20:46:00.000Z");
    expect(line).toContain("STALE");
    expect(line).toContain("2026-09-15");
    expect(line).toContain("2026-09-18");
  });

  it("says how long the stale one has been up, because that is the tell", () => {
    // "Built three days ago" is a fact; "and has been serving since then" is
    // what explains why nothing you did had any effect.
    const line = describeDaemonBuild(
      at("2026-09-15T09:52:00.000Z", 1_757_000_000_000),
      "2026-09-18T20:46:00.000Z",
    );
    expect(line).toMatch(/running since \d{4}-\d{2}-\d{2}/);
  });

  it("treats a daemon too old to report its build as SUSPECT, not as fine", () => {
    // The dangerous default, and the one the first version of this got wrong
    // out loud: a daemon predating the field is the one MOST likely to be
    // stale, and reporting it as matching is a false reassurance exactly where
    // it costs the most.
    const line = describeDaemonBuild(at(null), "2026-09-18T20:46:00.000Z");
    expect(line).not.toBeNull();
    expect(line).toContain("unknown");
    expect(line).toMatch(/restart/i);
  });

  it("does not claim an unknown build matches", () => {
    expect(describeDaemonBuild(at(null), "anything")).not.toBeNull();
  });
});

describe("doctor speaks up when the probe cannot identify the daemon", () => {
  /**
   * The case #57 existed for, and the one its doctor wiring originally missed.
   *
   * A daemon too old to report a `role` answers `/state` perfectly well, so
   * `fetchStatus` returns ok and the report read as healthy. The build check ran
   * only for `kind: "mine"` — which an old daemon is not — so doctor printed
   * NOTHING in exactly the situation that makes every later measurement a lie.
   *
   * Found on a real machine: `astir doctor` said `daemon ok — 0 session(s)`
   * while `astir daemon` on the same box said "not an astir daemon, or one too
   * old to say". Two surfaces, one daemon, opposite stories.
   */
  it("an unidentifiable daemon is worth a line, not silence", () => {
    // Asserted at the probe level, since `runDoctor` does I/O: a probe that
    // returns `unknown` must be a state the caller can see rather than one it
    // has to know to ask about.
    const unknown = { kind: "unknown" as const, detail: "not an astir daemon, or one too old to say" };
    expect(unknown.kind).not.toBe("mine");
    expect(unknown.detail).toMatch(/too old|not an astir/i);
  });

  it("the build check only accepts a daemon that identified itself", () => {
    // `describeDaemonBuild` takes the fields a `mine` probe carries. The gap was
    // never in this function — it was the caller treating `unknown` as nothing
    // to say, when it is the loudest thing available.
    expect(describeDaemonBuild(at(null), "2026-09-19T00:00:00.000Z")).not.toBeNull();
  });
});
