/** DMN-01..04 — the one daemon. Fixed port, token-gated data routes, error-bounded. */

import { timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultNewId, normalizeClaudeHook, type SidecarMeta } from "../adapters/claude/normalize.js";
import { validateEvent } from "../contract/event.js";
import type { Registry } from "../model/registry.js";
import { mergeRemoteSessions } from "../notify/roster.js";
import { type FocusResult, focusSession } from "../status/focus.js";
import type { RemoteSession } from "../status/types.js";
import { observer, StreamState, sseFrame } from "./stream.js";
import { serveAsset, viewRootFor } from "./view.js";

/**
 * How many files `/state` carries per session. Enough for a "hottest files"
 * list — which is also VIEW-07's accessibility fallback for the map — without
 * turning a 3-second poll into a payload nobody reads.
 */
const HOTTEST_ON_STATE = 10;

/** DMN-03 — a hook payload is small; anything larger is hostile or a bug. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * How often an open /stream re-observes its session.
 *
 * Only frames that actually differ are sent, so this bounds LATENCY rather than
 * bandwidth: a quiet session costs one diff per second and no bytes. Heat is
 * reconstructed client-side from an age, so the map animates far smoother than
 * this — the tick rate is not the framerate.
 */
const STREAM_TICK_MS = 1_000;

/** Proof of life for a stream that has had nothing to say. */
const STREAM_HEARTBEAT_MS = 15_000;

/**
 * Concurrent /stream connections allowed.
 *
 * Each holds a socket and a timer for as long as a tab is open, and a reloading
 * browser can leave the old one briefly alive, so the ceiling has to tolerate
 * more than one per human. It exists so a stuck client cannot accumulate
 * connections without bound — refusing loudly beats degrading quietly.
 */
const MAX_STREAMS = 16;

export interface DaemonOpts {
  token: string;
  registry: Registry;
  /** PSH-01 — invoked when an agent becomes human-blocking. Injectable per §9. */
  onBlocked?: (info: { sessionId: string; agentId: string; kind: string }) => void;
  /** Injectable so tests never touch the real home directory. */
  readSidecar?: (sessionId: string, agentId: string) => SidecarMeta | null;
  /**
   * PSH-11 — how to raise a session's window. Injectable so tests never drive
   * the real window manager.
   */
  focus?: (session: {
    sessionId: string;
    pid: number | null;
    cwd: string;
    name: string | null;
  }) => FocusResult;
  /**
   * DMN-09 — sessions on paired hosts, polled over SSH. A getter rather than a
   * value because polling happens on its own timer; the daemon only ever reads
   * the latest cache, so a slow host can never delay a /state response.
   */
  remoteSessions?: () => RemoteSession[];
  /**
   * DMN-10 — sessions a paired machine PUSHED to the local notifier.
   *
   * A separate source from `remoteSessions`, and not redundant with it: the two
   * routes return different sets, and only the push carries `attended`, because
   * whether a session has a controlling terminal can only be seen on the machine
   * running it. Without this the web view could neither see push-only sessions
   * nor tell a plugin's session from a person's — while the menu bar, which
   * reads the notifier itself, could do both.
   */
  pushedSessions?: () => RemoteSession[];
  nowSeconds?: () => number;
  /** Where the built view lives. Injectable so tests need no build output. */
  viewRoot?: string;
  /** Injectable so the stream's tick rate is not a test's wall-clock cost. */
  streamTickMs?: number;
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
  private readonly focus: NonNullable<DaemonOpts["focus"]>;
  private readonly nowSeconds: () => number;
  private readonly viewRoot: string;
  private readonly streamTickMs: number;
  /** OBS-01 — every counter here is incremented by a real code path. */
  private counters = {
    ingested: 0,
    rejected: 0,
    duplicates: 0,
    blocked: 0,
    /**
     * Daemon-wide totals for /healthz. The PER-SESSION versions on each
     * `SessionRecord` are what surfaces render; these answer "is anything
     * strange happening overall", which is a different question.
     */
    pathsOutsideRepo: 0,
    /** Hook kinds astir deliberately does not map. Not a fault, not a gap. */
    unmapped: 0,
    /** CAP-08 — distinct from "no events": a hook fired but could not authenticate. */
    unauthorizedIngest: 0,
    /** Reads of /state. Non-zero means a surface (status, menu bar) is watching. */
    statePolls: 0,
    /** PSH-10 — agents the human explicitly dismissed. */
    dismissed: 0,
    /** VIEW-02 — /stream connections opened, and how many are open right now. */
    streams: 0,
    streamsOpen: 0,
    /** Frames actually written. Flat while a session is idle, which is correct. */
    framesSent: 0,
    /** Connections refused at MAX_STREAMS. Non-zero means something is leaking. */
    streamsRefused: 0,
  };
  /** Teardown for each live /stream, so shutdown is not blocked by one. */
  private readonly openStreams = new Set<() => void>();
  private warnedAboutToken = false;
  /**
   * When a hook was last rejected for a bad token.
   *
   * `unauthorizedIngest` is a lifetime total, so using it to decide what to
   * *display* means a single rejection hours ago keeps the menu bar asserting
   * "the token is rejected" long after `astir install` fixed it — telling
   * someone to repair something that is already correct, while the real reason
   * their session is silent goes unnamed. A timestamp is the honest signal.
   */
  private lastUnauthorizedAt: number | null = null;
  private readonly startedAt = Date.now();

