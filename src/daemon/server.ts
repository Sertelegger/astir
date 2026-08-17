/** DMN-01..04 — the one daemon. Fixed port, token-gated data routes, error-bounded. */

import { timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultNewId, normalizeClaudeHook, type SidecarMeta } from "../adapters/claude/normalize.js";
import { validateEvent } from "../contract/event.js";
import type { Registry } from "../model/registry.js";

/** DMN-03 — a hook payload is small; anything larger is hostile or a bug. */
const MAX_BODY_BYTES = 1024 * 1024;

export interface DaemonOpts {
  token: string;
  registry: Registry;
  /** PSH-01 — invoked when an agent becomes human-blocking. Injectable per §9. */
  onBlocked?: (info: { sessionId: string; agentId: string; kind: string }) => void;
  /** Injectable so tests never touch the real home directory. */
  readSidecar?: (sessionId: string, agentId: string) => SidecarMeta | null;
  nowSeconds?: () => number;
}

/** CAP-05 route 1 — read `<session>/subagents/agent-<id>.meta.json`. */
export function defaultReadSidecar(sessionId: string, agentId: string): SidecarMeta | null {
  const base = join(homedir(), ".claude", "projects");
  if (!existsSync(base)) return null;
  // The project directory is the cwd with separators replaced; rather than
  // reproduce that encoding, look for the session directory directly.
  try {
    for (const proj of readdirSafe(base)) {
      const file = join(base, proj, sessionId, "subagents", `agent-${agentId}.meta.json`);
      if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as SidecarMeta;
    }
  } catch {
    return null;
  }
  return null;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export class Daemon {
  private server: Server;
  private readonly opts: DaemonOpts;
  private readonly readSidecar: (s: string, a: string) => SidecarMeta | null;
  private readonly nowSeconds: () => number;
  /** OBS-01 — every counter here is incremented by a real code path. */
  private counters = {
    ingested: 0,
    rejected: 0,
    duplicates: 0,
    blocked: 0,
    droppedPaths: 0,
    /** CAP-08 — distinct from "no events": a hook fired but could not authenticate. */
    unauthorizedIngest: 0,
    /** Reads of /state. Non-zero means a surface (status, menu bar) is watching. */
    statePolls: 0,
    /** PSH-10 — agents the human explicitly dismissed. */
    dismissed: 0,
  };
  private warnedAboutToken = false;

  constructor(opts: DaemonOpts) {
    this.opts = opts;
    this.readSidecar = opts.readSidecar ?? defaultReadSidecar;
    this.nowSeconds = opts.nowSeconds ?? (() => Date.now() / 1000);
    this.server = createServer((req, res) => {
      // DMN-04 — no inbound request may terminate the process.
      this.route(req, res).catch((err: unknown) => {
        this.counters.rejected++;
        this.json(res, 500, { error: "internal", detail: String(err) });
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

  private authorized(req: IncomingMessage): boolean {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    return m?.[1] !== undefined && constantTimeEqual(m[1], this.opts.token);
  }

  private async body(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false }> {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const c of req) {
        const buf = c as Buffer;
        size += buf.length;
        if (size > MAX_BODY_BYTES) return { ok: false };
        chunks.push(buf);
      }
      return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    } catch {
      // Covers both a client abort mid-body and malformed JSON.
      return { ok: false };
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    // SEC-03 — reject a Host we did not bind, to blunt DNS rebinding.
    const host = (req.headers.host ?? "").split(":")[0];
    if (host !== "127.0.0.1" && host !== "localhost") {
      return this.json(res, 421, { error: "bad host" });
    }

    if (path === "/healthz") {
      return this.json(res, 200, { ok: true, counters: this.counters });
    }

    if (!this.authorized(req)) {
      if (path.startsWith("/hook/")) {
        // CAP-08 — an unset $CLIDE_TOKEN interpolates to an empty string rather
        // than failing, so this is far more likely a misconfigured hook than an
        // attack. Say so once, loudly: silence here is the failure mode that let
        // the previous version look healthy while receiving nothing.
        this.counters.unauthorizedIngest++;
        if (!this.warnedAboutToken) {
          this.warnedAboutToken = true;
          process.stderr.write(
            "clide: a hook POSTed without a valid token — events are being rejected.\n" +
              "       Is $CLIDE_TOKEN exported in the environment Claude Code runs in?\n" +
              "       Run `clide install` for the export line.\n",
          );
        }
      }
      return this.json(res, 401, { error: "unauthorized" });
    }

    if (path === "/state" && req.method === "GET") {
      this.counters.statePolls++;
      return this.json(res, 200, this.snapshot());
    }

    if (path === "/hook/claude" && req.method === "POST") {
      const body = await this.body(req);
      if (!body.ok) {
        this.counters.rejected++;
        return this.json(res, 400, { error: "bad body" });
      }
      return this.ingestClaude(body.value, res);
    }

    // PSH-10 — "I have seen it." Clears the badge without claiming the agent is
    // unblocked; a later state change makes it notifiable again.
    if (path === "/dismiss" && req.method === "POST") {
      const sessionId = url.searchParams.get("session") ?? undefined;
      const n = this.opts.registry.acknowledge(sessionId);
      this.counters.dismissed += n;
      // No callback needed: the notify loop resolves any key that is no longer in
      // `blockedAgents()`, so acknowledging clears the reminder schedule by itself.
      return this.json(res, 200, { ok: true, acknowledged: n });
    }

    // The harder escape hatch: drop the record entirely, for a session that
    // should never have been there.
    if (path === "/forget" && req.method === "POST") {
      const sessionId = url.searchParams.get("session");
      if (sessionId === null) return this.json(res, 400, { error: "session required" });
      const existed = this.opts.registry.forget(sessionId);
      return this.json(res, existed ? 200 : 404, { ok: existed });
    }

    return this.json(res, 404, { error: "not found" });
  }

  private ingestClaude(payload: unknown, res: ServerResponse): void {
    const { event, droppedPaths } = normalizeClaudeHook(payload, {
      now: this.nowSeconds,
      newId: defaultNewId,
      realpath: (p) => {
        try {
          return realpathSync(p);
        } catch {
          return p;
        }
      },
      readSidecar: this.readSidecar,
    });

    // A dropped path is a hole in the picture. Count it so the view can say so.
    this.counters.droppedPaths += droppedPaths;

    if (event === null) {
      // A deliberately unmapped hook is not an error, but it must be visible.
      this.counters.rejected++;
      this.json(res, 422, { error: "unmapped or invalid hook payload" });
      return;
    }

    const valid = validateEvent(event);
    if (!valid.ok) {
      this.counters.rejected++;
      this.json(res, 400, { error: valid.error });
      return;
    }

    const cwd =
      typeof (payload as Record<string, unknown>).cwd === "string"
        ? ((payload as Record<string, unknown>).cwd as string)
        : "";

    const result = this.opts.registry.apply(valid.event, cwd);
    if (result.applied) this.counters.ingested++;
    else if (result.reason === "duplicate") this.counters.duplicates++;

    if (result.becameBlocked) {
      this.counters.blocked++;
      try {
        this.opts.onBlocked?.(result.becameBlocked);
      } catch {
        // A failing notifier must never break ingest.
      }
    }

    this.json(res, 200, { ok: true, applied: result.applied });
  }

  private snapshot(): unknown {
    // One `now` for the whole snapshot, so every duration in a single response is
    // measured against the same instant.
    const now = Date.now();
    return {
      v: { major: 2, minor: 1 },
      blockedCount: this.opts.registry.blockedCount(),
      // DMN-07 — sessions the provider says are running that have sent us
      // nothing, plus whether we have ever received anything at all. Together
      // these turn a silent menu bar from "all quiet" into a diagnosis.
      silent: this.opts.registry.silent().map((d) => ({
        sessionId: d.sessionId,
        name: d.name,
        cwd: d.cwd,
      })),
      everIngested: this.counters.ingested > 0,
      unauthorizedIngest: this.counters.unauthorizedIngest,
      sessions: this.opts.registry.list().map((s) => ({
        sessionId: s.sessionId,
        provider: s.provider,
        cwd: s.cwd,
        name: s.name,
        status: s.status,
        pid: s.pid,
        agents: [...s.agents.values()].map((a) => ({
          id: a.id,
          agentType: a.agentType,
          parentId: a.parentId,
          parentSource: a.parentSource,
          state: a.state,
          activeMs: a.activeMs,
          blockedMs: a.blockedMs,
          // Computed here rather than in the renderer: the daemon owns the clock,
          // and a surface reading a cached response should not silently age it.
          inStateMs: Math.max(0, now - a.stateSince),
          acknowledged: a.acknowledgedAt !== null,
        })),
      })),
    };
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    if (res.writableEnded) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }
}
