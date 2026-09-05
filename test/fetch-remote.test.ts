import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRemote } from "../src/status/fetch.js";

/**
 * A fixed name rather than the real `hostname()`.
 *
 * The first version of this file built its fixtures by appending to the machine's
 * own hostname, which passed on Linux and failed on macOS: the name there carries
 * a `.local` suffix, so `${SELF}-2` still has `SELF`'s first label and counted as
 * this machine. Exactly the trap the comparison exists to handle, sprung by the
 * test for it.
 */
const SELF = "devbox";
const TOKEN = "t".repeat(48);

/** The notifier's `/state`, as `fetchRemote` will find it. */
function stubNotifier(body: unknown): void {
  vi.stubEnv("ASTIR_NOTIFY_TOKEN", TOKEN);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

const session = (host: string, sessionId: string) => ({
  host,
  sessionId,
  cwd: "/repo",
  name: null,
  status: null,
  source: "push" as const,
  lastSeen: 0,
});

const agent = (host: string, sessionId: string) => ({
  host,
  repo: "/repo",
  sessionId,
  agentId: "a",
  reason: "needs input",
  since: 0,
  lastSeen: 0,
  acknowledged: false,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("reading the notifier — what came from this machine does not come back", () => {
  it("drops sessions this machine pushed, and keeps everyone else's", async () => {
    // Reported from real use: every local session appeared a second time under
    // "Other machines", attributed to the very box showing it. The notifier was
    // on a Mac reached through `ssh -R`, so it stored this container's roster
    // correctly — and the container polled it on 127.0.0.1 and read itself back.
    stubNotifier({
      sessions: [session(SELF, "mine"), session("some-other-box", "theirs")],
      agents: [],
    });

    const got = await fetchRemote(47001, 3_000, SELF);
    expect(got?.sessions.map((s) => s.sessionId)).toEqual(["theirs"]);
  });

  it("drops blocked agents the same way", async () => {
    // A doorbell carries an origin host too, and unlike a roster it is not
    // origin-checked on the way IN, so the blocked list reflects by the same
    // route. Not reproducible on the machine where this was found — nothing was
    // blocked at the time — so it is guarded by reasoning, and by this.
    stubNotifier({
      sessions: [],
      agents: [agent(SELF, "mine"), agent("some-other-box", "theirs")],
    });

    const got = await fetchRemote(47001, 3_000, SELF);
    expect(got?.agents.map((a) => a.sessionId)).toEqual(["theirs"]);
  });

  it("still counts as self when one end spells the host as a FQDN", async () => {
    // `hostname()` returns a FQDN on some machines and a short name on others.
    // A comparison that misses here fails OPEN — it reports this machine as
    // someone else's — and nothing announces that it happened.
    stubNotifier({ sessions: [session(`${SELF}.local`, "mine")], agents: [] });

    const got = await fetchRemote(47001, 3_000, SELF);
    expect(got?.sessions).toEqual([]);
  });

  it("does not drop a different machine that merely shares a prefix", async () => {
    stubNotifier({ sessions: [session(`${SELF}-2`, "theirs")], agents: [] });

    const got = await fetchRemote(47001, 3_000, SELF);
    expect(got?.sessions.map((s) => s.sessionId)).toEqual(["theirs"]);
  });

  it("compares on the first label when THIS machine is the one with the FQDN", async () => {
    // The macOS direction, and the one CI caught: `hostname()` there returns
    // `something.local`, so a self host may carry the suffix while the roster
    // does not. Both directions must reduce, or the guard works on Linux and
    // silently stops on a Mac.
    stubNotifier({
      sessions: [session("devbox", "mine"), session("devbox-2", "theirs")],
      agents: [],
    });

    const got = await fetchRemote(47001, 3_000, "devbox.local");
    expect(got?.sessions.map((s) => s.sessionId)).toEqual(["theirs"]);
  });

  it("treats a notifier with no roster at all as empty, not as an error", async () => {
    // An older notifier has only doorbells to report. That is not a fault.
    stubNotifier({ agents: [] });

    const got = await fetchRemote(47001, 3_000, SELF);
    expect(got).toEqual({ agents: [], sessions: [] });
  });
});
