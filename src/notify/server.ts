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
import { hostname } from "node:os";
import { notificationText, validateEnvelope } from "./envelope.js";
import type { Notification, NotifyOutcome } from "./notify.js";
import { RemoteView } from "./remote.js";
import { RosterStore, validateRoster } from "./roster.js";

/** A doorbell is small; anything larger is a mistake or an attack. */
const MAX_BODY_BYTES = 64 * 1024;
/** Dedupe window for repeated ids, so a retry does not double-notify. */
const SEEN_MAX = 512;

export interface NotifierServerOpts {
  token: string;
  /**
   * Show it here. A backend answers with what became of it, and a failure is
   * refused rather than counted; a bare function that answers nothing is
   * taken at its word.
   *
   * Not `Notifier`: a function type returning bare `void` accepts one
   * returning anything, so `(n) => seen.push(n)` compiled as a notifier and
   * its 1 was read as an outcome. Unioned with the outcome, `void` no longer
   * does — and `show` still checks, for a `Notifier` built elsewhere.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: `undefined` would refuse a block-bodied notifier; `void` alone accepts anything
  notify: (n: Notification) => void | Promise<NotifyOutcome>;
  onEvent?: (line: string) => void;
  /** Injectable per §9 so expiry is testable without waiting half an hour. */
  view?: RemoteView;
  roster?: RosterStore;
  now?: () => number;
  /** This machine's name. Injectable so the self-roster guard is testable. */
  host?: string;
  /**
   * #78, one hop on — why this machine cannot show a notification, when it
   * cannot (a headless Linux box with no notify-send or no session bus).
   *
   * Without it the receiver answered `ok: true` to a doorbell it could not
   * show, so the sending daemon counted the block as delivered and its
   * `delivery.live` kept naming this path. Refusing tells the sender the truth.
   *
   * Every POST to `/notify` is refused while this is set, not only the ones
   * that would raise a banner: round one accepted a `resolved` — nothing to
   * display — and that 200 erased the sender's verdict on the 503 before it,
   * so the path read live again the moment the user answered.
   */
  cannotShow?: string;
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
  private counters = {
    received: 0,
    delivered: 0,
    duplicates: 0,
    rejected: 0,
    unauthorized: 0,
    resolved: 0,
    rosters: 0,
    /** Rosters this machine sent to itself; see the /roster route. */
    selfRosters: 0,
  };
  private readonly view: RemoteView;
  private readonly roster: RosterStore;
  private readonly host: string;
  private readonly now: () => number;
  /**
   * #78 — why the last notification tried here was not shown, or null. The
   * runtime half of `cannotShow`: a headless systemd host has notify-send and
   * an exported session bus, so nothing is known to be wrong until a run
   * exits 1. Cleared by the next doorbell that shows, which is why doorbells
   * are still tried while it is set.
   */
  private showFailure: string | null = null;

  constructor(private opts: NotifierServerOpts) {
    this.view = opts.view ?? new RemoteView();
    this.now = opts.now ?? (() => Date.now());
    this.roster = opts.roster ?? new RosterStore(this.now);
    this.host = opts.host ?? hostname();
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
      // #78 — `canShow` lets the daemon's PSH-14 probe tell a notifier that can
      // reach someone from one that will refuse every doorbell, without
      // sending one. A boolean only: this route takes no token.
      return this.json(res, 200, {
        ok: true,
        role: "notifier",
        canShow: this.opts.cannotShow === undefined && this.showFailure === null,
        counters: this.counters,
      });
    }

    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (auth?.[1] === undefined || !constantTimeEqual(auth[1], this.opts.token)) {
      this.counters.unauthorized++;
      return this.json(res, 401, { error: "unauthorized" });
    }

    // PSH-12 — the local menu bar merges this with the local daemon's own state,
    // so sessions on other machines are visible, not merely audible.
    if (path === "/state" && req.method === "GET") {
      const now = this.now();
      this.view.prune(now);
      return this.json(res, 200, {
        role: "notifier",
        blockedCount: this.view.blockedCount(),
        agents: this.view.list(now),
        // DMN-10 — everything those machines are running, not only what is
        // blocked. A quiet remote machine and an unreachable one must not look
        // the same.
        sessions: this.roster.list(),
      });
    }

