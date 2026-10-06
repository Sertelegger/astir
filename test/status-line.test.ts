/**
 * #80 — `astir status --line`: one line, in the terminal you are typing in.
 *
 * The line is the second serialiser `menu.ts` anticipated, and it has one job:
 * never be calm when it has no right to be. So most of what is tested here is
 * what it says when something is WRONG — a dead daemon, an impostor on the
 * port, a delivery path that cannot reach anyone, a session astir cannot hear,
 * a fetch that never came back — and that only the first of those is said.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteView } from "../src/notify/remote.js";
import type { RemoteAgentView } from "../src/status/fetch.js";
import type { ProbeDeps } from "../src/status/focus.js";
import {
  DEFAULT_LINE_BUDGET_MS,
  focusProbe,
  LINE_TEXT,
  type LineDeps,
  type LineInput,
  runStatusLine,
  statusLine,
} from "../src/status/line.js";
import { buildMenu } from "../src/status/menubar.js";
import type {
  HealthBody,
  RemoteSession,
  StatusAgent,
  StatusBody,
  StatusResult,
  StatusSession,
} from "../src/status/types.js";

const SELF = "devbox";
const NOW = 1_800_000_000_000;
const MIN = 60_000;

const agent = (over: Partial<StatusAgent> = {}): StatusAgent => ({
  id: "main",
  state: "thinking",
  agentType: null,
  activeMs: 0,
  blockedMs: 0,
  inStateMs: 1_000,
  acknowledged: false,
  announcedAt: null,
  ...over,
});

/** Blocked, and the notify loop has said so. */
const announced = (over: Partial<StatusAgent> = {}): StatusAgent =>
  agent({ state: "blocked", announcedAt: NOW - 1_000, ...over });

const session = (over: Partial<StatusSession> = {}): StatusSession => ({
  sessionId: "s1",
  cwd: "/home/x/repos/astir",
  name: "astir-aa",
  status: "busy",
  pid: 100,
  agents: [agent()],
  ...over,
});

/** A current daemon's `/state`: v2.2 is the first that says what it announced. */
const body = (over: Partial<StatusBody> = {}): StatusBody => ({
  v: { major: 2, minor: 2 },
  blockedCount: 0,
  sessions: [],
  silent: [],
  host: SELF,
  ...over,
});

const health = (over: Partial<HealthBody> = {}): HealthBody => ({
  ok: true,
  role: "daemon",
  host: SELF,
  delivery: { live: ["local"] },
  ...over,
});

const doorbell = (over: Partial<RemoteAgentView> = {}): RemoteAgentView => ({
  host: "laptop",
  repo: "web",
  sessionId: "r1",
  agentId: "main",
  reason: "permission_prompt",
  since: NOW - 5 * MIN,
  lastSeen: NOW,
  acknowledged: false,
  ...over,
});

const roster = (over: Partial<RemoteSession> = {}): RemoteSession => ({
  host: "laptop",
  sessionId: "r1",
  cwd: "/Users/x/web",
  name: null,
  status: "busy",
  source: "push",
  lastSeen: NOW,
  ...over,
});

const ok = (b: StatusBody): StatusResult => ({ ok: true, body: b });

const input = (over: Partial<LineInput> = {}): LineInput => ({
  session: null,
  port: 47_000,
  health: health(),
  status: ok(body()),
  remote: null,
  now: NOW,
  selfHost: SELF,
  ...over,
});

describe("nothing to say means nothing printed", () => {
  it("is null — the caller prints nothing — when all is well and nothing waits", () => {
    const r = statusLine(input({ status: ok(body({ sessions: [session()] })) }));
    expect(r.line).toBeNull();
    expect(r.warnings).toEqual([]);
    expect(r.blocked).toBe(0);
    expect(r.announced).toBe(0);
  });
});

describe("warnings, in precedence", () => {
  it("1 — no daemon listening says no one will be told", () => {
    const r = statusLine(
      input({ health: null, status: { ok: false, kind: "absent", reason: "no daemon on 127.0.0.1:47000" } }),
    );
    expect(r.line).toBe("astir: daemon not running — no one will be told");
    expect(r.warnings.map((w) => w.kind)).toEqual(["daemon-down"]);
  });

  it("1 — no token and nothing on /healthz is still a daemon that is not running", () => {
    const r = statusLine(
      input({ health: null, status: { ok: false, kind: "no-token", reason: "no token" } }),
    );
    expect(r.warnings[0]?.kind).toBe("daemon-down");
  });

  it("2 — another machine's daemon on the port names that machine and the port", () => {
    const r = statusLine(
      input({
        port: 47_123,
        health: health({ host: "laptop" }),
        status: { ok: false, kind: "foreign", host: "laptop", reason: "…" },
      }),
    );
    expect(r.line).toBe("astir: port 47123 is laptop's daemon, not this machine's");
    expect(r.warnings[0]?.kind).toBe("impostor");
  });

  it("2 — /healthz alone is enough to see an impostor, with no token to read /state", () => {
    // `/healthz` needs no token. A box with no token yet is exactly a box where
    // a forwarded port is the likeliest thing answering.
    const r = statusLine(
      input({
        health: health({ host: "laptop.local" }),
        status: { ok: false, kind: "no-token", reason: "x" },
      }),
    );
    expect(r.warnings[0]).toEqual({ kind: "impostor", text: LINE_TEXT.impostor(47_000, "laptop") });
  });

  it("2 — an impostor's sessions are not counted as this machine's", () => {
    // An older /state with no host, so fetchStatus let it through; /healthz
    // still says whose it is.
    const hostless = body({ blockedCount: 1, sessions: [session({ agents: [announced()] })] });
    delete hostless.host;
    const r = statusLine(input({ health: health({ host: "laptop" }), status: ok(hostless) }));
    expect(r.warnings[0]?.kind).toBe("impostor");
    expect(r.blocked).toBe(0);
    expect(r.announced).toBe(0);
    expect(r.rows).toEqual([]);
  });

  it("3 — no live delivery path says nothing can notify you", () => {
    const r = statusLine(input({ health: health({ delivery: { live: [] } }) }));
    expect(r.line).toBe("astir: nothing can notify you — no notifier is reachable");
    expect(r.warnings.map((w) => w.kind)).toEqual(["no-delivery"]);
  });

  it("3 — an older daemon that does not report delivery is NOT warned about", () => {
    // Absent is "cannot tell". Shouting "nothing can notify you" at everyone on
    // an older daemon would teach them to ignore the one warning that matters.
    const older = health();
    delete older.delivery;
    const r = statusLine(input({ health: older }));
    expect(r.warnings).toEqual([]);
    expect(statusLine(input({ health: null })).warnings).toEqual([]);
  });

  it("4 — the asking session in silent[] hears that astir hears nothing from it", () => {
    const b = body({ silent: [{ sessionId: "me", name: null, cwd: "/x" }] });
    expect(statusLine(input({ session: "me", status: ok(b) })).line).toBe(
      "astir: hears nothing from this session",
    );
  });

  it("4 — only when a session was named, and only that session", () => {
    const b = body({ silent: [{ sessionId: "other", name: null, cwd: "/x" }] });
    expect(statusLine(input({ session: null, status: ok(b) })).warnings).toEqual([]);
    expect(statusLine(input({ session: "me", status: ok(b) })).warnings).toEqual([]);
  });

  it("shows only the FIRST warning that applies, and lists them all in JSON order", () => {
    const b = body({ silent: [{ sessionId: "me", name: null, cwd: "/x" }] });
    const r = statusLine(input({ session: "me", status: ok(b), health: health({ delivery: { live: [] } }) }));
    expect(r.line).toBe(LINE_TEXT.noDelivery);
    expect(r.warnings.map((w) => w.kind)).toEqual(["no-delivery", "silent"]);
  });

  it("an impostor outranks a dead delivery path", () => {
    const r = statusLine(
      input({
        health: health({ host: "laptop", delivery: { live: [] } }),
        status: { ok: false, kind: "foreign", host: "laptop", reason: "x" },
      }),
    );
    expect(r.line).toBe(LINE_TEXT.impostor(47_000, "laptop"));
  });

  it("a daemon that answers /healthz but refuses /state is never calm", () => {
    // None of the four warnings fit, and "" would read as "all quiet" — the lie
    // the project exists to avoid. So it is `unreachable`, with the reason.
    const r = statusLine(
      input({ status: { ok: false, kind: "rejected", reason: "token rejected — is it current?" } }),
    );
    expect(r.line).toBe("astir: token rejected — is it current?");
    expect(r.warnings.map((w) => w.kind)).toEqual(["unreachable"]);
  });

  it("a /state that answered at all is a daemon, even when /healthz said nothing usable", () => {
    // /healthz can fail on its own — a 503, a body that is not JSON — while
    // /state answers. A 401, a 500 or another machine's host is a daemon
    // ANSWERING, and "daemon not running" there would be false.
    const rejected = statusLine(
      input({
        health: null,
        status: { ok: false, kind: "rejected", reason: "token rejected — is it current?" },
      }),
    );
    expect(rejected.line).toBe("astir: token rejected — is it current?");
    expect(rejected.warnings.map((w) => w.kind)).toEqual(["unreachable"]);

    const http = statusLine(
      input({ health: null, status: { ok: false, kind: "http", reason: "daemon returned 500" } }),
    );
    expect(http.line).toBe("astir: daemon returned 500");

    const foreign = statusLine(
      input({ health: null, status: { ok: false, kind: "foreign", host: "laptop", reason: "x" } }),
    );
    expect(foreign.line).toBe(LINE_TEXT.impostor(47_000, "laptop"));
  });

  it("an inner timeout reads as unreachable, never as a daemon that is not running", () => {
    const r = statusLine(input({ health: null, status: { ok: false, kind: "timeout", reason: "x" } }));
    expect(r.line).toBe("astir unreachable");
    expect(r.warnings).toEqual([{ kind: "unreachable", text: "astir unreachable" }]);
  });
});

