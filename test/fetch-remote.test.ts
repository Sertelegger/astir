import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchHealth, fetchRemote, fetchStatus, foreignHost, UNNAMED_HOST } from "../src/status/fetch.js";

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

/**
 * `astir status --line` (#80) has to tell apart failures that `reason` only
 * describes in English: a daemon that is not running, one that hangs, and
 * another machine's daemon answering through a forwarded port each print a
 * different line, and parsing that back out of prose is the coupling #63 took
 * out of the menu bar.
 */
describe("fetchStatus says WHY it failed, as a value", () => {
  function stubState(status: number, body: unknown): void {
    vi.stubEnv("ASTIR_TOKEN", TOKEN);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );
  }

  it("nothing listening is `absent`", async () => {
    vi.stubEnv("ASTIR_TOKEN", TOKEN);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const r = await fetchStatus(47_000, 3_000, SELF);
    expect(r).toMatchObject({ ok: false, kind: "absent" });
  });

  it("a 401 is `rejected`, any other failure status is `http`", async () => {
    stubState(401, {});
    expect(await fetchStatus(47_000, 3_000, SELF)).toMatchObject({ ok: false, kind: "rejected" });
    stubState(500, {});
    expect(await fetchStatus(47_000, 3_000, SELF)).toMatchObject({ ok: false, kind: "http" });
  });

  it("another machine's daemon is `foreign`, and names that machine", async () => {
    stubState(200, { blockedCount: 0, sessions: [], host: "laptop" });
    const r = await fetchStatus(47_000, 3_000, SELF);
    expect(r).toMatchObject({ ok: false, kind: "foreign", host: "laptop" });
  });

  it("compares against an injected self host, not the real one", async () => {
    // The same trap the remote filter above documents: a fixture derived from
    // the real `hostname()` behaves differently on Linux and macOS.
    stubState(200, { blockedCount: 0, sessions: [], host: `${SELF}.local` });
    expect((await fetchStatus(47_000, 3_000, SELF)).ok).toBe(true);
  });

  it("no token is `no-token`, and asks nothing of the network", async () => {
    // `homedir()` follows $HOME, so pointing it at nowhere is enough to make
    // the token file absent without touching the real one.
    vi.stubEnv("ASTIR_TOKEN", undefined);
    vi.stubEnv("HOME", "/nonexistent/astir-fetch-test");
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await fetchStatus(47_000, 3_000, SELF)).toMatchObject({ ok: false, kind: "no-token" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("an aborted caller signal is `timeout`, never `absent`", async () => {
    // The distinction the line exists for: a hung daemon must read as
    // "unreachable", not as "not running", which would be a stale guess.
    vi.stubEnv("ASTIR_TOKEN", TOKEN);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );
    const ac = new AbortController();
    const pending = fetchStatus(47_000, 60_000, SELF, ac.signal);
    ac.abort();
    expect(await pending).toMatchObject({ ok: false, kind: "timeout" });
  }, 2_000);

  it("its OWN timeout passing is `timeout` too, never `absent`", async () => {
    // AbortSignal.timeout rejects with a TimeoutError, not an AbortError.
    vi.stubEnv("ASTIR_TOKEN", TOKEN);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );
    expect(await fetchStatus(47_000, 10, SELF)).toMatchObject({ ok: false, kind: "timeout" });
  }, 2_000);

  it("a /state host that is not a string is 'cannot tell', never a crash", async () => {
    stubState(200, { blockedCount: 0, sessions: [], host: 123 });
    expect((await fetchStatus(47_000, 3_000, SELF)).ok).toBe(true);
  });

  it("names a foreign daemon only in characters a terminal or tmux will not act on", async () => {
    stubState(200, { blockedCount: 0, sessions: [], host: "ev#[fg=red]il\u001b]0;x\u0007" });
    const r = await fetchStatus(47_000, 3_000, SELF);
    expect(r).toMatchObject({ ok: false, kind: "foreign", host: UNNAMED_HOST });
    expect(r.ok ? "" : r.reason).not.toMatch(/\p{Cc}|#/u);
  });
});

describe("fetchHealth — the daemon's unauthenticated probe", () => {
  it("returns the body, delivery included", async () => {
    const body = { ok: true, role: "daemon", host: "devbox", delivery: { live: ["local"] } };
    const spy = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", spy);
    expect(await fetchHealth(47_000)).toEqual(body);
    // No token: `/healthz` answers without one, and a missing token must not
    // blind the line to "nothing can notify you".
    const init = (spy.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get("authorization")).toBeNull();
  });

  it("is null when nothing answers, or something other than JSON does", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expect(await fetchHealth(47_000)).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>", { status: 200 })),
    );
    expect(await fetchHealth(47_000)).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 })),
    );
    expect(await fetchHealth(47_000)).toBeNull();
  });

  it("is null for JSON that is not an object — a number, a string, null", async () => {
    for (const text of ["42", '"ok"', "null"]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(text, { status: 200 })),
      );
      expect(await fetchHealth(47_000), text).toBeNull();
    }
  });

  it("passes an external abort through to the request", async () => {
    // `status --line` aborts every fetch when its budget runs out; a /healthz
    // left in flight would hold the process open past the line.
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            seen = init.signal ?? undefined;
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );
    const ac = new AbortController();
    const pending = fetchHealth(47_000, 60_000, ac.signal);
    ac.abort();
    expect(await pending).toBeNull();
    expect(seen?.aborted).toBe(true);
  }, 2_000);
});

