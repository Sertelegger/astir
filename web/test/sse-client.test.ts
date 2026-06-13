// web/test/sse-client.test.ts
import { describe, it, expect, vi } from "vitest";
import { parseSseChunk } from "../src/sse-client.js";

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