  constructor(opts: DaemonOpts) {
    this.opts = opts;
    this.readSidecar = opts.readSidecar ?? defaultReadSidecar;
    this.focus = opts.focus ?? focusSession;
    this.nowSeconds = opts.nowSeconds ?? (() => Date.now() / 1000);
    this.viewRoot = opts.viewRoot ?? viewRootFor(import.meta.url);
    this.streamTickMs = opts.streamTickMs ?? STREAM_TICK_MS;
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

  /**
   * Stop listening, and actually stop.
   *
   * `server.close()` alone waits for every open connection to end, and an SSE
   * stream is a connection that by design never does — so a daemon with a view
   * open would hang here forever. Open streams are ended explicitly first.
   *
   * Idle keep-alive sockets are dropped for the same reason at a smaller scale:
   * a client that has finished talking can still hold a pooled socket for
   * several seconds, which turns a graceful stop into a stall for no benefit.
   */
  close(): Promise<void> {
    for (const stop of [...this.openStreams]) stop();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      // AFTER `close()`, which is what stops new connections being accepted.
      this.server.closeIdleConnections();
      // Then let go of the rest. A socket sitting in a client's connection pool
      // is not going to send another request — it just waits out that client's
      // keep-alive timeout, during which `close()` has not resolved and the
      // process cannot exit. Streams were ended gracefully above and any other
      // request here is sub-millisecond, so the next tick is a generous grace
      // period rather than a guess.
      setImmediate(() => this.server.closeAllConnections());
    });
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

    // Deliberately ahead of the token check — see the note in view.ts. These
    // files carry no session data; everything that does is still gated below.
    if ((path === "/view" || path.startsWith("/view/")) && req.method === "GET") {
      if (serveAsset(this.viewRoot, path, res)) return;
      return this.json(res, 404, {
        error: "view not built",
        detail: "run `npm run build` to produce dist/view",
      });
    }

    if (!this.authorized(req)) {
      if (path.startsWith("/hook/")) {
        // CAP-08 — an unset $ASTIR_TOKEN interpolates to an empty string rather
        // than failing, so this is far more likely a misconfigured hook than an
        // attack. Say so once, loudly: silence here is the failure mode that let
        // the previous version look healthy while receiving nothing.
        this.counters.unauthorizedIngest++;
        this.lastUnauthorizedAt = Date.now();
        if (!this.warnedAboutToken) {
          this.warnedAboutToken = true;
          process.stderr.write(
            "astir: a hook POSTed without a valid token — events are being rejected.\n" +
              "       Is $ASTIR_TOKEN exported in the environment Claude Code runs in?\n" +
              "       Run `astir install` for the export line.\n",
          );
        }
      }
      return this.json(res, 401, { error: "unauthorized" });
    }

    if (path === "/state" && req.method === "GET") {
      this.counters.statePolls++;
      return this.json(res, 200, this.snapshot());
    }