describe("the blocks summary — announced blocks only (PSH-16)", () => {
  it("counts announced, unacknowledged blocks with the oldest wait", () => {
    const b = body({
      blockedCount: 2,
      sessions: [
        session({ sessionId: "a", agents: [announced({ inStateMs: 3 * MIN + 12_000 })] }),
        session({ sessionId: "b", cwd: "/p/b", agents: [announced({ inStateMs: 40_000 })] }),
      ],
    });
    const r = statusLine(input({ status: ok(b) }));
    expect(r.line).toBe("2 waiting on you · oldest 3m");
    expect(r.announced).toBe(2);
    expect(r.blocked).toBe(2);
  });

  it("leaves a block the loop has not announced out of the line, but not out of `blocked`", () => {
    // The ambient footer label is the badge PSH-16 leaves ungated; the line is
    // a warning under the prompt, and a block auto-answered in under a second
    // must not flash it.
    const b = body({
      blockedCount: 1,
      sessions: [session({ agents: [agent({ state: "blocked", announcedAt: null, inStateMs: 300 })] })],
    });
    const r = statusLine(input({ status: ok(b) }));
    expect(r.line).toBeNull();
    expect(r.announced).toBe(0);
    expect(r.blocked).toBe(1);
  });

  it("reads an absent announcedAt from a CURRENT daemon as not announced", () => {
    // From a v2.2 daemon an absent field is a shape VER-01 says to ignore, not
    // a block to count. An OLDER daemon is a different case: see below.
    const old = agent({ state: "blocked" });
    delete old.announcedAt;
    const r = statusLine(
      input({ status: ok(body({ blockedCount: 1, sessions: [session({ agents: [old] })] })) }),
    );
    expect(r.line).toBeNull();
    expect(r.warnings).toEqual([]);
    expect(r.blocked).toBe(1);
  });

  it("does not count a block the human already dismissed", () => {
    const b = body({ sessions: [session({ agents: [announced({ acknowledged: true })] })] });
    const r = statusLine(input({ status: ok(b) }));
    expect(r.line).toBeNull();
    expect(r.announced).toBe(0);
  });

  it("applies no dwell of its own (CAP-02) — announcedAt is the only gate", () => {
    // A provider-neutral surface: if the loop announced it, it is shown, however
    // young. The dwell is the loop's business, per provider.
    const b = body({ sessions: [session({ agents: [announced({ inStateMs: 50 })] })] });
    expect(statusLine(input({ status: ok(b) })).line).toBe("1 waiting on you · oldest 0s");
  });

  it("counts other machines' doorbells — already announced — and their age", () => {
    const r = statusLine(input({ remote: { agents: [doorbell({ since: NOW - 7 * MIN })], sessions: [] } }));
    expect(r.line).toBe("1 waiting on you · oldest 7m");
    expect(r.blocked).toBe(1);
    expect(r.announced).toBe(1);
  });

  it("drops a doorbell from THIS host, which is already counted locally", () => {
    const b = body({ blockedCount: 1, sessions: [session({ agents: [announced()] })] });
    const r = statusLine(
      input({
        status: ok(b),
        remote: { agents: [doorbell({ host: `${SELF}.local`, sessionId: "s1" })], sessions: [] },
      }),
    );
    expect(r.announced).toBe(1);
    expect(r.blocked).toBe(1);
  });

  it("does not count a dismissed doorbell, as the menu bar badge does not", () => {
    const r = statusLine(input({ remote: { agents: [doorbell({ acknowledged: true })], sessions: [] } }));
    expect(r.line).toBeNull();
    expect(r.blocked).toBe(0);
  });

  it("does not count a contact-lost doorbell either — but says contact was lost, never calm", () => {
    const r = statusLine(input({ remote: { agents: [doorbell({ stale: true })], sessions: [] } }));
    expect(r.line).toBe(LINE_TEXT.contactLost(1));
    expect(r.warnings).toEqual([{ kind: "contact-lost", text: LINE_TEXT.contactLost(1) }]);
    expect(r.blocked).toBe(0);
    expect(r.announced).toBe(0);
  });

  it("joins a warning and the summary with ` · `", () => {
    const b = body({ blockedCount: 1, sessions: [session({ agents: [announced({ inStateMs: 2 * MIN })] })] });
    const r = statusLine(input({ status: ok(b), health: health({ delivery: { live: [] } }) }));
    expect(r.line).toBe(`${LINE_TEXT.noDelivery} · 1 waiting on you · oldest 2m`);
  });

  it("still counts other machines when the local daemon is down", () => {
    // The notifier is a separate process; its doorbells survive the daemon
    // dying, as the menu bar's stranded branch already shows.
    const r = statusLine(
      input({
        health: null,
        status: { ok: false, kind: "absent", reason: "x" },
        remote: { agents: [doorbell()], sessions: [roster()] },
      }),
    );
    expect(r.line).toBe(`${LINE_TEXT.daemonDown} · 1 waiting on you · oldest 5m`);
    expect(r.rows.map((row) => row.sessionId)).toEqual(["r1"]);
  });
});

