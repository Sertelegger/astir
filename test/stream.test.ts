import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AstirEvent, CONTRACT_VERSION, type Kind } from "../src/contract/event.js";
import { Daemon } from "../src/daemon/server.js";
import { observe, StreamState, sseFrame } from "../src/daemon/stream.js";
import { resolveAsset } from "../src/daemon/view.js";
import { Registry } from "../src/model/registry.js";
import type { Delta, Snapshot } from "../src/status/frames.js";

const TOKEN = "t".repeat(48);
const COUNTERS = { droppedPaths: 0, rejected: 0 };

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
  return s === undefined ? null : observe(s, 1_000, COUNTERS);
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

async function serve(registry: Registry, streamTickMs = 10): Promise<number> {
  const daemon = new Daemon({
    token: TOKEN,
    registry,
    streamTickMs,
    viewRoot: "/nonexistent-view-root",
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
