import type { Frame } from "./protocol.js";

/**
 * Parse an appended SSE chunk. SSE events are separated by a blank line; we only
 * care about `data:` lines carrying one JSON Frame. Returns the leftover buffer
 * (an incomplete trailing event) to prepend to the next chunk.
 */
export function parseSseChunk(buffer: string, chunk: string, onFrame: (f: Frame) => void): string {
  let buf = buffer + chunk;
  let sep: number;
  while ((sep = buf.indexOf("\n\n")) !== -1) {
    const rawEvent = buf.slice(0, sep);
    buf = buf.slice(sep + 2);
    for (const line of rawEvent.split("\n")) {
      if (!line.startsWith("data:")) continue; // skip comments (": ...") and other fields
      const json = line.slice(5).trim();
      if (json === "") continue;
      try { onFrame(JSON.parse(json) as Frame); } catch { /* drop malformed */ }
    }
  }
  return buf;
}

export interface SseClientOpts {
  url: string;            // e.g. http://127.0.0.1:PORT/stream
  token: string;
  onFrame: (f: Frame) => void;
  onStatus: (s: "connected" | "reconnecting" | "unreachable") => void;
  snapshotTimeoutMs?: number; // REQ-047 (default 5000)
  fetchImpl?: typeof fetch;   // injectable for tests
}

/** Reads the relay SSE stream via fetch (so it can send the bearer header — EventSource cannot). */
export class SseClient {
  private abort: AbortController | null = null;
  private closed = false;
  private backoffMs = 500;
  private readonly maxBackoff = 10_000;

  constructor(private opts: SseClientOpts) {}

  start(): void { this.closed = false; void this.connect(); }
  stop(): void { this.closed = true; this.abort?.abort(); }

  private async connect(): Promise<void> {
    if (this.closed) return;
    this.abort = new AbortController();
    const f = this.opts.fetchImpl ?? fetch;
    const snapTimeout = setTimeout(() => this.opts.onStatus("unreachable"), this.opts.snapshotTimeoutMs ?? 5000);
    try {
      const res = await f(this.opts.url, {
        headers: { Authorization: `Bearer ${this.opts.token}`, Accept: "text/event-stream" },
        signal: this.abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
      this.opts.onStatus("connected");
      this.backoffMs = 500;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let firstFrame = true;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf = parseSseChunk(buf, decoder.decode(value, { stream: true }), (frame) => {
          if (firstFrame) { clearTimeout(snapTimeout); firstFrame = false; }
          this.opts.onFrame(frame);
        });
      }
      throw new Error("stream ended");
    } catch (e) {
      clearTimeout(snapTimeout);
      if (this.closed) return;
      this.opts.onStatus("reconnecting");
      const wait = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoff);
      setTimeout(() => void this.connect(), wait);
    }
  }
}
