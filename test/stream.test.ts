import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AstirEvent, CONTRACT_VERSION, type Kind } from "../src/contract/event.js";
import { Daemon } from "../src/daemon/server.js";
import { observe, StreamState, sseFrame } from "../src/daemon/stream.js";
import { resolveAsset } from "../src/daemon/view.js";
import { Registry } from "../src/model/registry.js";
import type { Delta, Snapshot } from "../src/status/frames.js";

const TOKEN = "t".repeat(48);

let seq = 0;
function ev(kind: Kind, over: Partial<AstirEvent> = {}): AstirEvent {
  seq++;
  return {
    v: CONTRACT_VERSION,
    eventId: `e${seq}`,
    provider: "claude",
    sessionId: "s1",
    ts: 1_786_900_000 + seq,
    kind,
    agentId: "s1",
    agentType: null,
    parentAgentId: null,
    parentSource: null,
    tool: null,
    description: null,
    paths: [],
    op: null,
    ok: null,
    notificationKind: null,
    ...over,
  };
}

function registryWithSession(): Registry {
  const r = new Registry({ nowMs: () => 1_000 });
  r.apply(ev("session_start"), "/repo");
  return r;
}

const look = (r: Registry, id = "s1") => {
  const s = r.get(id);
  return s === undefined ? null : observe(s, 1_000);
};

describe("StreamState — the contract the client is written against", () => {
  it("opens with a snapshot, never a delta", () => {
    // A client that joins mid-session has nothing to apply a delta to.
    const r = registryWithSession();
    const stream = new StreamState("s1");
    expect(stream.next(look(r))?.kind).toBe("snapshot");
  });

  it("says nothing at all while nothing changes", () => {
    const r = registryWithSession();
    const stream = new StreamState("s1");
    stream.next(look(r));
    expect(stream.next(look(r))).toBeNull();
    expect(stream.next(look(r))).toBeNull();
  });

  it("does not burn a sequence number on a quiet tick", () => {
    // Otherwise the client sees 1 then 5 and cannot tell a gap — which means
    // frames were lost and it must resync — from a session that was simply idle.
    const r = registryWithSession();
    const stream = new StreamState("s1");
    const first = stream.next(look(r)) as Snapshot;
    for (let i = 0; i < 5; i++) stream.next(look(r));

    r.apply(ev("pre_tool", { tool: "Edit", paths: ["a.ts"] }), "/repo");
    const next = stream.next(look(r)) as Delta;

    expect(first.seq).toBe(1);
    expect(next.seq).toBe(2);
  });

  it("reports a touched file as a delta", () => {
    const r = registryWithSession();
    const stream = new StreamState("s1");
    stream.next(look(r));

    r.apply(ev("pre_tool", { tool: "Edit", paths: ["src/a.ts"] }), "/repo");
    const delta = stream.next(look(r)) as Delta;

    expect(delta.kind).toBe("delta");
    expect(delta.files?.upsert.map((f) => f.path)).toEqual(["src/a.ts"]);
  });

  it("ends when the session is gone, and stays ended", () => {
    // The view must be able to say "this session finished" rather than just
    // going quiet, which is indistinguishable from a dead daemon.
    const r = registryWithSession();
    const stream = new StreamState("s1");
    stream.next(look(r));

    expect(stream.next(null)).toEqual({ kind: "end", sessionId: "s1", reason: "gone" });
    expect(stream.next(null)).toBeNull();
    expect(stream.next(look(r))).toBeNull();
  });
});

