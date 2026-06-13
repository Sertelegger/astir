import { describe, it, expect } from "vitest";
import { SseClient } from "../src/sse-client.js";
import { Store } from "../src/store.js";
import type { Frame } from "../src/protocol.js";

/** Build a fake fetch whose Response body streams the given SSE text. */
function fakeFetch(sseText: string): typeof fetch {
  return (async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode(sseText)); c.close(); },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

describe("SSE → Store integration", () => {
  it("streams a snapshot frame end-to-end into the store", async () => {
    const snapFrame: Frame = { type: "snapshot", sessionId: "s1", ts: 1, payload: {
      provider: "claude", sessionId: "s1", state: "live",
      tree: { path: "", type: "dir", heat: 3, children: [
        { path: "src/a.ts", type: "file", loc: 10, binary: false, heat: 3, reads: 0, edits: 1, agents: [] },
      ] },
      agents: [],
    } };
    const sse = `data: ${JSON.stringify(snapFrame)}\n\n`;
    const store = new Store("s1");
    let connected = false;
    await new Promise<void>((resolve) => {
      const client = new SseClient({
        url: "http://127.0.0.1:1/stream", token: "tok",
        onFrame: (f) => { store.apply(f); resolve(); },
        onStatus: (s) => { if (s === "connected") connected = true; },
        fetchImpl: fakeFetch(sse),
      });
      client.start();
    });
    expect(connected).toBe(true);
    expect(store.state.sessionId).toBe("s1");
    expect(store.state.maxLeafHeat).toBe(3);
  });
});
