import { afterEach, describe, expect, it } from "vitest";
import { pairedHosts } from "../src/cli/pair.js";
import { FORGET_AFTER_MS, RemoteDiscovery, STALE_AFTER_MS, sshArgs } from "../src/discovery/remote.js";
import { mergeRemoteSessions, RosterStore, rosterUrlFrom, validateRoster } from "../src/notify/roster.js";
import { NotifierServer } from "../src/notify/server.js";
import type { RemoteSession } from "../src/status/types.js";

const TOKEN = "r".repeat(48);

describe("paired hosts (DMN-09)", () => {
  const config = `
Host devbox
  RemoteForward 47001 127.0.0.1:47001

Host laptop
  User sascha

Host megabrain-dev
  HostName 10.0.0.4
  RemoteForward 47001 127.0.0.1:47001
`;

  it("finds the hosts pair set a forward up for", () => {
    // Derived from the file that already records pairing, so the two can never
    // disagree and un-pairing is just deleting the stanza.
    expect(pairedHosts(config, 47001)).toEqual(["devbox", "megabrain-dev"]);
  });

  it("ignores a host with no forward", () => {
    expect(pairedHosts(config, 47001)).not.toContain("laptop");
  });

  it("ignores a forward on a different port", () => {
    expect(pairedHosts("Host x\n  RemoteForward 9999 127.0.0.1:9999\n", 47001)).toEqual([]);
  });

  it("skips wildcard patterns, which are not hosts you can ssh to", () => {
    expect(pairedHosts("Host *\n  RemoteForward 47001 127.0.0.1:47001\n", 47001)).toEqual([]);
  });

  it("handles a stanza naming several hosts", () => {
    expect(pairedHosts("Host a b\n  RemoteForward 47001 127.0.0.1:47001\n", 47001)).toEqual(["a", "b"]);
  });
});

describe("SSH discovery (DMN-09)", () => {
  const session = (id: string) => ({
    sessionId: id,
    cwd: `/home/u/${id}`,
    pid: 1,
    status: "idle",
    name: id,
    startedAt: null,
  });

  it("reports sessions found on a paired host", async () => {
    const now = 1_000;
    const d = new RemoteDiscovery({
      hosts: () => ["devbox"],
      list: async () => [session("a")],
      now: () => now,
    });
    await d.poll();
    expect(d.list()).toMatchObject([{ host: "devbox", sessionId: "a", source: "ssh" }]);
  });

  it("keeps an unreachable host's sessions, marked stale", async () => {
    // Dropping them would render an unreachable machine identically to one with
    // nothing running, which is the lie this project exists downstream of.
    let now = 1_000;
    let reachable = true;
    const d = new RemoteDiscovery({
      hosts: () => ["devbox"],
      list: async () => (reachable ? [session("a")] : null),
      now: () => now,
    });
    await d.poll();
    reachable = false;
    now += STALE_AFTER_MS + 1;
    await d.poll();

    expect(d.list()).toMatchObject([{ sessionId: "a", stale: true }]);
  });

  it("eventually stops claiming to know anything about a long-dead host", async () => {
    let now = 1_000;
    let reachable = true;
    const d = new RemoteDiscovery({
      hosts: () => ["devbox"],
      list: async () => (reachable ? [session("a")] : null),
      now: () => now,
    });
    await d.poll();
    reachable = false;
    now += FORGET_AFTER_MS + 1;
    expect(d.list()).toEqual([]);
  });

  it("drops a host that is no longer paired, rather than ageing it out", async () => {
    const now = 1_000;
    let hosts = ["devbox"];
    const d = new RemoteDiscovery({
      hosts: () => hosts,
      list: async () => [session("a")],
      now: () => now,
    });
    await d.poll();
    hosts = [];
    await d.poll();
    expect(d.list()).toEqual([]);
  });

  it("an empty list means nothing is running, and replaces what was there", async () => {
    const now = 1_000;
    let sessions = [session("a")];
    const d = new RemoteDiscovery({
      hosts: () => ["devbox"],
      list: async () => sessions,
      now: () => now,
    });
    await d.poll();
    sessions = [];
    await d.poll();
    expect(d.list()).toEqual([]);
  });

  it("runs the probe through a LOGIN shell, or claude is not on PATH", () => {
    // `ssh host cmd` runs a non-interactive, non-login shell that sources no
    // profile, so a version-manager `claude` is absent and the probe returns
    // "command not found" — indistinguishable here from a host running nothing.
    // Verified against a real host: the bare form failed, this one succeeded.
    const args = sshArgs("devbox");
    const command = args.at(-1) ?? "";
    expect(command).toContain("-lc");
    expect(command).toContain("claude agents --json");
    expect(args).toContain("BatchMode=yes");
  });

  it("never prompts, since the daemon has no terminal to answer on", () => {
    expect(sshArgs("devbox")).toContain("BatchMode=yes");
    expect(sshArgs("devbox", 8_000)).toContain("ConnectTimeout=8");
  });

  it("asks every host concurrently, so one slow box does not delay the rest", async () => {
    const started: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const d = new RemoteDiscovery({
      hosts: () => ["slow", "fast"],
      list: async (h) => {
        started.push(h);
        if (h === "slow") await gate;
        return [];
      },
    });
    const polling = d.poll();
    // Both are in flight before the slow one has answered.
    expect(started).toEqual(["slow", "fast"]);
    release();
    await polling;
  });
});

