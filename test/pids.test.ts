/**
 * Liveness for Codex, which cannot list its sessions.
 *
 * Without it, three things the product promises fail for Codex alone: a
 * session that dies without SessionEnd is never reaped (and a blocked one is
 * reminded about for a day), a block does not survive a daemon restart
 * (DMN-06), and focus has no pid to act on (PSH-11).
 */

import { describe, expect, it } from "vitest";
import { type AstirEvent, CONTRACT_VERSION, type Kind } from "../src/contract/event.js";
import {
  createPidLister,
  createProcessTable,
  type ProcessInfo,
  parseProcessTable,
} from "../src/discovery/pids.js";
import { Registry } from "../src/model/registry.js";

const STARTED = Date.parse("Wed Sep 30 22:00:00 2026");

let seq = 0;
function ev(kind: Kind, over: Partial<AstirEvent> = {}): AstirEvent {
  seq++;
  return {
    v: CONTRACT_VERSION,
    eventId: `p${seq}`,
    provider: "codex",
    sessionId: "c1",
    ts: 1_786_900_000 + seq,
    kind,
    agentId: "c1",
    agentType: null,
    parentAgentId: null,
    parentSource: null,
    tool: null,
    description: null,
    paths: [],
    op: null,
    ok: null,
    notificationKind: null,
    ...over,
  };
}

const table = (entries: Array<[number, ProcessInfo]> | null) => async () =>
  entries === null ? null : new Map(entries);

describe("parseProcessTable", () => {
  it("reads pid, tty and lstart", () => {
    const t = parseProcessTable(
      [
        "  4242 ttys003  Wed Sep 30 22:00:00 2026",
        "    77 ??       Thu Oct  1 09:05:03 2026",
        "junk",
        "",
      ].join("\n"),
    );
    expect(t.get(4242)).toEqual({ startedAt: STARTED, tty: "ttys003" });
    expect(t.get(77)?.tty).toBe("??");
    expect(t.size).toBe(2);
  });
});

describe("createPidLister", () => {
  it("vouches for a session whose process is still the one that reported", async () => {
    const lister = createPidLister(
      () => [{ sessionId: "c1", cwd: "/r", pid: 4242, startedAt: STARTED }],
      table([[4242, { startedAt: STARTED, tty: "ttys003" }]]),
    );
    expect(await lister()).toEqual({
      complete: true,
      sessions: [
        {
          sessionId: "c1",
          cwd: "/r",
          pid: 4242,
          status: null,
          name: null,
          startedAt: STARTED,
          attended: true,
        },
      ],
    });
  });

  it("drops a session whose process is gone", async () => {
    const lister = createPidLister(
      () => [{ sessionId: "c1", cwd: "/r", pid: 4242, startedAt: STARTED }],
      table([]),
    );
    expect((await lister())?.sessions).toEqual([]);
  });

  it("does not mistake a recycled pid for the session", async () => {
    // Same pid, different process: it started later.
    const lister = createPidLister(
      () => [{ sessionId: "c1", cwd: "/r", pid: 4242, startedAt: STARTED }],
      table([[4242, { startedAt: STARTED + 60_000, tty: "??" }]]),
    );
    expect((await lister())?.sessions).toEqual([]);
  });

  it("records the start time at the first look", async () => {
    const lister = createPidLister(
      () => [{ sessionId: "c1", cwd: "/r", pid: 4242, startedAt: null }],
      table([[4242, { startedAt: STARTED, tty: "??" }]]),
    );
    expect((await lister())?.sessions[0]).toMatchObject({ startedAt: STARTED, attended: false });
  });

  it("answers 'could not tell' rather than 'nothing runs' when the table cannot be read", async () => {
    // A null here makes reconcile do nothing. An empty list would prune every
    // Codex session astir knows about.
    const lister = createPidLister(
      () => [{ sessionId: "c1", cwd: "/r", pid: 4242, startedAt: null }],
      table(null),
    );
    expect(await lister()).toBeNull();
  });

  it("does not read the process table when there is nothing to check", async () => {
    let reads = 0;
    const lister = createPidLister(
      () => [],
      async () => {
        reads++;
        return new Map();
      },
    );
    expect(await lister()).toEqual({ complete: true, sessions: [] });
    expect(reads).toBe(0);
  });
});

describe.skipIf(process.platform === "win32")("createProcessTable", () => {
  it("finds this process, with the time it started", async () => {
    const t = await createProcessTable()();
    const me = t?.get(process.pid);
    expect(me).toBeDefined();
    // `ps` reports to the second.
    expect(Math.abs((me?.startedAt ?? 0) - (Date.now() - process.uptime() * 1000))).toBeLessThan(2_000);
  });
});