    // DMN-10 — a remote daemon announcing its roster.
    if (path === "/roster" && req.method === "POST") {
      const body = await this.readBody(req);
      if (body === null) {
        this.counters.rejected++;
        return this.json(res, 400, { error: "bad body" });
      }
      const parsed = validateRoster(body);
      if (!parsed.ok) {
        this.counters.rejected++;
        return this.json(res, 400, { error: parsed.error });
      }
      // A daemon and a notifier on the SAME machine cannot tell each other
      // apart by address: a remote daemon reaches this notifier through
      // `ssh -R` on 127.0.0.1, which is exactly where a local one sits too. So
      // the roster names its origin, and a roster from this machine is dropped
      // — otherwise every local session would be listed back to the menu bar
      // under "Other machines", which is both wrong and the duplicate-row
      // problem again. Not an error: the sender did nothing wrong.
      if (parsed.roster.host === this.host) {
        this.counters.selfRosters++;
        return this.json(res, 200, { ok: true, ignored: "self" });
      }

      this.roster.apply(parsed.roster);
      this.counters.rosters++;
      return this.json(res, 200, { ok: true, sessions: parsed.roster.sessions.length });
    }

    if (path === "/dismiss" && req.method === "POST") {
      const sessionId = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("session");
      const n = this.view.acknowledge(sessionId ?? undefined);
      return this.json(res, 200, { ok: true, acknowledged: n });
    }

    if (path === "/forget" && req.method === "POST") {
      const sessionId = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("session");
      if (sessionId === null) return this.json(res, 400, { error: "session required" });
      return this.json(res, 200, { ok: this.view.forget(sessionId) });
    }

    if (path !== "/notify" || req.method !== "POST") {
      return this.json(res, 404, { error: "not found" });
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
      // Refused like anything else while nothing can be shown: a 200 is a 200
      // to the sender, whatever the body says.
      const cannot = this.opts.cannotShow ?? this.showFailure;
      if (cannot !== null) return this.refuse(res, `cannot show notifications here: ${cannot}`);
      return this.json(res, 200, { ok: true, duplicate: true });
    }
    this.seen.add(envelope.id);
    while (this.seen.size > SEEN_MAX) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }

    const now = this.now();
    const { notify } = this.view.apply(envelope, now);
    this.view.prune(now);
    if (envelope.kind === "resolved") this.counters.resolved++;

    // The remote view above is updated either way — a menu here can still
    // list and clear the block — but nobody was interrupted, so the sender
    // must not count it, and must not read any answer as "this path works".
    if (this.opts.cannotShow !== undefined) {
      return this.refuse(res, `cannot show notifications here: ${this.opts.cannotShow}`);
    }
    if (notify) {
      const outcome = await this.show(notificationText(envelope));
      if (!outcome.ok) {
        this.showFailure = outcome.reason;
        return this.refuse(res, `could not show it here: ${outcome.reason}`);
      }
      this.showFailure = null;
      this.counters.delivered++;
      this.opts.onEvent?.(`${envelope.kind} ← ${envelope.body}`);
    } else if (this.showFailure !== null) {
      // A resolution, or a reminder already dismissed here. Nothing to show,
      // so nothing that could prove the last failure wrong.
      return this.refuse(res, `cannot show notifications here: ${this.showFailure}`);
    }

    return this.json(res, 200, { ok: true });
  }

  /** Show one, and say what became of it. Never throws. */
  private async show(n: Notification): Promise<NotifyOutcome> {
    try {
      // Only an outcome is read as one. Anything else is a bare function
      // that said nothing — whatever its expression body happened to return —
      // and refusing a notification it had just shown, as round two did with
      // `push`'s 1, is the lie this whole route exists to stop.
      const outcome: unknown = await this.opts.notify(n);
      if (typeof outcome !== "object" || outcome === null) return { ok: true };
      const { ok, reason } = outcome as { ok?: unknown; reason?: unknown };
      if (ok !== false) return { ok: true };
      // Repeated in the 503 and so in the sender's log: a fixed fallback
      // rather than `undefined`, and never anything but the backend's own
      // content-free reason (SEC-01).
      return { ok: false, reason: typeof reason === "string" ? reason : "the notifier failed" };
    } catch {
      // A failing notifier must never take down the receiver — nor be counted
      // as showing anything.
      return { ok: false, reason: "the notifier failed to run" };
    }
  }

  /** 503: the sender's cue that this path reached no one. */
  private refuse(res: ServerResponse, error: string): void {
    this.counters.rejected++;
    this.json(res, 503, { ok: false, error });
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