    // VIEW-02 — the live wire. One snapshot, then only what changed.
    if (path === "/stream" && req.method === "GET") {
      const sessionId = url.searchParams.get("session");
      if (sessionId === null) return this.json(res, 400, { error: "session required" });
      return this.stream(req, res, sessionId);
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
    /**
     * PSH-11 — raising the window happens HERE, in the daemon, not in whatever
     * process typed `astir focus`.
     *
     * macOS attributes a TCC grant (Accessibility, Automation) to the
     * *responsible process* — the app that spawned the chain — not to the binary
     * doing the work. Running the window manipulation inside the CLI therefore
     * charged the permission to whoever invoked it: Visual Studio Code from its
     * integrated terminal, SwiftBar from a menu click, Ghostty from a shell. The
     * same feature then demanded a separate grant from every entry point, and
     * Automation is granted per (controller, target) PAIR, so it multiplied
     * rather than added.
     *
     * The daemon is the one long-lived process every surface already talks to,
     * so doing it here collapses that to a single identity. It does not solve
     * the identity itself — an unsigned Node process is attributed to the `node`
     * binary, which is both too broad and unrecognisable in System Settings —
     * and a signed astir.app remains the only clean answer. This is the shape
     * that app would inherit.
     */
    if (path === "/focus" && req.method === "POST") {
      const sessionId = url.searchParams.get("session");
      if (sessionId === null) return this.json(res, 400, { error: "session required" });

      // A session we cannot hear is still focusable, and is arguably the one you
      // most want to reach — you cannot see what it is doing from here.
      const known = this.opts.registry.get(sessionId);
      const quiet = this.opts.registry.silent().find((d) => d.sessionId === sessionId);
      const target = known ?? quiet;
      if (target === undefined) {
        return this.json(res, 404, { ok: false, detail: `no session ${sessionId}` });
      }

      // 200 even when the focus itself failed: the detail is the point, and the
      // client drops a non-2xx body on the floor.
      const result = this.focus({
        sessionId,
        pid: target.pid ?? null,
        cwd: target.cwd,
        name: target.name ?? null,
      });
      return this.json(res, 200, { ok: result.ok, detail: result.detail });
    }

    if (path === "/forget" && req.method === "POST") {
      const sessionId = url.searchParams.get("session");
      if (sessionId === null) return this.json(res, 400, { error: "session required" });
      const existed = this.opts.registry.forget(sessionId);
      return this.json(res, existed ? 200 : 404, { ok: existed });
    }

    return this.json(res, 404, { error: "not found" });
  }