describe("SEC-01 / PSH-11 — counts, never names or content", () => {
  it("carries no tool, path, description or session name anywhere", () => {
    const b = body({
      blockedCount: 1,
      sessions: [
        session({
          name: "SESSION-NAME-X",
          cwd: "/home/x/SECRET-DIR/astir",
          agents: [
            announced({
              tool: "TOOL-X",
              toolPath: "/etc/TOOLPATH-X",
              description: "DESCRIPTION-X",
            }),
          ],
        }),
      ],
      silent: [{ sessionId: "q", name: "SILENT-NAME-X", cwd: "/home/x/SILENT-DIR/q" }],
    });
    const r = statusLine(
      input({ status: ok(b), remote: { agents: [doorbell({ reason: "REASON-X" })], sessions: [] } }),
    );
    const all = JSON.stringify(r);
    for (const secret of [
      "TOOL-X",
      "TOOLPATH-X",
      "DESCRIPTION-X",
      "SECRET-DIR",
      "SILENT-DIR",
      "SESSION-NAME-X",
      "SILENT-NAME-X",
      "REASON-X",
    ]) {
      expect(all, secret).not.toContain(secret);
    }
    // The line itself is counts only — not even the repo label.
    expect(r.line).toBe("2 waiting on you · oldest 5m");
  });
});

/**
 * `/healthz` answers anyone, with no token, and whatever is on the port wrote
 * it. What it says is printed raw into a tmux status segment, where `#[...]`
 * is a style and a newline is a second line, and into a terminal.
 */
describe("what a socket said is not trusted to be what the type says", () => {
  const noToken: StatusResult = { ok: false, kind: "no-token", reason: "no token — run `astir install`" };

  it("reads a host that is not a string as 'cannot tell', and does not crash on it", () => {
    for (const host of [123, { evil: true }, null, ["laptop"]]) {
      const r = statusLine(input({ health: { host } as unknown as HealthBody, status: noToken }));
      expect(
        r.warnings.map((w) => w.kind),
        JSON.stringify(host),
      ).toEqual(["unreachable"]);
      expect(r.line).toBe("astir: no token — run `astir install`");
    }
  });

  it("prints an impostor's name with nothing a tmux segment or a terminal would act on", () => {
    const r = statusLine(
      input({ health: health({ host: "ev#[fg=red]il\u001b]0;x\u0007" }), status: noToken }),
    );
    expect(r.line).toBe("astir: port 47000 is another machine's daemon, not this machine's");
    const lf = statusLine(input({ health: health({ host: "laptop\nevil" }), status: noToken }));
    expect(lf.line).toBe(LINE_TEXT.impostor(47_000, "another machine"));
    for (const text of [r.line, lf.line, r.warnings[0]?.text, lf.warnings[0]?.text]) {
      expect(text).not.toMatch(/\p{Cc}|#/u);
    }
  });

  it("still calls a host it will not print foreign, and still counts none of its sessions", () => {
    // Refusing to print a name must not turn it into "mine": that would count
    // another machine's blocks as this one's.
    const hostless = body({ blockedCount: 1, sessions: [session({ agents: [announced()] })] });
    delete hostless.host;
    const r = statusLine(input({ health: health({ host: "\u001b\u0007" }), status: ok(hostless) }));
    expect(r.line).toBe(LINE_TEXT.impostor(47_000, "another machine"));
    expect(r.blocked).toBe(0);
    expect(r.rows).toEqual([]);
  });
});

describe("--json rows", () => {
  it("is versioned, and orders rows through overview() — blocked first", () => {
    const b = body({
      blockedCount: 1,
      sessions: [
        session({ sessionId: "quiet", cwd: "/p/alpha", agents: [agent({ state: "idle" })] }),
        session({ sessionId: "waits", cwd: "/p/gamma", agents: [announced({ inStateMs: 90_000 })] }),
      ],
    });
    const r = statusLine(input({ status: ok(b) }));
    expect(r.v).toEqual({ major: 1, minor: 1 });
    expect(r.rows[0]).toEqual({
      sessionId: "waits",
      host: null,
      label: "gamma",
      state: "blocked",
      waitingMs: 90_000,
      acknowledged: false,
      announced: true,
      focusable: false,
    });
    expect(r.rows[1]?.sessionId).toBe("quiet");
    expect(r.rows[1]?.waitingMs).toBeNull();
  });

  it("marks an unannounced block as not announced, and a dismissed one as acknowledged", () => {
    const b = body({
      sessions: [
        session({
          sessionId: "young",
          cwd: "/p/a",
          agents: [agent({ state: "blocked", announcedAt: null })],
        }),
        session({ sessionId: "seen", cwd: "/p/b", agents: [announced({ acknowledged: true })] }),
      ],
    });
    const rows = statusLine(input({ status: ok(b) })).rows;
    const by = (id: string) => rows.find((r) => r.sessionId === id);
    expect(by("young")).toMatchObject({ state: "blocked", announced: false, acknowledged: false });
    expect(by("seen")).toMatchObject({ announced: true, acknowledged: true });
  });

  it("puts another machine's doorbell above a quiet local session (VIEW-09 spans machines)", () => {
    const b = body({ sessions: [session({ sessionId: "quiet", cwd: "/p/alpha", agents: [agent()] })] });
    const r = statusLine(
      input({
        status: ok(b),
        remote: { agents: [doorbell({ since: NOW - 2 * MIN })], sessions: [roster()] },
      }),
    );
    expect(r.rows[0]).toEqual({
      sessionId: "r1",
      host: "laptop",
      label: "web",
      state: "blocked",
      waitingMs: 2 * MIN,
      acknowledged: false,
      announced: true,
      focusable: false,
    });
    expect(r.rows).toHaveLength(2);
  });

  it("gives a doorbell with no roster entry a row of its own", () => {
    // An older remote daemon sends doorbells and no roster. The block is real;
    // a JSON consumer listing sessions must not lose it.
    const r = statusLine(input({ remote: { agents: [doorbell({ sessionId: "lonely" })], sessions: [] } }));
    expect(r.rows).toEqual([
      expect.objectContaining({ sessionId: "lonely", host: "laptop", label: "web", state: "blocked" }),
    ]);
  });

  it("merges the notifier's roster with the daemon's, as the menu bar does", () => {
    const b = body({ remote: [roster({ source: "ssh", host: "alias" })] });
    const r = statusLine(input({ status: ok(b), remote: { agents: [], sessions: [roster()] } }));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.host).toBe("alias");
  });

  it("asks the focus probe only about local sessions with a pid", () => {
    const probe = vi.fn((pid: number) => pid === 100);
    const b = body({
      sessions: [
        session({ sessionId: "here", cwd: "/p/a", pid: 100 }),
        session({ sessionId: "nopid", cwd: "/p/b", pid: null }),
        session({ sessionId: "elsewhere", cwd: "/p/c", pid: 200 }),
      ],
      silent: [{ sessionId: "mute", name: null, cwd: "/p/d", pid: 100 }],
    });
    const r = statusLine(
      input({ status: ok(b), remote: { agents: [], sessions: [roster()] }, focusable: probe }),
    );
    const by = (id: string) => r.rows.find((row) => row.sessionId === id)?.focusable;
    expect(by("here")).toBe(true);
    expect(by("nopid")).toBe(false);
    expect(by("elsewhere")).toBe(false);
    // A silent session is local and has a pid; focusSession acts on it.
    expect(by("mute")).toBe(true);
    expect(by("r1")).toBe(false);
    expect(probe).not.toHaveBeenCalledWith(undefined);
    expect(probe.mock.calls.map((c) => c[0]).sort()).toEqual([100, 100, 200]);
  });

  it("does not draw a remote session as blocked once its doorbells are dismissed or lost, nor rank it first", () => {
    // Two dismissed doorbells, not one: a single one would tie the local block
    // on rank and the stable sort would hide a row that jumped the queue.
    const b = body({
      blockedCount: 1,
      sessions: [session({ sessionId: "waits", cwd: "/p/gamma", agents: [announced()] })],
    });
    const r = statusLine(
      input({
        status: ok(b),
        remote: {
          agents: [
            doorbell({ agentId: "a", acknowledged: true, since: NOW - 2 * MIN }),
            doorbell({ agentId: "b", acknowledged: true, since: NOW - 7 * MIN }),
            doorbell({ sessionId: "r2", stale: true }),
          ],
          sessions: [roster(), roster({ sessionId: "r2", cwd: "/Users/x/api", status: "idle" })],
        },
      }),
    );
    expect(r.rows[0]?.sessionId).toBe("waits");
    const by = (id: string) => r.rows.find((row) => row.sessionId === id);
    // The roster's word for it, not "blocked": nobody is being asked anything.
    expect(by("r1")).toMatchObject({
      state: "busy",
      acknowledged: true,
      announced: true,
      waitingMs: 7 * MIN,
    });
    expect(by("r2")).toMatchObject({ state: "idle", acknowledged: false });
  });

  it("ranks a local block level with another machine's, and keeps overview()'s order between them", () => {
    const b = body({
      blockedCount: 1,
      sessions: [session({ sessionId: "waits", cwd: "/p/gamma", agents: [announced()] })],
    });
    const r = statusLine(input({ status: ok(b), remote: { agents: [doorbell()], sessions: [roster()] } }));
    expect(r.rows.map((row) => [row.sessionId, row.state])).toEqual([
      ["waits", "blocked"],
      ["r1", "blocked"],
    ]);
  });

  it("is acknowledged only when EVERY block in a session is, and waits as long as its oldest", () => {
    const b = body({
      blockedCount: 1,
      sessions: [
        session({
          agents: [
            announced({ id: "a", inStateMs: 30_000, acknowledged: true }),
            announced({ id: "b", inStateMs: 90_000 }),
          ],
        }),
      ],
    });
    expect(statusLine(input({ status: ok(b) })).rows[0]).toMatchObject({
      acknowledged: false,
      waitingMs: 90_000,
    });

    const both = body({
      sessions: [
        session({
          agents: [
            announced({ id: "a", inStateMs: 30_000, acknowledged: true }),
            announced({ id: "b", inStateMs: 90_000, acknowledged: true }),
          ],
        }),
      ],
    });
    expect(statusLine(input({ status: ok(both) })).rows[0]?.acknowledged).toBe(true);
  });

  it("gives another machine's session the wait of its oldest doorbell", () => {
    const r = statusLine(
      input({
        remote: {
          agents: [
            doorbell({ agentId: "a", since: NOW - 2 * MIN }),
            doorbell({ agentId: "b", since: NOW - 7 * MIN }),
          ],
          sessions: [roster()],
        },
      }),
    );
    expect(r.rows[0]).toMatchObject({ sessionId: "r1", waitingMs: 7 * MIN, acknowledged: false });
  });
});