describe("SSE framing", () => {
  it("carries an id for data frames so a client can detect a gap", () => {
    const r = registryWithSession();
    const stream = new StreamState("s1");
    const text = sseFrame(stream.next(look(r)) as Snapshot);

    expect(text).toMatch(/^id: 1\nevent: snapshot\ndata: \{/);
    expect(text.endsWith("\n\n")).toBe(true);
  });

  it("never emits a bare newline inside data, which would split the frame", () => {
    // JSON.stringify escapes them; this asserts nobody swaps it for something
    // that does not, since the failure is a silently truncated frame.
    const r = registryWithSession();
    r.apply(ev("pre_tool", { tool: "Edit", paths: ["we\nird.ts"] }), "/repo");
    const stream = new StreamState("s1");
    const text = sseFrame(stream.next(look(r)) as Snapshot);

    expect(text.split("\n\n")).toHaveLength(2);
  });
});

describe("view assets cannot escape their root", () => {
  it.each([
    "/view/../../../../etc/passwd",
    "/view/..%2f..%2fetc%2fpasswd",
    "/view/subdir/../../../package.json",
    "/view/\0/etc/passwd",
  ])("refuses %s", (path) => {
    expect(resolveAsset("/tmp/astir-view-root", path)).toBeNull();
  });

  it("refuses a traversal that would land on a REAL file", () => {
    // The cases above can pass merely because the target does not exist, which
    // would make them agree with a guard that had been deleted. Rooting one
    // directory down means `..` resolves onto a file that certainly is there,
    // so only the containment check can be what refuses it.
    const root = join(process.cwd(), "src");
    expect(resolveAsset(root, "/view/../package.json")).toBeNull();
    expect(resolveAsset(process.cwd(), "/view/package.json")).not.toBeNull();
  });
});

/* ── over a real socket ─────────────────────────────────────────────────── */

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function serve(
  registry: Registry,
  streamTickMs = 10,
  streamBufferedBytes?: () => number,
): Promise<number> {
  const daemon = new Daemon({
    token: TOKEN,
    registry,
    streamTickMs,
    viewRoot: "/nonexistent-view-root",
    ...(streamBufferedBytes === undefined ? {} : { streamBufferedBytes }),
  });
  const port = await daemon.listen(0);
  open.push(() => daemon.close());
  return port;
}

interface Received {
  events: Array<{ kind: string; data: Record<string, unknown> }>;
  cancel: () => void;
  done: Promise<void>;
}

/** Read an SSE body far enough to see `want` events, then let go. */
function read(res: Response, want: number): Received {
  const events: Received["events"] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let settle: () => void = () => {};
  const done = new Promise<void>((r) => {
    settle = r;
  });

  const pump = async (): Promise<void> => {
    for (;;) {
      const { value, done: fin } = await reader.read();
      if (fin) break;
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf("\n\n");
      while (cut !== -1) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const kind = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (kind !== undefined && data !== undefined) {
          events.push({ kind, data: JSON.parse(data) as Record<string, unknown> });
        }
        if (events.length >= want) {
          settle();
          return;
        }
        cut = buffer.indexOf("\n\n");
      }
    }
    settle();
  };
  void pump().catch(() => settle());

  return { events, cancel: () => void reader.cancel().catch(() => {}), done };
}

async function counters(port: number): Promise<Record<string, number>> {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  return ((await res.json()) as { counters: Record<string, number> }).counters;
}