  /**
   * Hold a connection open and feed it frames until the client leaves or the
   * session does.
   *
   * Everything about WHAT to send lives in `StreamState`; this method is only
   * responsible for the socket, the timers and taking them all down again. The
   * teardown is the part worth reading: a stream that leaks a timer keeps
   * observing a session nobody is watching, forever.
   */
  private stream(req: IncomingMessage, res: ServerResponse, sessionId: string): void {
    if (this.opts.registry.get(sessionId) === undefined) {
      this.json(res, 404, { error: "no such session", sessionId });
      return;
    }
    if (this.counters.streamsOpen >= MAX_STREAMS) {
      this.counters.streamsRefused++;
      this.json(res, 503, { error: "too many streams", limit: MAX_STREAMS });
      return;
    }

    this.counters.streams++;
    this.counters.streamsOpen++;

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      // Nothing should sit between here and the browser, but if something does,
      // buffering an event stream turns "live" into "eventually".
      "x-accel-buffering": "no",
    });

    const state = new StreamState(sessionId);
    const observe = observer(this.opts.registry, sessionId, () => Date.now());

    let closed = false;
    const stop = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(tick);
      clearInterval(beat);
      this.openStreams.delete(stop);
      this.counters.streamsOpen--;
      if (!res.writableEnded) res.end();
    };
    this.openStreams.add(stop);

    const push = (): void => {
      if (closed) return;
      const message = state.next(observe());
      if (message === null) return;
      // A client that has gone away without the socket noticing yet makes this
      // throw; that is a reason to stop, not to take the daemon with it.
      try {
        res.write(sseFrame(message));
        this.counters.framesSent++;
      } catch {
        stop();
        return;
      }
      if (message.kind === "end") stop();
    };

    const tick = setInterval(push, this.streamTickMs);
    const beat = setInterval(() => {
      if (closed) return;
      try {
        res.write(": beat\n\n");
      } catch {
        stop();
      }
    }, STREAM_HEARTBEAT_MS);
    // A pending timer must not be the reason this process outlives its work.
    tick.unref?.();
    beat.unref?.();

    req.on("close", stop);
    res.on("close", stop);
    res.on("error", stop);

    // Send the opening snapshot immediately rather than after one tick: a view
    // that shows nothing for a second on every load reads as broken.
    push();
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

    // The session this payload claims to belong to, read from the raw body so a
    // gap can still be attributed when the payload never became a valid event.
    // Losing that attribution is exactly how a count ends up daemon-wide, and a
    // daemon-wide count shown against one session is a warning about work that
    // session never lost.
    const claimed = (payload as Record<string, unknown> | null)?.session_id;
    const claimedSession = typeof claimed === "string" ? claimed : null;

    this.counters.pathsOutsideRepo += droppedPaths;

    if (event === null) {
      // Two very different things arrive here, and only one is a gap.
      //
      // A hook kind astir deliberately does not map (PreCompact, for one) is
      // working as designed — nothing was lost, because nothing was ever going
      // to be recorded. A payload that is malformed, or that names no session,
      // IS a gap. Counting them together made the view announce "this map is
      // missing work that happened" every time a session compacted, which
      // spends on a non-event the credibility a real gap needs.
      const unmapped = claimedSession !== null;
      if (unmapped) {
        this.counters.unmapped++;
      } else {
        this.counters.rejected++;
      }
      this.json(res, 422, { error: "unmapped or invalid hook payload" });
      return;
    }

    const valid = validateEvent(event);
    if (!valid.ok) {
      this.counters.rejected++;
      if (claimedSession !== null) {
        this.opts.registry.noteGaps(claimedSession, {
          invalidEvents: 1,
          pathsOutsideRepo: droppedPaths,
        });
      }
      this.json(res, 400, { error: valid.error });
      return;
    }

    const cwd =
      typeof (payload as Record<string, unknown>).cwd === "string"
        ? ((payload as Record<string, unknown>).cwd as string)
        : "";

    const result = this.opts.registry.apply(valid.event, cwd);
    // Recorded AFTER apply, deliberately: `noteGaps` will not create a session,
    // and apply is what creates it. Counting before would silently discard the
    // drops from a session's very first event, which is exactly when a
    // misconfigured cwd produces the most of them.
    if (droppedPaths > 0) {
      this.opts.registry.noteGaps(valid.event.sessionId, { pathsOutsideRepo: droppedPaths });
    }
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
        // Discovery already knows this. Dropping it made a silent session
        // unfocusable — the one thing you can still usefully do with a session
        // astir cannot hear is go and look at it.
        pid: d.pid,
        startedAt: d.startedAt,
        ...(d.attended === undefined ? {} : { attended: d.attended }),
      })),
      everIngested: this.counters.ingested > 0,
      unauthorizedIngest: this.counters.unauthorizedIngest,
      lastUnauthorizedAt: this.lastUnauthorizedAt,
      // The daemon keeps state in memory only, so a restart forgets every
      // running session. Their hooks fire on activity, and an idle session
      // emits nothing — so without this the surface reports perfectly wired
      // sessions as "not connected" for as long as they stay quiet.
      daemonStartedAt: this.startedAt,
      // Merged by session id, so a machine that both pushes and answers an SSH
      // poll appears once — see `mergeRemoteSessions`. The push wins on state,
      // the poll wins on the name the user configured.
      remote: mergeRemoteSessions(this.opts.pushedSessions?.() ?? [], this.opts.remoteSessions?.() ?? []),
      sessions: this.opts.registry.list().map((s) => ({
        sessionId: s.sessionId,
        provider: s.provider,
        cwd: s.cwd,
        name: s.name,
        status: s.status,
        pid: s.pid,
        ...(s.attended === undefined ? {} : { attended: s.attended }),
        // MOD-01/MOD-08 — bounded on purpose; see FileSummary.
        ...(s.map.size === 0
          ? {}
          : {
              files: {
                touched: s.map.size,
                hottest: s.map.hottest(HOTTEST_ON_STATE),
                samples: s.map.samples,
                since: s.map.since,
              },
            }),
        agents: [...s.agents.values()].map((a) => ({
          id: a.id,
          agentType: a.agentType,
          parentId: a.parentId,
          parentSource: a.parentSource,
          state: a.state,
          activeMs: a.activeMs,
          turnMs: a.turnMs,
          blockedMs: a.blockedMs,
          // Computed here rather than in the renderer: the daemon owns the clock,
          // and a surface reading a cached response should not silently age it.
          inStateMs: Math.max(0, now - a.stateSince),
          acknowledged: a.acknowledgedAt !== null,
          description: a.description,
          tool: a.tool,
          toolPath: a.toolPath,
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