describe("timing out", () => {
  it("is `astir unreachable`, with no counts and no rows — never a stale value", () => {
    const b = body({ blockedCount: 3, sessions: [session({ agents: [announced()] })] });
    const r = statusLine(input({ timedOut: true, status: ok(b) }));
    expect(r.line).toBe("astir unreachable");
    expect(r.warnings).toEqual([{ kind: "unreachable", text: "astir unreachable" }]);
    expect(r.rows).toEqual([]);
    expect(r.announced).toBe(0);
    // Zero and the `unreachable` warning, never the 3 the body carried: a host
    // reads that warning as "count unknown".
    expect(r.blocked).toBe(0);
  });
});

describe("a notifier that did not answer", () => {
  it("is a warning shown only when nothing above it applies, and counts nothing remote", () => {
    const r = statusLine(input({ remoteTimedOut: true, remote: null }));
    expect(r.line).toBe(LINE_TEXT.notifierHung);
    expect(r.blocked).toBe(0);

    const down = statusLine(
      input({ remoteTimedOut: true, health: null, status: { ok: false, kind: "absent", reason: "x" } }),
    );
    expect(down.line).toBe(LINE_TEXT.daemonDown);
    expect(down.warnings.map((w) => w.kind)).toEqual(["daemon-down", "unreachable"]);
  });

  it("#79 — says the same of a notifier that is EXPECTED here and said nothing at all", () => {
    // `fetchRemote` collapses refused, 401 and no-token into null. Where a
    // notifier is expected, that null is other machines going unheard — the
    // menu bar draws it as "notifier unreachable", and so does the line.
    const r = statusLine(input({ remote: null, notifierExpected: true }));
    expect(r.line).toBe(LINE_TEXT.notifierHung);
    expect(r.warnings).toEqual([{ kind: "unreachable", text: LINE_TEXT.notifierHung }]);
  });

  it("#79 — stays calm when no notifier is expected, or when one answered with nothing", () => {
    // A single machine that never paired anything has no notifier, and a
    // warning drawn over it forever would teach people to ignore the line.
    expect(statusLine(input({ remote: null })).line).toBeNull();
    expect(
      statusLine(input({ remote: { agents: [], sessions: [] }, notifierExpected: true })).line,
    ).toBeNull();
  });
});

/**
 * DMN-09 — a doorbell the notifier has marked `stale`: contact with that
 * machine was lost while its agent was waiting. The menu bar draws it red
 * ("unreachable"); the line must not draw it as nothing, which is what an
 * ANSWERED block looks like.
 */