const stream = (port: number, session: string, token = TOKEN): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/stream?session=${session}`, {
    headers: { authorization: `Bearer ${token}` },
  });

describe("GET /stream", () => {
  it("requires the token, like every other data route", async () => {
    const port = await serve(registryWithSession());
    expect((await stream(port, "s1", "wrong")).status).toBe(401);
  });

  it("404s for a session that does not exist", async () => {
    const port = await serve(registryWithSession());
    expect((await stream(port, "nope")).status).toBe(404);
  });

  it("sends a snapshot immediately, not after the first tick", async () => {
    // A view that shows nothing for a second on every load reads as broken, so
    // this is asserted rather than left to the tick timer. The tick here is a
    // minute precisely so that a snapshot arriving at all proves it did NOT come
    // from the timer — with a fast tick this test would pass either way.
    const port = await serve(registryWithSession(), 60_000);
    const res = await stream(port, "s1");
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const got = read(res, 1);
    await got.done;
    got.cancel();

    expect(got.events[0]?.kind).toBe("snapshot");
    expect(got.events[0]?.data.sessionId).toBe("s1");
  });

  it("follows a live session with deltas", async () => {
    const registry = registryWithSession();
    const port = await serve(registry);
    const got = read(await stream(port, "s1"), 2);

    // Let the snapshot land, then do something worth reporting.
    await new Promise((r) => setTimeout(r, 30));
    registry.apply(ev("pre_tool", { tool: "Edit", paths: ["src/live.ts"] }), "/repo");

    await got.done;
    got.cancel();

    expect(got.events.map((e) => e.kind)).toEqual(["snapshot", "delta"]);
    const delta = got.events[1]?.data as unknown as Delta | undefined;
    expect(delta?.files?.upsert.map((f) => f.path)).toEqual(["src/live.ts"]);
  });

  it("drops a client that stops draining, rather than buffering for it forever", async () => {
    // #11 — the failure `write`'s error path cannot see. A suspended laptop or
    // a stalled tunnel leaves the socket open and simply stops reading, so
    // nothing throws and nothing closes; the daemon just accumulates.
    //
    // Only the MEASUREMENT is faked. A client that stops reading does not
    // create backpressure until the kernel's own buffer fills, so producing
    // this for real would mean moving megabytes and still racing. The
    // threshold, the drop and the counter are production code.
    let stalled = false;
    const registry = registryWithSession();
    const port = await serve(registry, 10, () => (stalled ? 2 * 1024 * 1024 : 0));
    const res = await stream(port, "s1");
    const got = read(res, 1);
    await got.done;

    // A healthy client is not dropped, however long it stays connected.
    await new Promise((r) => setTimeout(r, 60));
    expect((await counters(port)).streamsOpen).toBe(1);
    expect((await counters(port)).streamsDropped).toBe(0);

    // Now it stops draining while leaving the socket open.
    stalled = true;
    await new Promise((r) => setTimeout(r, 60));

    const after = await counters(port);
    expect(after.streamsDropped).toBe(1);
    expect(after.streamsOpen).toBe(0);
    got.cancel();
  });

  it("releases the connection slot when the client goes away", async () => {
    // The leak that would otherwise only show up after a day of reloading a tab.
    const port = await serve(registryWithSession());
    const res = await stream(port, "s1");
    const got = read(res, 1);
    await got.done;

    expect((await counters(port)).streamsOpen).toBe(1);

    got.cancel();
    await new Promise((r) => setTimeout(r, 100));

    const after = await counters(port);
    expect(after.streamsOpen).toBe(0);
    expect(after.streams).toBe(1);
  });
});

describe("GET /view", () => {
  it("says the view is not built rather than 404ing like a bad URL", async () => {
    // Two very different problems; a bare 404 conflates them and sends someone
    // looking for a typo in a URL that was correct.
    const port = await serve(registryWithSession());
    const res = await fetch(`http://127.0.0.1:${port}/view`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("view not built");
  });

  it("is reachable WITHOUT a token — see the note in view.ts", async () => {
    const port = await serve(registryWithSession());
    const res = await fetch(`http://127.0.0.1:${port}/view`);
    expect(res.status).not.toBe(401);
  });
});

/* ── VIEW-06: gaps belong to a session, not to the daemon ────────────────── */

