/**
 * PSH-06 — the notifier, as a separately addressable role.
 *
 * Runs where the human is. A daemon on another host — behind SSH, inside WSL,
 * inside a container — POSTs an envelope here and it becomes a desktop
 * notification. Because it binds loopback, `ssh -R 47001:127.0.0.1:47001` is
 * sufficient to reach it with no broker and no third-party service.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { validateEnvelope } from "./envelope.js";
import type { Notifier } from "./notify.js";

/** A doorbell is small; anything larger is a mistake or an attack. */
const MAX_BODY_BYTES = 64 * 1024;
/** Dedupe window for repeated ids, so a retry does not double-notify. */
const SEEN_MAX = 512;

export interface NotifierServerOpts {
  token: string;
  notify: Notifier;
  onEvent?: (line: string) => void;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export class NotifierServer {
  private server: Server;
  private seen = new Set<string>();
  private counters = { received: 0, delivered: 0, duplicates: 0, rejected: 0, unauthorized: 0 };

  constructor(private opts: NotifierServerOpts) {
    this.server = createServer((req, res) => {
      this.route(req, res).catch(() => {
        this.counters.rejected++;
        this.json(res, 500, { error: "internal" });
      });
    });
  }

  listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        const addr = this.server.address();
        resolve(typeof addr === "object" && addr !== null ? addr.port : port);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  snapshot(): Record<string, number> {
    return { ...this.counters };
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;

    if (path === "/healthz") {
      return this.json(res, 200, { ok: true, role: "notifier", counters: this.counters });
    }

    if (path !== "/notify" || req.method !== "POST") {
      return this.json(res, 404, { error: "not found" });
    }

    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (auth?.[1] === undefined || !constantTimeEqual(auth[1], this.opts.token)) {
      this.counters.unauthorized++;
      return this.json(res, 401, { error: "unauthorized" });
    }

    const body = await this.readBody(req);
    if (body === null) {
      this.counters.rejected++;
      return this.json(res, 400, { error: "bad body" });
    }

    const parsed = validateEnvelope(body);
    if (!parsed.ok) {
      this.counters.rejected++;
      return this.json(res, 400, { error: parsed.error });
    }

    this.counters.received++;
    const { envelope } = parsed;

    // A tunnel may retry, and a sender may have several transports configured.
    if (this.seen.has(envelope.id)) {
      this.counters.duplicates++;
      return this.json(res, 200, { ok: true, duplicate: true });
    }
    this.seen.add(envelope.id);
    while (this.seen.size > SEEN_MAX) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }

    try {
      this.opts.notify({ title: envelope.title, body: envelope.body });
      this.counters.delivered++;
      this.opts.onEvent?.(`${envelope.kind} ← ${envelope.body}`);
    } catch {
      // A failing notifier must never take down the receiver.
      this.counters.rejected++;
    }

    return this.json(res, 200, { ok: true });
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const c of req) {
        const buf = c as Buffer;
        size += buf.length;
        if (size > MAX_BODY_BYTES) return null;
        chunks.push(buf);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return null;
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    if (res.writableEnded) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }
}