describe("roster payloads (DMN-10)", () => {
  it("rejects a body with no host", () => {
    expect(validateRoster({ sessions: [] }).ok).toBe(false);
  });

  it("rejects an absurd number of sessions", () => {
    const sessions = Array.from({ length: 500 }, (_, i) => ({ sessionId: `s${i}`, cwd: "/x" }));
    expect(validateRoster({ host: "h", sessions }).ok).toBe(false);
  });

  it("skips malformed entries rather than rejecting the whole roster", () => {
    // One bad record should not blind us to a machine's other sessions.
    const r = validateRoster({
      host: "h",
      sessions: [{ sessionId: "a", cwd: "/x" }, { nope: true }, "junk"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.roster.sessions).toHaveLength(1);
  });

  it("carries the attended flag, which only the far side can determine", () => {
    // A controlling terminal is a local fact; `claude agents --json` does not
    // report one, so the SSH poll cannot classify. The push is the only route
    // by which a remote background session can be recognised.
    const r = validateRoster({
      host: "h",
      sessions: [{ sessionId: "a", cwd: "/x", attended: false }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.roster.sessions[0]?.attended).toBe(false);
  });

  it("leaves attended unset when the sender did not say", () => {
    const r = validateRoster({ host: "h", sessions: [{ sessionId: "a", cwd: "/x" }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.roster.sessions[0]?.attended).toBeUndefined();
  });

  it("derives the roster route from the notify route", () => {
    expect(rosterUrlFrom("http://127.0.0.1:47001/notify")).toBe("http://127.0.0.1:47001/roster");
  });
});

describe("roster store (DMN-10)", () => {
  it("replaces a host's roster rather than accumulating", () => {
    // A machine that stops running something reports a shorter roster; a store
    // that only added would leave finished sessions on screen forever.
    const now = 1_000;
    const store = new RosterStore(() => now);
    store.apply({ host: "h", sessions: [{ sessionId: "a", cwd: "/a", name: null, status: null }] });
    store.apply({ host: "h", sessions: [{ sessionId: "b", cwd: "/b", name: null, status: null }] });
    expect(store.list().map((s) => s.sessionId)).toEqual(["b"]);
  });

  it("marks a host stale when it stops announcing", () => {
    let now = 1_000;
    const store = new RosterStore(() => now);
    store.apply({ host: "h", sessions: [{ sessionId: "a", cwd: "/a", name: null, status: null }] });
    now += 91_000;
    expect(store.list()).toMatchObject([{ stale: true }]);
  });

  it("keeps hosts independent", () => {
    const now = 1_000;
    const store = new RosterStore(() => now);
    store.apply({ host: "h1", sessions: [{ sessionId: "a", cwd: "/a", name: null, status: null }] });
    store.apply({ host: "h2", sessions: [{ sessionId: "b", cwd: "/b", name: null, status: null }] });
    expect(
      store
        .list()
        .map((s) => s.host)
        .sort(),
    ).toEqual(["h1", "h2"]);
  });
});

describe("merging the two routes", () => {
  const s = (over: Partial<RemoteSession>): RemoteSession => ({
    host: "devbox",
    sessionId: "a",
    cwd: "/x",
    name: null,
    status: null,
    source: "ssh",
    lastSeen: 0,
    ...over,
  });

  it("prefers the push, which comes from the daemon actually watching it", () => {
    const merged = mergeRemoteSessions([s({ source: "push", status: "busy" })], [s({ status: "idle" })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ source: "push", status: "busy" });
  });

  it("keeps sessions only one route knows about", () => {
    const merged = mergeRemoteSessions(
      [s({ sessionId: "pushed", source: "push" })],
      [s({ sessionId: "polled" })],
    );
    expect(merged.map((x) => x.sessionId).sort()).toEqual(["polled", "pushed"]);
  });

  it("does not merge the same session id across different hosts", () => {
    const merged = mergeRemoteSessions([], [s({ host: "a" }), s({ host: "b" })]);
    expect(merged).toHaveLength(2);
  });
});

describe("the notifier's roster route", () => {
  const open: NotifierServer[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  const serve = async (host = "this-mac"): Promise<number> => {
    const server = new NotifierServer({ token: TOKEN, notify: () => undefined, host });
    open.push(server);
    return server.listen(0);
  };

  const post = (port: number, body: unknown, token = TOKEN): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/roster`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("accepts a roster and serves it back on /state", async () => {
    const port = await serve();
    const res = await post(port, {
      host: "megabrain-dev",
      sessions: [{ sessionId: "s1", cwd: "/srv/app", name: "app-aa", status: "busy" }],
    });
    expect(res.status).toBe(200);

    const state = await fetch(`http://127.0.0.1:${port}/state`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }).then((r) => r.json() as Promise<{ sessions: RemoteSession[] }>);

    expect(state.sessions).toMatchObject([
      { host: "megabrain-dev", sessionId: "s1", cwd: "/srv/app", source: "push" },
    ]);
  });

  it("ignores a roster this machine sent to itself", async () => {
    // A local daemon and this notifier cannot be told apart by address: a remote
    // daemon arrives through `ssh -R` on 127.0.0.1, exactly where a local one
    // sits. Without this guard every local session would come back as "another
    // machine".
    const port = await serve("this-mac");
    const res = await post(port, {
      host: "this-mac",
      sessions: [{ sessionId: "local-1", cwd: "/home/me/repo", name: null, status: null }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: "self" });

    const state = await fetch(`http://127.0.0.1:${port}/state`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }).then((r) => r.json() as Promise<{ sessions: RemoteSession[] }>);
    expect(state.sessions).toEqual([]);
  });

  it("still accepts a roster from a genuinely different machine", async () => {
    const port = await serve("this-mac");
    await post(port, {
      host: "megabrain-dev",
      sessions: [{ sessionId: "r1", cwd: "/srv/app", name: null, status: null }],
    });
    const state = await fetch(`http://127.0.0.1:${port}/state`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }).then((r) => r.json() as Promise<{ sessions: RemoteSession[] }>);
    expect(state.sessions).toHaveLength(1);
  });

  it("rejects an unauthenticated roster", async () => {
    const port = await serve();
    expect((await post(port, { host: "h", sessions: [] }, "wrong")).status).toBe(401);
  });

  it("rejects a malformed roster without disturbing what it already knows", async () => {
    const port = await serve();
    await post(port, { host: "h", sessions: [{ sessionId: "a", cwd: "/a" }] });
    expect((await post(port, { sessions: [] })).status).toBe(400);

    const state = await fetch(`http://127.0.0.1:${port}/state`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }).then((r) => r.json() as Promise<{ sessions: RemoteSession[] }>);
    expect(state.sessions).toHaveLength(1);
  });
});