const hook = (port: number, body: unknown): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/hook/claude`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const start = (id: string, cwd = "/repo") => ({
  hook_event_name: "SessionStart",
  session_id: id,
  cwd,
});

const edit = (id: string, path: string, cwd = "/repo") => ({
  hook_event_name: "PreToolUse",
  session_id: id,
  cwd,
  tool_name: "Edit",
  tool_input: { file_path: path },
});

async function firstSnapshot(port: number, session: string): Promise<Snapshot> {
  const res = await stream(port, session);
  const got = read(res, 1);
  await got.done;
  got.cancel();
  return got.events[0]?.data as unknown as Snapshot;
}

describe("a session is told about its OWN gaps", () => {
  it("does not blame one session for another's out-of-repo paths", async () => {
    // The bug: the frame carried the daemon's global counter, so every session
    // showed every other session's number. A session that dropped nothing
    // displayed a warning about work it never lost — which is the same
    // dishonesty as hiding a real gap, pointed the other way.
    const registry = new Registry({ nowMs: () => 1_000 });
    const port = await serve(registry);

    await hook(port, start("clean"));
    await hook(port, start("messy"));
    await hook(port, edit("messy", "/somewhere/else/outside.ts"));
    await hook(port, edit("clean", "inside.ts"));

    const messy = await firstSnapshot(port, "messy");
    const clean = await firstSnapshot(port, "clean");

    expect(messy.counters.pathsOutsideRepo).toBe(1);
    expect(clean.counters.pathsOutsideRepo, "this session lost nothing").toBe(0);
  });

  it("counts a path outside the repo from the session's FIRST event", async () => {
    // `noteGaps` will not create a session, so counting before `apply` silently
    // discarded exactly the case where a misconfigured cwd produces the most
    // drops: the opening events.
    const registry = new Registry({ nowMs: () => 1_000 });
    const port = await serve(registry);

    await hook(port, edit("fresh", "/outside/the/repo.ts"));

    expect((await firstSnapshot(port, "fresh")).counters.pathsOutsideRepo).toBe(1);
  });

  it("does NOT count a deliberately unmapped hook as a gap", async () => {
    // PreCompact is not mapped on purpose. Counting it made the view announce
    // "this map is missing work that happened" every time a session compacted,
    // spending on a non-event the credibility a real gap needs.
    const registry = new Registry({ nowMs: () => 1_000 });
    const port = await serve(registry);

    await hook(port, start("s1"));
    for (let i = 0; i < 3; i++) {
      await hook(port, { hook_event_name: "PreCompact", session_id: "s1", cwd: "/repo" });
    }

    const snap = await firstSnapshot(port, "s1");
    expect(snap.counters.invalidEvents).toBe(0);
    expect(snap.counters.pathsOutsideRepo).toBe(0);

    const c = await counters(port);
    expect(c.unmapped, "still counted daemon-wide, for /healthz").toBe(3);
    expect(c.rejected, "but not as a fault").toBe(0);
  });

  it("keeps a path inside the repo, obviously", async () => {
    const registry = new Registry({ nowMs: () => 1_000 });
    const port = await serve(registry);
    await hook(port, start("s1"));
    await hook(port, edit("s1", "src/real.ts"));

    const snap = await firstSnapshot(port, "s1");
    expect(snap.files.map((f) => f.path)).toEqual(["src/real.ts"]);
    expect(snap.counters.pathsOutsideRepo).toBe(0);
  });
});

describe("shutting the daemon down", () => {
  it("does not hang while a view is watching", async () => {
    // `server.close()` waits for every connection to end, and an SSE stream is
    // a connection that by design never does — so before this, stopping a
    // daemon with a view open never returned at all.
    const port = await serve(registryWithSession());
    const res = await stream(port, "s1");
    const got = read(res, 1);
    await got.done;

    const closed = open.splice(0)[0] as () => Promise<void>;
    await expect(Promise.race([closed(), timeout(2000)])).resolves.toBeUndefined();
    got.cancel();
  });

  it("ends the stream rather than severing it", async () => {
    // The client must be able to tell "the daemon stopped" from "the socket
    // broke", which is the same distinction VIEW-02 draws on the other side.
    const port = await serve(registryWithSession());
    const res = await stream(port, "s1");
    const got = read(res, 1);
    await got.done;

    await (open.splice(0)[0] as () => Promise<void>)();
    await expect(Promise.race([got.done, timeout(2000)])).resolves.toBeUndefined();
  });
});

const timeout = (ms: number): Promise<never> =>
  new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms));

describe("a change of tool reaches the view", () => {
  it("sends a delta when the tool changes inside one state", () => {
    // An agent can run six tools without leaving `tool-running`, so a diff that
    // only watched `state` would show the first tool of a burst and freeze.
    const r = registryWithSession();
    const s = new StreamState("s1");
    r.apply(ev("pre_tool", { tool: "Read", paths: ["a.ts"] }), "/repo");
    s.next(look(r));

    r.apply(ev("post_tool", { tool: "Read", paths: ["a.ts"] }), "/repo");
    r.apply(ev("pre_tool", { tool: "Edit", paths: ["b.ts"] }), "/repo");
    const delta = s.next(look(r)) as Delta;

    expect(delta?.agents?.upsert?.[0]?.tool).toBe("Edit");
    expect(delta?.agents?.upsert?.[0]?.toolPath).toBe("b.ts");
  });

  it("carries a subagent's brief in the snapshot", () => {
    const r = registryWithSession();
    r.apply(
      ev("subagent_start", { agentId: "sub", agentType: "Explore", description: "Find the leak" }),
      "/repo",
    );
    const snap = new StreamState("s1").next(look(r)) as Snapshot;
    const sub = snap.agents.find((a) => a.id === "sub");

    expect(sub?.description).toBe("Find the leak");
    expect(snap.agents.find((a) => a.id === "s1")?.description).toBeNull();
  });
});

/* ── DMN-10: /state carries what the notifier was pushed, too ─────────────── */

const remoteSession = (over: Partial<import("../src/status/types.js").RemoteSession> = {}) => ({
  host: "megabrain-dev",
  sessionId: "r1",
  cwd: "/home/dev/repos/astir",
  name: null,
  status: "busy",
  source: "ssh" as const,
  lastSeen: 1,
  ...over,
});

async function serveWithRemotes(
  pushed: ReturnType<typeof remoteSession>[],
  polled: ReturnType<typeof remoteSession>[],
): Promise<number> {
  const daemon = new Daemon({
    token: TOKEN,
    registry: new Registry({ nowMs: () => 1_000 }),
    viewRoot: "/nonexistent-view-root",
    remoteSessions: () => polled,
    pushedSessions: () => pushed,
  });
  const port = await daemon.listen(0);
  open.push(() => daemon.close());
  return port;
}

const stateOf = async (port: number) =>
  (await (
    await fetch(`http://127.0.0.1:${port}/state`, { headers: { authorization: `Bearer ${TOKEN}` } })
  ).json()) as { remote?: Array<{ sessionId: string; host: string; attended?: boolean }> };

