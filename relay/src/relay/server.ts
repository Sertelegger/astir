import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { constantTimeEqual } from "../security/token.js";
import type { SessionState } from "../model/session-state.js";
import type { Counters } from "../log/logger.js";
import { makeFrame } from "../contract/frames.js";

export interface RelayServerOpts { state: SessionState; token: string; counters: Counters; flushMs?: number; }

export class RelayServer {
  private server: Server;
  private clients = new Set<ServerResponse>();
  private pending = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushMs: number;
  private pendingPulses = new Set<string>();

  constructor(private opts: RelayServerOpts) {
    this.flushMs = opts.flushMs ?? 100; // ≤10 Hz coalescing (REQ-015)
    this.server = createServer((req, res) => void this.route(req, res));
  }

  listen(port = 0): Promise<number> {
    return new Promise((resolve) => this.server.listen(port, "127.0.0.1", () => resolve((this.server.address() as { port: number }).port)));
  }
  close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    for (const c of this.clients) c.end();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private authorized(req: IncomingMessage): boolean {
    const h = req.headers.authorization ?? "";
    const m = /^Bearer (.+)$/.exec(h);
    return m !== null && constantTimeEqual(m[1]!, this.opts.token);
  }

  private async body(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    if (url === "/healthz") { // open, no auth (REQ-012)
      return this.json(res, 200, { sessionId: this.opts.state.sessionId, state: this.opts.state.state, counters: this.opts.counters.snapshot() });
    }
    if (!this.authorized(req)) return this.json(res, 401, { error: "unauthorized" });

    if (url === "/events" && req.method === "POST") {
      const touched = this.opts.state.apply(await this.body(req));
      for (const l of touched) this.pendingPulses.add(l.path);
      this.opts.counters.inc("eventsIngested");
      this.scheduleFlush();
      return this.json(res, 200, { ok: true, touched: touched.length });
    }
    if (url === "/reasoning" && req.method === "POST") {
      const b = (await this.body(req)) as { agentId?: string; ts?: number; text?: string } | null;
      if (b && typeof b.agentId === "string" && typeof b.ts === "number" && typeof b.text === "string") {
        this.opts.state.applyReasoning(b.agentId, b.ts, b.text);
        this.opts.counters.inc("reasoningIngested");
        this.scheduleFlush();
        return this.json(res, 200, { ok: true });
      }
      return this.json(res, 400, { error: "bad reasoning" });
    }
    if (url === "/state") return this.json(res, 200, this.opts.state.snapshot());
    if (url === "/stream") return this.openSse(res);
    return this.json(res, 404, { error: "not found" });
  }

  private openSse(res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    this.clients.add(res);
    this.opts.counters.set("sseClients", this.clients.size);
    const snap = makeFrame("snapshot", this.opts.state.sessionId, Date.now() / 1000, this.opts.state.snapshot());
    res.write(`data: ${JSON.stringify(snap)}\n\n`);
    res.on("close", () => { this.clients.delete(res); this.opts.counters.set("sseClients", this.clients.size); });
  }

  /** Coalesce to ≤1 delta frame per flushMs (REQ-015). */
  private scheduleFlush(): void {
    this.pending = true;
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      if (!this.pending) return;
      this.pending = false;
      const frame = makeFrame("delta", this.opts.state.sessionId, Date.now() / 1000, this.opts.state.snapshot(this.pendingPulses));
      this.pendingPulses.clear();
      const data = `data: ${JSON.stringify(frame)}\n\n`;
      for (const c of this.clients) c.write(data);
    }, this.flushMs);
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }
}
