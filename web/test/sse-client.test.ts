// web/test/sse-client.test.ts
import { describe, it, expect, vi } from "vitest";
import { parseSseChunk, SseClient } from "../src/sse-client.js";

describe("SSE frame parsing", () => {
  it("parses complete data: frames and buffers partial lines", () => {
    const out: any[] = [];
    let buf = "";
    // first chunk: one full frame + a partial second
    buf = parseSseChunk(buf, 'data: {"type":"snapshot","sessionId":"s1","ts":1,"payload":{}}\n\ndata: {"type":"de', (f) => out.push(f));
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("snapshot");
    // second chunk completes the second frame
    buf = parseSseChunk(buf, 'lta","sessionId":"s1","ts":2,"payload":{}}\n\n', (f) => out.push(f));
    expect(out).toHaveLength(2);
    expect(out[1].type).toBe("delta");
    expect(buf).toBe("");
  });
  it("ignores non-data lines and blank keepalives", () => {
    const out: any[] = [];
    const rest = parseSseChunk("", ": keepalive\n\n", (f) => out.push(f));
    expect(out).toHaveLength(0);
    expect(rest).toBe("");
  });
});

describe("SseClient timeout + reconnect (REQ-047)", () => {
  it("signals 'unreachable' if no snapshot arrives within the timeout", async () => {
    // a 200 response whose body never enqueues a frame
    const fetchImpl = (async () => new Response(new ReadableStream<Uint8Array>({ start() { /* never enqueue */ } }), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const statuses: string[] = [];
    await new Promise<void>((resolve) => {
      const c = new SseClient({ url: "http://x/stream", token: "t", onFrame: () => {}, onStatus: (s) => { statuses.push(s); if (s === "unreachable") { c.stop(); resolve(); } }, snapshotTimeoutMs: 20, fetchImpl });
      c.start();
    });
    expect(statuses).toContain("unreachable");
  });

  it("reconnects after the stream ends and eventually delivers a frame", async () => {
    let connects = 0;
    const frame = 'data: {"type":"snapshot","sessionId":"s1","ts":1,"payload":{}}\n\n';
    const fetchImpl = (async () => {
      connects += 1;
      if (connects === 1) return new Response(new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), { status: 200 }); // ends immediately → reconnect
      return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(frame)); } }), { status: 200 }); // delivers a frame, stays open
    }) as unknown as typeof fetch;
    const statuses: string[] = [];
    await new Promise<void>((resolve) => {
      const c = new SseClient({ url: "http://x/stream", token: "t", onFrame: () => { c.stop(); resolve(); }, onStatus: (s) => statuses.push(s), snapshotTimeoutMs: 5000, fetchImpl });
      c.start();
    });
    expect(connects).toBeGreaterThanOrEqual(2);
    expect(statuses).toContain("reconnecting");
  });
});