describe("/state merges both remote routes", () => {
  it("includes a session only the PUSH knows about", () => {
    // The bug this fixes: the web view reads /state, which carried only the SSH
    // poll. Sessions the poll cannot see — and the poll and the push return
    // different sets — were visible in the menu bar and missing from the view.
    return serveWithRemotes([remoteSession({ sessionId: "push-only", source: "push" })], []).then(
      async (port) => {
        const body = await stateOf(port);
        expect(body.remote?.map((r) => r.sessionId)).toContain("push-only");
      },
    );
  });

  it("includes a session only the SSH POLL knows about", async () => {
    const port = await serveWithRemotes([], [remoteSession({ sessionId: "poll-only" })]);
    expect((await stateOf(port)).remote?.map((r) => r.sessionId)).toContain("poll-only");
  });

  it("lists a session both routes report exactly once", async () => {
    const port = await serveWithRemotes(
      [remoteSession({ sessionId: "both", host: "claude-dev-geeklish", source: "push" })],
      [remoteSession({ sessionId: "both", host: "megabrain-dev" })],
    );
    const body = await stateOf(port);
    expect(body.remote).toHaveLength(1);
    expect(body.remote?.[0]?.host, "the configured alias wins on name").toBe("megabrain-dev");
  });

  it("carries `attended`, which ONLY the push route can know", async () => {
    // A controlling terminal is visible only on the machine running the session,
    // so `claude agents --json` cannot report it — it says "interactive" for
    // observer sessions too. Without the push, the view cannot tell a plugin's
    // session from a person's.
    const port = await serveWithRemotes(
      [remoteSession({ sessionId: "bot", source: "push", attended: false })],
      [],
    );
    expect((await stateOf(port)).remote?.[0]?.attended).toBe(false);
  });
});
