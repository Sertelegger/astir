// @vitest-environment happy-dom
/**
 * SC8 in the browser: the assembled app mounts, connects, and renders a frame.
 *
 * Every other view test exercises one pure function or one component. This one
 * exists because that is exactly the shape of testing that let a previous
 * version ship an entry point nothing called — each part correct, wired to
 * nothing. Here the real `App` drives the real `useSession`, the real SSE
 * parser and the real reducer, over a stubbed socket.
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSnapshot, diffSnapshots, type Snapshot } from "../src/status/frames.js";
import { RepoMap } from "../src/model/map.js";
import { App } from "../view/src/App.js";

const TOKEN = "t".repeat(48);

let now = 0;
const map = () => new RepoMap({ nowMs: () => now });

function snapshotOf(repo: RepoMap, seq: number): Snapshot {
  return buildSnapshot({
    sessionId: "demo",
    cwd: "/repo",
    name: "astir-aa",
    status: "busy",
    agents: [
      {
        id: "demo",
        state: "tool-running",
        agentType: null,
        activeMs: 10,
        turnMs: 10,
        blockedMs: 0,
        inStateMs: 4000,
        acknowledged: false,
      },
    ],
    map: repo,
    counters: { droppedPaths: 2, rejected: 0 },
    seq,
  });
}

/** A body that emits the given SSE blocks and then stays open. */
function sseBody(blocks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const b of blocks) controller.enqueue(encoder.encode(b));
      // Deliberately not closed: a closed body means "daemon went away", which
      // would put the view into reconnect and make this test about backoff.
    },
  });
}

const frame = (kind: string, payload: unknown, id: number) =>
  `id: ${id}\nevent: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`;

let frames: number;
beforeEach(() => {
  now = 0;
  frames = 0;
  // Run animation frames synchronously so the coalescer flushes within the test.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queueMicrotask(() => cb(0));
    return ++frames;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubDaemon(blocks: string[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/state")) {
      return new Response(
        JSON.stringify({
          sessions: [
            { sessionId: "demo", name: "astir-aa", cwd: "/repo", status: "busy", files: { touched: 3 } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("/stream")) {
      return new Response(sseBody(blocks), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

describe("the assembled view", () => {
  it("connects, applies a snapshot, and renders the files in it", async () => {
    const repo = map();
    repo.touch(["src/a.ts", "src/a.ts", "src/b.ts", "test/c.ts"]);
    stubDaemon([frame("snapshot", snapshotOf(repo, 1), 1)]);

    const view = render(<App token={TOKEN} />);

    await waitFor(() => {
      expect(view.container.querySelector('[title="src/a.ts"]')).not.toBeNull();
    });
    expect(view.container.textContent).toContain("Live");
    expect(view.container.querySelectorAll(".hottest .row")).toHaveLength(3);
  });

  it("sends the bearer token on the stream, not in the URL", async () => {
    // The whole reason the page takes its token from a fragment. A token in the
    // query string lands in every log the request passes through.
    const repo = map();
    repo.touch(["a.ts"]);
    const fetchMock = stubDaemon([frame("snapshot", snapshotOf(repo, 1), 1)]);

    render(<App token={TOKEN} />);
    // Specifically the STREAM call: `/state` is fetched first to find a session,
    // so waiting for "any fetch" would assert against the wrong request.
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith("/stream"))).toBe(true),
    );

    const streamCall = fetchMock.mock.calls.find((c) => String(c[0]).startsWith("/stream"));
    expect(streamCall).toBeDefined();
    expect(String(streamCall?.[0])).not.toContain(TOKEN);
    expect((streamCall?.[1] as RequestInit).headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it("folds a delta onto the snapshot instead of replacing it", async () => {
    // The property the whole transport rests on: a delta carries only what
    // changed, so a view that treated it as a snapshot would lose every file
    // that had not moved this second.
    const repo = map();
    repo.touch(["kept.ts"]);
    const first = snapshotOf(repo, 1);

    now += 1000;
    repo.touch(["fresh.ts"]);
    const second = snapshotOf(repo, 2);
    const delta = diffSnapshots(first, second);
    expect(delta?.files?.upsert.map((f) => f.path)).toEqual(["fresh.ts"]);

    stubDaemon([frame("snapshot", first, 1), frame("delta", delta, 2)]);
    const view = render(<App token={TOKEN} />);

    await waitFor(() => {
      expect(view.container.querySelector('[title="fresh.ts"]')).not.toBeNull();
    });
    expect(view.container.querySelector('[title="kept.ts"]'), "the untouched file survived").not.toBeNull();
  });

  it("says the session ended, distinctly from being unable to reach anything", async () => {
    const repo = map();
    repo.touch(["a.ts"]);
    stubDaemon([
      frame("snapshot", snapshotOf(repo, 1), 1),
      "event: end\ndata: {\"kind\":\"end\",\"sessionId\":\"demo\",\"reason\":\"gone\"}\n\n",
    ]);

    const view = render(<App token={TOKEN} />);
    await waitFor(() => expect(view.container.textContent).toContain("Session ended"));
    expect(view.container.textContent).not.toContain("unreachable");
  });

  it("carries the dropped-path count through to the honesty banner", async () => {
    // VIEW-06 end to end: the daemon counted it, the frame carried it, the view
    // says it. A break anywhere in that chain is invisible without this.
    const repo = map();
    repo.touch(["a.ts"]);
    stubDaemon([frame("snapshot", snapshotOf(repo, 1), 1)]);

    const view = render(<App token={TOKEN} />);
    await waitFor(() => expect(view.container.textContent).toContain("2 paths dropped"));
  });

  it("switches modes without losing the file list", async () => {
    const repo = map();
    repo.touch(["early.ts", "early.ts", "early.ts"]);
    now += 60 * 60_000; // an hour later: stone cold live, still the session's biggest
    repo.touch(["late.ts"]);
    stubDaemon([frame("snapshot", snapshotOf(repo, 1), 1)]);

    const view = render(<App token={TOKEN} />);
    await waitFor(() => expect(view.container.querySelector('[title="early.ts"]')).not.toBeNull());

    const liveOrder = [...view.container.querySelectorAll(".hottest .path")].map((n) => n.textContent);
    expect(liveOrder[0]).toBe("late.ts");

    const sessionButton = [...view.container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Session"),
    ) as HTMLButtonElement;
    await act(async () => {
      sessionButton.click();
    });

    const sessionOrder = [...view.container.querySelectorAll(".hottest .path")].map(
      (n) => n.textContent,
    );
    expect(sessionOrder[0], "SC11 — cold live, hottest for the session").toBe("early.ts");
    expect(new Set(sessionOrder)).toEqual(new Set(liveOrder));
  });
});
