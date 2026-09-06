import { afterEach, describe, expect, it } from "vitest";
import { Daemon } from "../src/daemon/server.js";
import { Registry } from "../src/model/registry.js";
import type { FocusResult } from "../src/status/focus.js";

const TOKEN = "t".repeat(48);

interface Harness {
  port: number;
  focused: Array<{ sessionId: string; pid: number | null; cwd: string }>;
  close: () => Promise<void>;
}

const open: Harness[] = [];

/**
 * A daemon with one discovered-but-silent session, and focus stubbed so nothing
 * touches the real window manager.
 */
async function harness(
  result: FocusResult = { ok: true, detail: "focused Thing.app" },
  status: string | null = null,
): Promise<Harness> {
  const registry = new Registry({ nowMs: () => 1_000 });
  registry.reconcile([
    {
      sessionId: "quiet-1",
      cwd: "/x/seenthat",
      name: "seenthat-be",
      pid: 4242,
      status,
      startedAt: null,
    },
  ]);

  const focused: Harness["focused"] = [];
  const daemon = new Daemon({
    token: TOKEN,
    registry,
    focus: (s) => {
      focused.push({ sessionId: s.sessionId, pid: s.pid, cwd: s.cwd });
      return result;
    },
  });
  const port = await daemon.listen(0);
  const h: Harness = { port, focused, close: () => daemon.close() };
  open.push(h);
  return h;
}

const post = async (port: number, path: string, token = TOKEN): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()));
});

describe("PSH-11 — focus is performed by the daemon", () => {
  it("raises the window in the daemon process, not the caller's", async () => {
    // The whole point: macOS charges the TCC grant to the process that spawned
    // the chain, so doing this in the CLI demanded a separate permission from
    // VS Code, SwiftBar and every terminal in turn.
    const h = await harness();
    const res = await post(h.port, "/focus?session=quiet-1");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, detail: "focused Thing.app" });
    expect(h.focused).toEqual([{ sessionId: "quiet-1", pid: 4242, cwd: "/x/seenthat" }]);
  });

  it("focuses a session it has never heard from, carrying its discovered pid", async () => {
    // A silent session is the one you most want to reach: you cannot see what it
    // is doing from here. It only appears via discovery, never via a hook.
    const h = await harness();
    await post(h.port, "/focus?session=quiet-1");
    expect(h.focused[0]?.pid).toBe(4242);
  });

  it("reports a failed focus as 200 with the reason, not as an HTTP error", async () => {
    // The client drops a non-2xx body, and the reason IS the useful part.
    const h = await harness({ ok: false, detail: "no pid for this session" });
    const res = await post(h.port, "/focus?session=quiet-1");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, detail: "no pid for this session" });
  });

  it("404s an unknown session without attempting to focus anything", async () => {
    const h = await harness();
    const res = await post(h.port, "/focus?session=nope");
    expect(res.status).toBe(404);
    expect(h.focused).toEqual([]);
  });

  it("requires the session parameter", async () => {
    const h = await harness();
    expect((await post(h.port, "/focus")).status).toBe(400);
  });

  it("refuses an unauthenticated caller, so a web page cannot move your windows", async () => {
    const h = await harness();
    const res = await post(h.port, "/focus?session=quiet-1", "wrong-token");
    expect(res.status).toBe(401);
    expect(h.focused).toEqual([]);
  });
});

describe("/state carries what a silent session needs to be diagnosed", () => {
  // Nothing asserted this projection, which is how `status` came to be dropped
  // from it while every other field survived. Deleting `silent` or any of its
  // fields left the whole suite green, and the daemon is the only place these
  // reach a surface from.
  it("lists the silent session with the fields its surfaces read", async () => {
    const h = await harness(undefined, "busy");
    const res = await fetch(`http://127.0.0.1:${h.port}/state`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const body = (await res.json()) as {
      silent?: Array<Record<string, unknown>>;
      daemonStartedAt?: number;
    };

    expect(body.silent?.[0]?.sessionId).toBe("quiet-1");
    // The one that was missing. #35 makes the pid collapse prefer the busier of
    // two disagreeing profile views, and the status it picks died right here.
    expect(body.silent?.[0]?.status).toBe("busy");
    // `pid` so it can still be focused; `startedAt` so a surface can tell "its
    // hooks are unwired" from "it started before astir was listening".
    expect(body.silent?.[0]?.pid).toBe(4242);
    expect(body.silent?.[0]).toHaveProperty("startedAt");
    // The other half of that comparison. Without it every silent session gets
    // the restart-it advice, including the ones for which it is wrong.
    expect(typeof body.daemonStartedAt).toBe("number");
  });

  it("passes a null status through as null rather than inventing one", async () => {
    const h = await harness(undefined, null);
    const res = await fetch(`http://127.0.0.1:${h.port}/state`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const body = (await res.json()) as { silent?: Array<Record<string, unknown>> };
    expect(body.silent?.[0]?.status).toBeNull();
  });
});