describe("lost contact is not calm", () => {
  const lost = (over: Partial<RemoteAgentView> = {}): RemoteAgentView => doorbell({ stale: true, ...over });

  it("names how many machines, singular and plural", () => {
    expect(LINE_TEXT.contactLost(1)).toBe("astir: lost contact with 1 machine where an agent was waiting");
    expect(LINE_TEXT.contactLost(2)).toBe("astir: lost contact with 2 machines where an agent was waiting");
  });

  it("counts machines, not agents — however the host is spelled", () => {
    const r = statusLine(
      input({
        remote: {
          agents: [
            lost({ agentId: "a" }),
            lost({ agentId: "b" }),
            lost({ sessionId: "r2", host: "LAPTOP.local" }),
            lost({ sessionId: "r3", host: "server" }),
          ],
          sessions: [],
        },
      }),
    );
    expect(r.line).toBe(LINE_TEXT.contactLost(2));
  });

  it("counts a dismissed one too, as the menu bar's red tier does — dismissed is still waiting", () => {
    const r = statusLine(input({ remote: { agents: [lost({ acknowledged: true })], sessions: [] } }));
    expect(r.warnings.map((w) => w.kind)).toEqual(["contact-lost"]);
  });

  it("is only about doorbells: a quiet session gone stale, with nothing waiting, is not this warning", () => {
    const r = statusLine(input({ remote: { agents: [], sessions: [roster({ stale: true })] } }));
    expect(r.warnings).toEqual([]);
  });

  it("ignores a stale doorbell from THIS host, which the local daemon already answers for", () => {
    const r = statusLine(input({ remote: { agents: [lost({ host: SELF })], sessions: [] } }));
    expect(r.warnings).toEqual([]);
  });

  it("leaves the machines still heard from counted, beside the warning", () => {
    const r = statusLine(
      input({
        remote: {
          agents: [lost({ sessionId: "gone", host: "server" }), doorbell({ since: NOW - 5 * MIN })],
          sessions: [],
        },
      }),
    );
    expect(r.line).toBe(`${LINE_TEXT.contactLost(1)} · 1 waiting on you · oldest 5m`);
    expect(r.blocked).toBe(1);
    expect(r.announced).toBe(1);
  });

  it("keeps the lost session as a row in --json", () => {
    const r = statusLine(input({ remote: { agents: [lost()], sessions: [] } }));
    expect(r.rows).toEqual([expect.objectContaining({ sessionId: "r1", host: "laptop", focusable: false })]);
  });

  it("comes after no-delivery and an unreadable /state, and before silent", () => {
    const remote = { agents: [lost()], sessions: [] };
    const me = body({ silent: [{ sessionId: "me", name: null, cwd: "/x" }] });

    const quiet = statusLine(input({ session: "me", status: ok(me), remote }));
    expect(quiet.warnings.map((w) => w.kind)).toEqual(["contact-lost", "silent"]);
    expect(quiet.line).toBe(LINE_TEXT.contactLost(1));

    const dead = statusLine(input({ remote, health: health({ delivery: { live: [] } }) }));
    expect(dead.warnings.map((w) => w.kind)).toEqual(["no-delivery", "contact-lost"]);

    const refused = statusLine(
      input({ remote, status: { ok: false, kind: "rejected", reason: "token rejected" } }),
    );
    expect(refused.warnings.map((w) => w.kind)).toEqual(["unreachable", "contact-lost"]);
  });

  it("is still listed when the local daemon is down — the notifier is a separate process", () => {
    const r = statusLine(
      input({
        health: null,
        status: { ok: false, kind: "absent", reason: "x" },
        remote: { agents: [lost()], sessions: [] },
      }),
    );
    expect(r.line).toBe(LINE_TEXT.daemonDown);
    expect(r.warnings.map((w) => w.kind)).toEqual(["daemon-down", "contact-lost"]);
  });

  it("agrees with the menu bar on the same notifier answer, from the moment the entry goes stale", () => {
    // The real RemoteView ages the entry; the real buildMenu draws it. One
    // doorbell from megabrain, then the tunnel drops and nothing reconfirms it.
    const view = new RemoteView();
    view.apply(
      {
        v: { major: 1, minor: 0 },
        id: "e1",
        ts: NOW,
        kind: "blocked",
        reason: "permission_prompt",
        origin: { host: "megabrain", user: "dev" },
        session: { sessionId: "mb1", agentId: "main", repo: "astir" },
        title: "t",
        body: "b",
      },
      NOW,
    );
    const at = (minutes: number) => {
      const now = NOW + minutes * MIN;
      const remote = { agents: view.list(now), sessions: [] };
      const status = ok(body({ sessions: [session({ agents: [agent({ state: "idle" })] })] }));
      return {
        badge: buildMenu(status, { invocation: ["node", "astir"], remote, now }).badge.symbol,
        line: statusLine(input({ status, remote, now })),
      };
    };

    const heard = at(19);
    expect(heard.badge).toBe("bell.badge.fill");
    expect(heard.line.line).toBe("1 waiting on you · oldest 19m");

    for (const minutes of [21, 45]) {
      const lostNow = at(minutes);
      expect(lostNow.badge).toBe("exclamationmark.triangle");
      expect(lostNow.line.warnings.map((w) => w.kind)).toEqual(["contact-lost"]);
      expect(lostNow.line.line).toBe(LINE_TEXT.contactLost(1));
    }
  });
});

/**
 * `/state` below v2.2 carries no `announcedAt`. The CLI is rebuilt before the
 * daemon is restarted (megabrain runs it from `dist/` in tmux), and in that
 * window an old daemon IS still announcing — with its own dwell, over its own
 * doorbells. Reading every block as unannounced printed nothing while agents
 * waited, which is the worse lie.
 */
describe("an older daemon", () => {
  const raw = (over: Partial<StatusAgent> = {}): StatusAgent => {
    const a = agent({ state: "blocked", ...over });
    delete a.announcedAt;
    return a;
  };
  const older = (over: Partial<StatusBody> = {}): StatusBody =>
    body({
      v: { major: 2, minor: 1 },
      blockedCount: 2,
      sessions: [
        session({ sessionId: "a", agents: [raw({ inStateMs: 10 * MIN })] }),
        session({ sessionId: "b", cwd: "/p/b", agents: [raw({ inStateMs: 2 * MIN })] }),
      ],
      ...over,
    });

  it("says to restart it, and counts its blocked agents raw", () => {
    const r = statusLine(input({ status: ok(older()) }));
    expect(LINE_TEXT.oldDaemon).toBe("astir: the daemon is older than this astir — restart it");
    expect(r.line).toBe(`${LINE_TEXT.oldDaemon} · 2 waiting on you · oldest 10m`);
    expect(r.warnings).toEqual([{ kind: "old-daemon", text: LINE_TEXT.oldDaemon }]);
    expect(r.blocked).toBe(2);
    // `announced` is what the line counts — here, every undismissed block.
    expect(r.announced).toBe(2);
  });

  it("still leaves out a block the human dismissed", () => {
    const b = older({ sessions: [session({ agents: [raw({ acknowledged: true }), raw({ id: "x" })] })] });
    expect(statusLine(input({ status: ok(b) })).announced).toBe(1);
  });

  it("reads any version below 2.2 as older, and a missing or malformed one too", () => {
    // Every astir daemon has sent `v` since the first (e1c9cfe: 2.0), so one
    // with none is not a daemon this astir can read announcedAt from.
    for (const v of [
      { major: 2, minor: 1 },
      { major: 2, minor: 0 },
      { major: 1, minor: 9 },
      undefined,
      "2.2",
      {},
      { major: "2", minor: "2" },
    ]) {
      const b = older();
      if (v === undefined) delete b.v;
      else b.v = v as NonNullable<StatusBody["v"]>;
      expect(
        statusLine(input({ status: ok(b) })).warnings.map((w) => w.kind),
        JSON.stringify(v),
      ).toEqual(["old-daemon"]);
    }
  });

  it("does not warn about 2.2 or anything newer", () => {
    for (const v of [
      { major: 2, minor: 2 },
      { major: 2, minor: 3 },
      { major: 3, minor: 0 },
    ]) {
      const r = statusLine(input({ status: ok(body({ v })) }));
      expect(r.warnings, JSON.stringify(v)).toEqual([]);
    }
  });

  it("comes right after an impostor, whose body is never read as this machine's", () => {
    const foreign = statusLine(
      input({ health: health({ host: "laptop" }), status: ok(older({ host: "laptop" })) }),
    );
    expect(foreign.warnings.map((w) => w.kind)).toEqual(["impostor"]);
    expect(foreign.announced).toBe(0);

    const both = statusLine(input({ status: ok(older()), health: health({ delivery: { live: [] } }) }));
    expect(both.warnings.map((w) => w.kind)).toEqual(["old-daemon", "no-delivery"]);
  });

  it("is what `status --line` prints against one, end to end", async () => {
    const out = await runStatusLine(
      { session: null, json: false },
      deps({
        fetchHealth: async () => ({ ok: true, role: "daemon", host: SELF }),
        fetchStatus: async () => ok(older()),
      }),
    );
    expect(out).toBe(`${LINE_TEXT.oldDaemon} · 2 waiting on you · oldest 10m`);
  });
});

/** Fetchers that answer at once, overridable one at a time. No focus override: the probe runs. */
const fetchers = (over: Partial<LineDeps> = {}): Partial<LineDeps> => ({
  fetchHealth: async () => health(),
  fetchStatus: async () => ok(body()),
  fetchRemote: async () => null,
  now: () => NOW,
  selfHost: SELF,
  ...over,
});

/** The same, with focus decided up front, for every test that is not about the probe. */
const deps = (over: Partial<LineDeps> = {}): Partial<LineDeps> => ({
  focusable: () => false,
  ...fetchers(over),
});

