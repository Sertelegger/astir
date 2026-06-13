export type CounterKey =
  | "eventsIngested" | "eventsDropped" | "eventsDeduped" | "droppedPaths"
  | "sseClients" | "reasoningIngested" | "summarizerCalls" | "summarizerFailures" | "breakerTrips";

export class Counters {
  private c: Record<CounterKey, number> = {
    eventsIngested: 0, eventsDropped: 0, eventsDeduped: 0, droppedPaths: 0,
    sseClients: 0, reasoningIngested: 0, summarizerCalls: 0, summarizerFailures: 0, breakerTrips: 0,
  };
  inc(k: CounterKey, by = 1): void { this.c[k] += by; }
  set(k: CounterKey, v: number): void { this.c[k] = v; }
  snapshot(): Record<CounterKey, number> { return { ...this.c }; }
}

/** Bounded in-memory ring of metadata-only log lines (REQ-091/093). Persisted to disk by main.ts on flush; never contains reasoning text or tool payloads. */
export class RingLog {
  private lines: string[] = [];
  private size = 0;
  constructor(private maxBytes = 5 * 1024 * 1024, private debug = process.env.CLIDE_DEBUG === "1") {}
  line(s: string): void {
    if (!this.debug && s.startsWith("debug:")) return;
    const entry = `${s}\n`;
    this.lines.push(entry); this.size += Buffer.byteLength(entry);
    while (this.size > this.maxBytes && this.lines.length > 0) this.size -= Buffer.byteLength(this.lines.shift()!);
  }
  bytes(): number { return this.size; }
  dump(): string { return this.lines.join(""); }
}