describe("fetchRemote honours the caller's budget", () => {
  it("passes an external abort through to the request", async () => {
    // One budget for every fetch `status --line` makes: the caller aborts, and
    // nothing is left holding the process open after the line is printed.
    vi.stubEnv("ASTIR_NOTIFY_TOKEN", TOKEN);
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            seen = init.signal ?? undefined;
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );
    const ac = new AbortController();
    const pending = fetchRemote(47_001, 60_000, SELF, ac.signal);
    ac.abort();
    expect(await pending).toBeNull();
    expect(seen?.aborted).toBe(true);
  }, 2_000);
});

/**
 * The one host check every surface shares, fed what a socket said. `/healthz`
 * needs no token, so whatever is listening on the port wrote `host`.
 */
describe("foreignHost", () => {
  it("is null — cannot tell — for an absent host or one that is not a string", () => {
    for (const host of [undefined, null, 123, { a: 1 }, ["laptop"]]) {
      expect(foreignHost(host, SELF), JSON.stringify(host)).toBeNull();
    }
  });

  it("is null for this machine, however either end spells it", () => {
    expect(foreignHost(`${SELF}.local`, SELF)).toBeNull();
    expect(foreignHost("DEVBOX", `${SELF}.lan`)).toBeNull();
  });

  it("compares the name as reported, and never prints a cleaned-up one", () => {
    // Cleaning `dev#box` would print `devbox` — this machine's own name — on
    // the warning that says the daemon is NOT this machine's.
    expect(foreignHost("dev#box", "devbox")).toBe(UNNAMED_HOST);
    expect(foreignHost("dev\u001bbox", "devbox")).toBe(UNNAMED_HOST);
  });

  it("prints a name that already is one hostname label, first label only", () => {
    expect(foreignHost("laptop.local", SELF)).toBe("laptop");
    expect(foreignHost("my_box-2", SELF)).toBe("my_box-2");
    expect(foreignHost("a".repeat(63), SELF)).toBe("a".repeat(63));
  });

  it("is still foreign — never null, which means 'mine' — when the name is not printable", () => {
    for (const host of ["ev#[fg=red]il", "laptop\nevil", "\u001b[2J\u0007", "a".repeat(64), "", "  "]) {
      expect(foreignHost(host, SELF), JSON.stringify(host)).toBe(UNNAMED_HOST);
    }
  });
});
