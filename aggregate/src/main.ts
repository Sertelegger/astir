/* c8 ignore start */
import { Aggregator } from "./aggregator.js";
import { scanDiscovery, type AggDiscovery } from "./discovery.js";
import type { Frame } from "./protocol.js";

/**
 * Parse an appended SSE chunk. Copied from web/src/sse-client.ts (parseSseChunk).
 * SSE events are separated by a blank line; we only care about `data:` lines
 * carrying one JSON Frame. Returns the leftover buffer (an incomplete trailing
 * event) to prepend to the next chunk.
 */
function parseSseChunk(buffer: string, chunk: string, onFrame: (f: Frame) => void): string {
  let buf = buffer + chunk;
  let sep: number;
  while ((sep = buf.indexOf("\n\n")) !== -1) {
    const rawEvent = buf.slice(0, sep);
    buf = buf.slice(sep + 2);
    for (const line of rawEvent.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (json === "") continue;
      try { onFrame(JSON.parse(json) as Frame); } catch { /* drop malformed */ }
    }
  }
  return buf;
}

/** Subscribe to a relay's SSE stream using fetch + bearer token.
 *  Calls onStatus("unreachable") if no snapshot arrives within 5s.
 *  Returns an unsubscribe function.
 */
function subscribeRelay(
  disc: AggDiscovery,
  onFrame: (f: Frame) => void,
  onStatus: (s: string) => void,
): () => void {
  let closed = false;
  const abort = new AbortController();

  const snapTimeout = setTimeout(() => {
    if (!closed) onStatus("unreachable");
  }, 5000);

  let gotSnapshot = false;

  async function connect(): Promise<void> {
    try {
      const res = await fetch(`http://127.0.0.1:${disc.port}/stream`, {
        headers: { Authorization: `Bearer ${disc.token}`, Accept: "text/event-stream" },
        signal: abort.signal,
      });
      if (!res.ok || !res.body) { onStatus("unreachable"); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf = parseSseChunk(buf, decoder.decode(value, { stream: true }), (frame) => {
          if (!gotSnapshot) { clearTimeout(snapTimeout); gotSnapshot = true; }
          onFrame(frame);
        });
      }
    } catch {
      clearTimeout(snapTimeout);
      if (!closed) onStatus("unreachable");
    }
  }

  void connect();
  return () => { closed = true; abort.abort(); clearTimeout(snapTimeout); };
}

function renderSessions(agg: Aggregator): void {
  const sessions = agg.sessions();
  process.stdout.write("\x1b[2J\x1b[H"); // clear screen
  if (sessions.length === 0) {
    process.stdout.write("clide-aggregate: no live sessions found\n");
    return;
  }
  process.stdout.write(`clide-aggregate — ${sessions.length} session(s)\n\n`);
  for (const s of sessions) {
    const agents = s.snapshot?.agents?.length ?? 0;
    const leafCount = s.snapshot
      ? countLeaves(s.snapshot.tree)
      : 0;
    process.stdout.write(
      `  ${s.provider.padEnd(8)} · ${s.sessionId.slice(0, 12).padEnd(12)} · ${s.status.padEnd(12)} · ${agents} agent(s) / ${leafCount} file(s)\n`,
    );
  }
}

function countLeaves(node: { type: string; children?: unknown[] }): number {
  if (node.type === "file") return 1;
  return (node.children ?? []).reduce<number>(
    (acc, c) => acc + countLeaves(c as { type: string; children?: unknown[] }),
    0,
  );
}

export async function runAggregate(): Promise<void> {
  const agg = new Aggregator({
    scan: scanDiscovery,
    subscribe: subscribeRelay,
  });

  agg.refresh();
  renderSessions(agg);

  // Periodically rescan for churn (sessions appearing/disappearing).
  const refreshInterval = setInterval(() => {
    agg.refresh();
    renderSessions(agg);
  }, 2000);

  process.on("SIGINT", () => {
    clearInterval(refreshInterval);
    agg.stopAll();
    process.exit(0);
  });
}

// Entry point
void runAggregate();
/* c8 ignore stop */
