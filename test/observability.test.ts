/**
 * Two requirements that existed only on paper.
 *
 * OBS-02 — `ASTIR_DEBUG=1` enables verbose logging — was a spec MUST that
 * `grep` could not find a single implementation of. And `everIngested` was the
 * exact inverse of OBS-01: computed on every `/state`, shipped on every
 * response, and read by nothing at all.
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { HOOKS_VERDICT_AFTER_MS, hooksLookUnwired } from "../src/config/plugin.js";
import { renderMenubar } from "../src/status/menubar.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Run the debug module in a fresh process, since the flag is read at import. */
function debugOutput(env: Record<string, string>): string {
  return execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { debug, debugEnabled } from "${pathToFileURL(join(REPO, "dist/obs/debug.js")).href}";
       debug("test", "hello", { n: 1, s: "x", b: true, nil: null });
       process.stdout.write(String(debugEnabled()));`,
    ],
    { env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

describe("OBS-02 — ASTIR_DEBUG", () => {
  it("says nothing at all when unset", () => {
    // The default has to be genuinely silent: a daemon runs for days, and a
    // diagnostic that always prints is a log nobody reads and a disk nobody
    // asked to fill.
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { debug } from "${pathToFileURL(join(REPO, "dist/obs/debug.js")).href}";
         debug("test", "should not appear");`,
      ],
      { env: { ...process.env, ASTIR_DEBUG: "" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(out).toBe("");
  });

  it("emits a scoped, field-tagged line when set", () => {
    const out = debugOutput({ ASTIR_DEBUG: "1" });
    expect(out).toContain("true");
  });

  it("treats only the exact string 1 as on, so a stray truthy value is no surprise", () => {
    // `ASTIR_DEBUG=0` or `ASTIR_DEBUG=false` meaning "on" would be the kind of
    // detail somebody discovers at the worst moment.
    expect(debugOutput({ ASTIR_DEBUG: "0" })).toContain("false");
    expect(debugOutput({ ASTIR_DEBUG: "false" })).toContain("false");
  });
});

describe("`everIngested` is read by something now", () => {
  // `daemonStartedAt` well in the past: the "hooks are unwired" verdict is now
  // gated on the daemon having been up long enough for silence to mean
  // something, so a fixture without it proves nothing either way.
  const body = (over: Record<string, unknown> = {}) => ({
    blockedCount: 0,
    daemonStartedAt: 1_787_000_000_000 - 600_000,
    sessions: [],
    silent: [{ sessionId: "s1", cwd: "/repo", name: null, status: null, pid: null, startedAt: null }],
    ...over,
  });

  const render = (over: Record<string, unknown> = {}) =>
    renderMenubar(
      { ok: true, body: body(over) } as never,
      {
        invocation: ["/opt/node/bin/node", "/usr/local/lib/astir/main.js"],
      } as never,
    );

  it("names the case no other diagnosis covers", () => {
    // Not "this session is old" but "nothing has ever arrived, from anything",
    // which means the hooks were never wired. It is the first-install case, and
    // the one where every other explanation on offer is wrong.
    // Matched on one line's worth: SwiftBar wraps a long note across rows, so
    // a regex spanning the sentence would fail on the line break rather than
    // on the behaviour — which is how the first version of this failed.
    expect(render({ everIngested: false })).toContain("No event has EVER reached astir");
  });

  it("does not claim that when events have arrived", () => {
    expect(render({ everIngested: true })).not.toContain("No event has EVER reached astir");
  });

  it("stays quiet about a daemon that only just started", () => {
    // The false alarm this gate exists for: at 8 seconds old, every daemon has
    // ingested nothing, including one whose hooks are perfect.
    const young = renderMenubar(
      {
        ok: true,
        body: { ...body({ everIngested: false }), daemonStartedAt: 1_787_000_000_000 - 8_000 },
      } as never,
      { invocation: ["/n", "/m.js"], now: 1_787_000_000_000 } as never,
    );
    expect(young).not.toContain("No event has EVER reached astir");
  });

  it("stays quiet when an older daemon omits the field", () => {
    // VER-01 — absent is "cannot tell", and telling someone their hooks are
    // unwired on the strength of a missing field would be worse than silence.
    expect(render()).not.toContain("No event has EVER reached astir");
  });
});

describe("a young daemon is not an unwired one", () => {
  /**
   * `everIngested` is `ingested > 0` for the RUNNING PROCESS, so it is false for
   * every daemon in its first moments — including one whose hooks are wired
   * perfectly. Concluding "the hooks are not wired" from it states the
   * process's age as though it were the user's configuration.
   *
   * Observed on a real machine: a daemon 8 seconds old reported `NO event has
   * ever reached the daemon — they are not wired` while showing 5 sessions and
   * 3383 agents, and had ingested two events by the 22-second mark. Nothing was
   * wrong, and the most alarming line in the report was the false one.
   */
  const NOW = 1_787_000_000_000;
  const started = (agoMs: number) => ({ everIngested: false, daemonStartedAt: NOW - agoMs });

  it("stays quiet about a daemon that has only just started", () => {
    expect(hooksLookUnwired(started(8_000), NOW)).toBe(false);
  });

  it("says so once the silence has lasted long enough to mean something", () => {
    expect(hooksLookUnwired(started(HOOKS_VERDICT_AFTER_MS + 1), NOW)).toBe(true);
  });

  it("never says so when events have arrived, however young", () => {
    expect(hooksLookUnwired({ everIngested: true, daemonStartedAt: NOW - 1 }, NOW)).toBe(false);
  });

  it("says nothing when the daemon is too old to report its age", () => {
    // VER-01 — absent is "cannot tell", and an unprovable accusation is worse
    // than silence here: it sends someone to re-run `astir install` for nothing.
    expect(hooksLookUnwired({ everIngested: false }, NOW)).toBe(false);
  });

  it("says nothing when the field is absent entirely", () => {
    expect(hooksLookUnwired({}, NOW)).toBe(false);
  });
});