const never = <T>(): Promise<T> => new Promise<T>(() => {});

describe("runStatusLine", () => {
  it("prints nothing at all when there is nothing to say", async () => {
    expect(await runStatusLine({ session: null, json: false }, deps())).toBe("");
  });

  it("prints the line when there is one", async () => {
    const out = await runStatusLine(
      { session: null, json: false },
      deps({
        fetchHealth: async () => null,
        fetchStatus: async () => ({ ok: false, kind: "absent", reason: "x" }),
      }),
    );
    expect(out).toBe(LINE_TEXT.daemonDown);
  });

  it("emits the JSON document with --json, even when the line is empty", async () => {
    const out = await runStatusLine({ session: null, json: true }, deps());
    const doc = JSON.parse(out) as { v: unknown; line: unknown; warnings: unknown; rows: unknown };
    expect(doc).toMatchObject({ v: { major: 1, minor: 1 }, line: null, warnings: [], rows: [] });
    expect(out).not.toContain("\n");
  });

  it("starts every fetch before any answers — one budget, not three", async () => {
    const started: string[] = [];
    const gates: Array<() => void> = [];
    const gated =
      <T>(name: string, value: T) =>
      () => {
        started.push(name);
        return new Promise<T>((resolve) => gates.push(() => resolve(value)));
      };
    const pending = runStatusLine(
      { session: null, json: false, timeoutMs: 5_000 },
      deps({
        fetchHealth: gated("health", health()),
        fetchStatus: gated("status", ok(body())),
        fetchRemote: gated("remote", null),
      }),
    );
    await Promise.resolve();
    expect(started.sort()).toEqual(["health", "remote", "status"]);
    for (const open of gates) open();
    expect(await pending).toBe("");
  });

  it("says `astir unreachable` when the daemon does not answer within the budget", async () => {
    const out = await runStatusLine(
      { session: null, json: false, timeoutMs: 20 },
      deps({ fetchStatus: never }),
    );
    expect(out).toBe("astir unreachable");
  });

  it("keeps the daemon's answer when only the notifier hangs, and says the notifier is not answering", async () => {
    // Measured on the machine #80 was filed for: a stale `ssh -R` forward
    // accepts on 47001 and never answers while the daemon on 47000 is fine.
    // "astir unreachable" there would hide this machine's own blocks.
    const b = body({ blockedCount: 1, sessions: [session({ agents: [announced({ inStateMs: 2 * MIN })] })] });
    const out = await runStatusLine(
      { session: null, json: true, timeoutMs: 20 },
      deps({ fetchStatus: async () => ok(b), fetchRemote: never }),
    );
    const doc = JSON.parse(out) as { line: string; blocked: number; warnings: unknown[]; rows: unknown[] };
    expect(doc.line).toBe(`${LINE_TEXT.notifierHung} · 1 waiting on you · oldest 2m`);
    expect(doc.warnings).toEqual([{ kind: "unreachable", text: LINE_TEXT.notifierHung }]);
    expect(doc.blocked).toBe(1);
    expect(doc.rows).toHaveLength(1);
  });

  it("lets #78's warning outrank a hung notifier — the dead tunnel IS the delivery story", async () => {
    const out = await runStatusLine(
      { session: null, json: true, timeoutMs: 20 },
      deps({ fetchHealth: async () => health({ delivery: { live: [] } }), fetchRemote: never }),
    );
    const doc = JSON.parse(out) as { line: string; warnings: Array<{ kind: string }> };
    expect(doc.line).toBe(LINE_TEXT.noDelivery);
    expect(doc.warnings.map((w) => w.kind)).toEqual(["no-delivery", "unreachable"]);
  });

  it("treats a notifier that throws like one that hangs: unknown, not empty", async () => {
    const out = await runStatusLine(
      { session: null, json: false },
      deps({
        fetchRemote: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(out).toBe(LINE_TEXT.notifierHung);
  });

  it("says nothing about the notifier when it simply is not running", async () => {
    // `null` is fetchRemote's "no notifier here" — the common case, not a fault.
    expect(await runStatusLine({ session: null, json: false }, deps({ fetchRemote: async () => null }))).toBe(
      "",
    );
  });

  it("aborts the fetches it gave up on, so nothing holds the process open", async () => {
    let seen: AbortSignal | undefined;
    await runStatusLine(
      { session: null, json: false, timeoutMs: 20 },
      deps({
        fetchStatus: (_port, _timeout, signal) => {
          seen = signal;
          return never();
        },
      }),
    );
    expect(seen?.aborted).toBe(true);
  });

  it("is `astir unreachable` when a fetcher throws, rather than nothing", async () => {
    const out = await runStatusLine(
      { session: null, json: false },
      deps({
        fetchHealth: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(out).toBe("astir unreachable");
  });

  it("uses --port and --notify-port, else ASTIR_PORT and the port after it", async () => {
    const seen: Record<string, number> = {};
    const record = {
      fetchHealth: async (p: number) => {
        seen.health = p;
        return health();
      },
      fetchStatus: async (p: number) => {
        seen.status = p;
        return ok(body());
      },
      fetchRemote: async (p: number) => {
        seen.remote = p;
        return null;
      },
    };
    await runStatusLine({ session: null, json: false, port: 1234, notifyPort: 999 }, deps(record));
    expect(seen).toEqual({ health: 1234, status: 1234, remote: 999 });

    vi.stubEnv("ASTIR_PORT", "47100");
    vi.stubEnv("ASTIR_NOTIFY_PORT", undefined);
    try {
      await runStatusLine({ session: null, json: false }, deps(record));
      expect(seen).toEqual({ health: 47_100, status: 47_100, remote: 47_101 });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("passes --session through to the silent check", async () => {
    const b = body({ silent: [{ sessionId: "me", name: null, cwd: "/x" }] });
    const out = await runStatusLine({ session: "me", json: false }, deps({ fetchStatus: async () => ok(b) }));
    expect(out).toBe(LINE_TEXT.silent);
  });

  it("probes focus only for --json, which is the only output that carries rows", async () => {
    const probe = vi.fn(() => true);
    const b = body({ sessions: [session()] });
    await runStatusLine(
      { session: null, json: false },
      deps({ fetchStatus: async () => ok(b), focusable: probe }),
    );
    expect(probe).not.toHaveBeenCalled();
    const out = await runStatusLine(
      { session: null, json: true },
      deps({ fetchStatus: async () => ok(b), focusable: probe }),
    );
    expect(probe).toHaveBeenCalledWith(100);
    expect((JSON.parse(out) as { rows: Array<{ focusable: boolean }> }).rows[0]?.focusable).toBe(true);
  });
});

/**
 * What a socket says, and when it says it, in `runStatusLine` itself — the
 * parts no fake that answers at once can see.
 */
describe("runStatusLine — off the socket", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("never rejects on a /healthz host that is not a string", async () => {
    // It did: `123.split` threw outside the fetch try, the command exited
    // non-zero with nothing on stdout, and a tmux segment drew that as calm.
    const out = await runStatusLine(
      { session: null, json: false },
      deps({
        fetchHealth: async () => ({ host: 123 }) as unknown as HealthBody,
        fetchStatus: async () => ({ ok: false, kind: "no-token", reason: "no token — run `astir install`" }),
      }),
    );
    expect(out).toBe("astir: no token — run `astir install`");
  });

  it("is `astir unreachable`, not a crash, when what answered cannot be decided on", async () => {
    const broken = { blockedCount: 0, sessions: 5 } as unknown as StatusBody;
    for (const json of [false, true]) {
      const out = await runStatusLine({ session: null, json }, deps({ fetchStatus: async () => ok(broken) }));
      expect(json ? (JSON.parse(out) as { line: string }).line : out).toBe(LINE_TEXT.unreachable);
    }
  });

  it("#79 — warns of a silent notifier only when the caller says one is expected", async () => {
    const silent = deps({ fetchRemote: async () => null });
    expect(await runStatusLine({ session: null, json: false, notifierExpected: true }, silent)).toBe(
      LINE_TEXT.notifierHung,
    );
    expect(await runStatusLine({ session: null, json: false }, silent)).toBe("");
  });

  it("spends 1.5s by default, and not a moment longer", async () => {
    expect(DEFAULT_LINE_BUDGET_MS).toBe(1_500);
    vi.useFakeTimers();
    let settled = false;
    const pending = runStatusLine({ session: null, json: false }, deps({ fetchStatus: never })).then(
      (out) => {
        settled = true;
        return out;
      },
    );
    await vi.advanceTimersByTimeAsync(1_499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(LINE_TEXT.unreachable);
  });

  it("leaves no timer behind when everything answers in time", async () => {
    // Without clearing it, every fast run held the process open for the
    // whole budget: 1.5s, measured, after a line that took 98ms.
    vi.useFakeTimers();
    expect(await runStatusLine({ session: null, json: false }, deps())).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives every fetch its own timeout LONGER than the budget, so the budget fires first", async () => {
    const seen: number[] = [];
    const record =
      <T>(value: T) =>
      async (_port: number, timeoutMs: number): Promise<T> => {
        seen.push(timeoutMs);
        return value;
      };
    const recorded = deps({
      fetchHealth: record(health()),
      fetchStatus: record(ok(body())),
      fetchRemote: record(null),
    });
    await runStatusLine({ session: null, json: false, timeoutMs: 20 }, recorded);
    expect(seen).toHaveLength(3);
    for (const t of seen) expect(t).toBeGreaterThan(20);
    seen.length = 0;
    await runStatusLine({ session: null, json: false }, recorded);
    for (const t of seen) expect(t).toBeGreaterThan(DEFAULT_LINE_BUDGET_MS);
  });

  it("sees a hung notifier as hung, where one timing out on its own would say null — calm", async () => {
    // A notifier that behaves as `fetchRemote` does: null on its own timeout.
    // If that timeout came first, a stale `ssh -R` would read as no notifier.
    const ownTimeout = (_port: number, timeoutMs: number, signal: AbortSignal): Promise<null> =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      });
    const out = await runStatusLine(
      { session: null, json: false, timeoutMs: 20 },
      deps({ fetchRemote: ownTimeout }),
    );
    expect(out).toBe(LINE_TEXT.notifierHung);
  });

  /**
   * The real fetchers, over a stubbed `fetch` that answers what it is told to
   * and otherwise hangs until its request is aborted — what a stale `ssh -R`
   * forward does. Records each request's signal by `port/path`.
   */
  function stubSockets(answers: Record<string, unknown>): Map<string, AbortSignal> {
    vi.stubEnv("ASTIR_TOKEN", "t".repeat(48));
    vi.stubEnv("ASTIR_NOTIFY_TOKEN", "t".repeat(48));
    const signals = new Map<string, AbortSignal>();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        const at = new URL(url);
        const key = `${at.port}${at.pathname}`;
        const signal = init.signal as AbortSignal;
        signals.set(key, signal);
        if (key in answers)
          return Promise.resolve(new Response(JSON.stringify(answers[key]), { status: 200 }));
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
    );
    return signals;
  }

  /** No fetchers: line.ts's own defaults run. */
  const real: Partial<LineDeps> = { now: () => NOW, selfHost: SELF, focusable: () => false };

  it("aborts every real request it gave up on, so no socket holds the process open", async () => {
    const signals = stubSockets({});
    const out = await runStatusLine(
      { session: null, json: false, port: 47_500, notifyPort: 47_501, timeoutMs: 30 },
      real,
    );
    expect(out).toBe(LINE_TEXT.unreachable);
    expect([...signals.keys()].sort()).toEqual(["47500/healthz", "47500/state", "47501/state"]);
    for (const [key, signal] of signals) expect(signal.aborted, key).toBe(true);
  });

  it("reads an older daemon's real answer — /state 2.1, no announcedAt, no delivery — as old, not calm", async () => {
    // What dcd33a6's daemon sends, through the real fetchers: the reviewers
    // measured "" here while two agents waited.
    const blocked = { ...agent({ state: "blocked", inStateMs: 10 * MIN }) } as Partial<StatusAgent>;
    delete blocked.announcedAt;
    stubSockets({
      "47500/healthz": { ok: true, role: "daemon", host: SELF, build: "old" },
      "47500/state": body({
        v: { major: 2, minor: 1 },
        blockedCount: 1,
        sessions: [session({ agents: [blocked as StatusAgent] })],
      }),
      "47501/state": { agents: [], sessions: [] },
    });
    const out = await runStatusLine(
      { session: null, json: false, port: 47_500, notifyPort: 47_501, timeoutMs: 250 },
      real,
    );
    expect(out).toBe(`${LINE_TEXT.oldDaemon} · 1 waiting on you · oldest 10m`);
  });

  it("keeps the daemon's answer past a hung notifier, and aborts the notifier's request", async () => {
    // Measured against real sockets: a notifier request the budget did not
    // abort kept the process alive to 3.06s — past astir-tui's 3s kill. The
    // budget is wider than the rest because the daemon's replies go through
    // `Response.json()`, which takes turns of the event loop, not microtasks.
    const signals = stubSockets({ "47500/healthz": health(), "47500/state": body() });
    const out = await runStatusLine(
      { session: null, json: false, port: 47_500, notifyPort: 47_501, timeoutMs: 250 },
      real,
    );
    expect(out).toBe(LINE_TEXT.notifierHung);
    expect(signals.get("47501/state")?.aborted).toBe(true);
  });
});

/**
 * PSH-11 — `focusable` is decided here, not by a host: true only where
 * `focusSession` could act. Fake process table, fake tmux; nothing is spawned.
 */
describe("focusProbe", () => {
  /** pid → parent, as `ps -e -o pid=,ppid=` reports it. */
  const TREE: Record<number, number> = { 100: 90, 90: 80, 80: 1, 200: 190, 190: 1 };
  const TABLE = Object.entries(TREE)
    .map(([pid, ppid]) => `  ${pid}   ${ppid}`)
    .join("\n");

  const fake = (over: Partial<ProbeDeps> & { panes?: string | null; table?: string | null } = {}) => {
    const calls: string[] = [];
    const signals: AbortSignal[] = [];
    const d: ProbeDeps = {
      platform: "linux",
      pidAlive: () => true,
      run: async (file, args, signal) => {
        calls.push(`${file} ${args.join(" ")}`);
        signals.push(signal);
        if (file === "tmux") return over.panes === undefined ? "80\n555\n" : over.panes;
        if (file === "ps") return over.table === undefined ? TABLE : over.table;
        return null;
      },
      ...(over.platform === undefined ? {} : { platform: over.platform }),
      ...(over.pidAlive === undefined ? {} : { pidAlive: over.pidAlive }),
      ...(over.run === undefined ? {} : { run: over.run }),
    };
    return { d, calls, signals };
  };
  const open = (): AbortSignal => new AbortController().signal;

  it("on Linux, is true for a pid that sits under a tmux pane", async () => {
    expect((await focusProbe(fake().d, open()))(100)).toBe(true);
  });

  it("on Linux, is false for a pid under no pane, or with no tmux at all", async () => {
    expect((await focusProbe(fake().d, open()))(200)).toBe(false);
    expect((await focusProbe(fake({ panes: null }).d, open()))(100)).toBe(false);
  });

  it("is false for a pid that is not running", async () => {
    expect((await focusProbe(fake({ pidAlive: () => false }).d, open()))(100)).toBe(false);
  });

  it("on macOS, a live pid is enough — the owning app is always there to raise — and nothing is spawned", async () => {
    const { d, calls } = fake({ platform: "darwin", panes: null });
    expect((await focusProbe(d, open()))(200)).toBe(true);
    expect(calls).toEqual([]);
  });

  it("on macOS, a pid that is not running is not focusable", async () => {
    const { d } = fake({ platform: "darwin", pidAlive: (pid) => pid !== 200 });
    const probe = await focusProbe(d, open());
    expect(probe(200)).toBe(false);
    expect(probe(100)).toBe(true);
  });

  it("reads the panes and the process table ONCE, however many sessions are asked about", async () => {
    // Run every five seconds by the TUI mod. Walking the ancestry with one `ps`
    // per hop per session would be dozens of spawns a tick.
    const { d, calls } = fake();
    const probe = await focusProbe(d, open());
    probe(100);
    probe(200);
    probe(100);
    expect(calls).toEqual(["tmux list-panes -a -F #{pane_pid}", "ps -e -o pid=,ppid="]);
  });

  it("does not read the process table when there is no pane to be under", async () => {
    const { d, calls } = fake({ panes: "" });
    expect((await focusProbe(d, open()))(100)).toBe(false);
    expect(calls).toEqual(["tmux list-panes -a -F #{pane_pid}"]);
  });

  it("is false — not a walk hop by hop — when the table cannot be read", async () => {
    // One `ps` per hop per session, on a five-second loop, is the unbounded
    // cost the probe exists to avoid. Unknown is not focusable.
    const { d, calls } = fake({ table: null });
    expect((await focusProbe(d, open()))(100)).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("hands every command the caller's signal, so the line's budget can kill it", async () => {
    const stop = new AbortController();
    const { d, signals } = fake();
    await focusProbe(d, stop.signal);
    expect(signals).toHaveLength(2);
    for (const s of signals) expect(s).toBe(stop.signal);
  });

  it("is false for everything, and spawns nothing, once the budget is spent", async () => {
    const stop = new AbortController();
    stop.abort();
    const { d, calls } = fake();
    expect((await focusProbe(d, stop.signal))(100)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("never rejects: a command that throws is one that found nothing", async () => {
    const { d } = fake({
      run: async () => {
        throw new Error("boom");
      },
    });
    expect((await focusProbe(d, open()))(100)).toBe(false);
  });
});

/**
 * #80 — `rows[].focusable` asks tmux. A wedged tmux once held `--json` for the
 * 5s of an `execFileSync` AFTER the budget, past astir-tui's 3s kill, so every
 * tick read `astir unreachable` and hid the real warning — for a field the mod
 * does not even read.
 */
describe("the focus probe runs inside the line's budget", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const waiting = body({
    blockedCount: 1,
    sessions: [session({ agents: [announced({ inStateMs: 2 * MIN })] })],
  });

  /** The real probe, over commands that answer as told; tmux hangs until killed unless `tmux` is given. */
  const probing = (answers: { tmux?: string } = {}) => {
    const calls: string[] = [];
    const killed: string[] = [];
    const probe: ProbeDeps = {
      platform: "linux",
      pidAlive: () => true,
      run: (file, _args, signal) => {
        calls.push(file);
        if (file === "ps") return Promise.resolve("  100   80\n  80   1\n");
        if (answers.tmux !== undefined) return Promise.resolve(answers.tmux);
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              killed.push(file);
              resolve(null);
            },
            { once: true },
          );
        });
      },
    };
    return { probe, calls, killed };
  };

  it("a wedged tmux costs `focusable`, not the line — and is killed when the budget ends", async () => {
    const { probe, killed } = probing();
    const out = await runStatusLine(
      { session: null, json: true, timeoutMs: 20 },
      fetchers({ fetchStatus: async () => ok(waiting), probe }),
    );
    const doc = JSON.parse(out) as { line: string; warnings: unknown[]; rows: Array<{ focusable: boolean }> };
    expect(doc.line).toBe("1 waiting on you · oldest 2m");
    expect(doc.warnings).toEqual([]);
    expect(doc.rows[0]?.focusable).toBe(false);
    expect(killed).toEqual(["tmux"]);
  });

  it("is over when the budget is — 1.5s by default, not a moment longer", async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = runStatusLine(
      { session: null, json: true },
      fetchers({ fetchStatus: async () => ok(waiting), probe: probing().probe }),
    ).then((out) => {
      settled = true;
      return out;
    });
    await vi.advanceTimersByTimeAsync(1_499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((JSON.parse(await pending) as { line: string }).line).toBe("1 waiting on you · oldest 2m");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a probe that ignores the budget altogether still costs only `focusable`", async () => {
    // Every other fake here answers when the signal aborts. The real one
    // need not: a command whose output something else still holds may never
    // answer, and the budget racing the probe is all that ends the line then.
    vi.useFakeTimers();
    const deaf: ProbeDeps = { platform: "linux", pidAlive: () => true, run: () => never() };
    let settled = false;
    const pending = runStatusLine(
      { session: null, json: true },
      fetchers({ fetchStatus: async () => ok(waiting), probe: deaf }),
    ).then((out) => {
      settled = true;
      return out;
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_LINE_BUDGET_MS);
    expect(settled).toBe(true);
    const doc = JSON.parse(await pending) as {
      line: string;
      warnings: unknown[];
      rows: Array<{ focusable: boolean }>;
    };
    expect(doc.line).toBe("1 waiting on you · oldest 2m");
    expect(doc.warnings).toEqual([]);
    expect(doc.rows[0]?.focusable).toBe(false);
  });

  it("starts with the fetches, so a notifier that spends the whole budget does not starve it", async () => {
    // The ordinary state of a box behind a dead `ssh -R`: the notifier hangs
    // to the end of the budget. A probe started after it would never run.
    const { probe } = probing({ tmux: "80\n" });
    const out = await runStatusLine(
      { session: null, json: true, timeoutMs: 20 },
      fetchers({ fetchStatus: async () => ok(waiting), fetchRemote: never, probe }),
    );
    const doc = JSON.parse(out) as { line: string; rows: Array<{ focusable: boolean }> };
    expect(doc.line).toBe(`${LINE_TEXT.notifierHung} · 1 waiting on you · oldest 2m`);
    expect(doc.rows[0]?.focusable).toBe(true);
  });

  it("asks tmux and ps at most once a run, however many sessions there are", async () => {
    const { probe, calls } = probing({ tmux: "80\n" });
    const many = body({
      sessions: [
        session({ sessionId: "a", cwd: "/p/a", pid: 100 }),
        session({ sessionId: "b", cwd: "/p/b", pid: 100 }),
        session({ sessionId: "c", cwd: "/p/c", pid: 100 }),
      ],
    });
    const out = await runStatusLine(
      { session: null, json: true },
      fetchers({ fetchStatus: async () => ok(many), probe }),
    );
    expect((JSON.parse(out) as { rows: Array<{ focusable: boolean }> }).rows.map((r) => r.focusable)).toEqual(
      [true, true, true],
    );
    expect(calls).toEqual(["tmux", "ps"]);
  });

  it("spawns nothing for the plain line, which carries no rows", async () => {
    const { probe, calls } = probing({ tmux: "80\n" });
    await runStatusLine(
      { session: null, json: false },
      fetchers({ fetchStatus: async () => ok(waiting), probe }),
    );
    expect(calls).toEqual([]);
  });
});
