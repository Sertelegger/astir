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

/* c8 ignore start */
export interface SseReaderOpts {
  url: string;
  token: string;
  onFrame: (f: Frame) => void;
}

/** Fetch-stream SSE reader with bearer auth. Long-lived glue for main.ts — human-verified. */
export class SseReader {
  private abort: AbortController | null = null;
  private closed = false;

  constructor(private opts: SseReaderOpts) {}

  start(): void { this.closed = false; void this.connect(); }
  stop(): void { this.closed = true; this.abort?.abort(); }

  private async connect(): Promise<void> {
    if (this.closed) return;
    this.abort = new AbortController();
    try {
      const res = await fetch(this.opts.url, {
        headers: { Authorization: `Bearer ${this.opts.token}`, Accept: "text/event-stream" },
        signal: this.abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf = parseSseChunk(buf, decoder.decode(value, { stream: true }), this.opts.onFrame);
      }
    } catch {
      if (this.closed) return;
      setTimeout(() => void this.connect(), 1000);
    }
  }
}
/* c8 ignore stop */