describe("a Codex session's liveness, end to end through the registry", () => {
  function codex() {
    let t = 0;
    const registry = new Registry({ nowMs: () => t });
    let procs: Array<[number, ProcessInfo]> = [[4242, { startedAt: STARTED, tty: "ttys003" }]];
    const lister = createPidLister(
      () => registry.pidCandidates("codex"),
      async () => new Map(procs),
    );
    const tick = async () => {
      const found = await lister();
      registry.reconcile(found?.sessions ?? null, { complete: found?.complete ?? false, provider: "codex" });
      registry.tick();
    };
    return {
      registry,
      tick,
      advance: (ms: number) => {
        t += ms;
      },
      kill: () => {
        procs = [];
      },
      recycle: () => {
        procs = [[4242, { startedAt: STARTED + 1_000, tty: "??" }]];
      },
    };
  }

  it("reaps a blocked Codex session whose process died without SessionEnd", async () => {
    // The reviewer's case: a terminal closed at an approval prompt. Before
    // this, it stayed blocked — and reminded about — for a day.
    const h = codex();
    h.registry.apply(ev("notification", { notificationKind: "permission_prompt" }), "/repo");
    h.registry.observePid("c1", 4242);
    await h.tick();
    expect(h.registry.get("c1")?.pid).toBe(4242);
    expect(h.registry.blockedAgents()).toHaveLength(1);

    h.kill();
    await h.tick();
    expect(h.registry.get("c1")).toBeUndefined();
    expect(h.registry.blockedAgents()).toEqual([]);
  });

  it("keeps a blocked Codex session for as long as its process lives", async () => {
    // A blocked agent sends nothing. Silence alone must never reap it.
    const h = codex();
    h.registry.apply(ev("notification", { notificationKind: "permission_prompt" }), "/repo");
    h.registry.observePid("c1", 4242);
    for (let i = 0; i < 12; i++) {
      h.advance(60 * 60_000);
      await h.tick();
    }
    expect(h.registry.blockedAgents()).toHaveLength(1);
  });

  it("reaps it when its pid is recycled by something else", async () => {
    const h = codex();
    h.registry.apply(ev("session_start"), "/repo");
    h.registry.observePid("c1", 4242);
    await h.tick();
    h.recycle();
    await h.tick();
    expect(h.registry.get("c1")).toBeUndefined();
  });

  it("measures a resumed session's new process afresh", async () => {
    // `codex resume` keeps the session id and starts a new process. Comparing
    // it against the old one's start time would reap a live session.
    const h = codex();
    h.registry.apply(ev("session_start"), "/repo");
    h.registry.observePid("c1", 4242);
    await h.tick();
    h.registry.observePid("c1", 5151);
    expect(h.registry.get("c1")?.startedAt).toBeNull();
  });

  it("DMN-06 — restores a blocked Codex agent once its process is confirmed alive", async () => {
    const before = codex();
    before.registry.apply(ev("notification", { notificationKind: "permission_prompt" }), "/repo");
    before.registry.observePid("c1", 4242);
    await before.tick();
    const snap = before.registry.snapshot();

    const after = codex();
    after.registry.stageRestore(snap);
    await after.tick();
    const blocked = after.registry.blockedAgents();
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ provider: "codex", restored: true });
    expect(after.registry.pendingRestoreCount()).toBe(0);
  });

  it("DMN-06 — does not restore one whose process is gone", async () => {
    const before = codex();
    before.registry.apply(ev("notification", { notificationKind: "permission_prompt" }), "/repo");
    before.registry.observePid("c1", 4242);
    await before.tick();
    const snap = before.registry.snapshot();

    const after = codex();
    after.kill();
    after.registry.stageRestore(snap);
    await after.tick();
    expect(after.registry.blockedAgents()).toEqual([]);
    expect(after.registry.pendingRestoreCount()).toBe(0);
  });

  it("does not check an ended session, which lingers on its own schedule", async () => {
    const h = codex();
    h.registry.apply(ev("session_start"), "/repo");
    h.registry.observePid("c1", 4242);
    h.registry.apply(ev("session_end"), "/repo");
    expect(h.registry.pidCandidates("codex")).toEqual([]);
  });

  it("DMN-06 — a saved session with a pid but no start time is neither restored nor reported silent", async () => {
    // Without a start time a restore cannot be told from a recycled pid, and
    // a failed identity check would list it as a session whose hooks are not
    // wired — a fault that does not exist.
    const before = codex();
    before.registry.apply(ev("notification", { notificationKind: "permission_prompt" }), "/repo");
    before.registry.observePid("c1", 4242);
    const snap = before.registry.snapshot(); // no tick: startedAt never measured

    const after = codex();
    after.registry.stageRestore(snap);
    await after.tick();
    expect(after.registry.blockedAgents()).toEqual([]);
    expect(after.registry.silent()).toEqual([]);
  });

  it("leaves Claude's sessions alone", async () => {
    const h = codex();
    h.registry.apply(ev("session_start", { provider: "claude", sessionId: "k1", agentId: "k1" }), "/repo");
    h.kill();
    await h.tick();
    expect(h.registry.get("k1")).toBeDefined();
  });

  it("does not overwrite what Claude's own discovery said about a Claude session", async () => {
    // A Claude session has a pid too. Checking it here would replace its
    // status and name with this lister's nulls on every tick.
    const h = codex();
    h.registry.apply(ev("session_start", { provider: "claude", sessionId: "k1", agentId: "k1" }), "/repo");
    h.registry.reconcile(
      [{ sessionId: "k1", cwd: "/repo", pid: 4242, status: "busy", name: "astir-be", startedAt: STARTED }],
      { provider: "claude" },
    );
    await h.tick();
    expect(h.registry.get("k1")).toMatchObject({ status: "busy", name: "astir-be" });
  });
});
