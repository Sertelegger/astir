/**
 * DMN-06 — agent state survives a daemon restart, and nothing else does.
 *
 * The whole design turns on one asymmetry: the snapshot is a HINT, not truth.
 * Every test here is really asking the same question two ways — does a saved
 * session get adopted when the provider vouches for it, and is it dropped in
 * every case where it does not?
 */

import { describe, expect, it } from "vitest";
import { type AstirEvent, CONTRACT_VERSION, type Kind, type Provider } from "../src/contract/event.js";
import type { DiscoveredSession } from "../src/discovery/sessions.js";
import { Registry } from "../src/model/registry.js";
import {
  identityMatches,
  parseSnapshot,
  SNAPSHOT_VERSION,
  type SnapshotSession,
} from "../src/model/snapshot.js";

let seq = 0;
function ev(over: Partial<AstirEvent> = {}): AstirEvent {
  seq++;
  return {
    v: CONTRACT_VERSION,
    eventId: `e${seq}`,
    provider: "claude",
    sessionId: "s1",
    ts: 1_786_900_000 + seq,
    kind: "session_start" as Kind,
    agentId: "s1",
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

const disc = (over: Partial<DiscoveredSession> = {}): DiscoveredSession => ({
  sessionId: "s1",
  cwd: "/repo",
  pid: 4242,
  status: "busy",
  name: "repo-aa",
  startedAt: 1_000,
  ...over,
});

const saved = (over: Partial<SnapshotSession> = {}): SnapshotSession => ({
  sessionId: "s1",
  provider: "claude" as Provider,
  cwd: "/repo",
  name: "repo-aa",
  pid: 4242,
  startedAt: 1_000,
  agents: [
    {
      id: "s1",
      agentType: null,
      parentId: null,
      parentSource: null,
      state: "blocked",
      activeMs: 5_000,
      blockedMs: 840_000,
      turnMs: 900_000,
      stateSince: 100,
      lastActivityMs: 100,
      lastEventTs: 100,
      blockedReason: "permission",
      description: "refactor the login path",
      tool: null,
      toolPath: null,
      acknowledgedAt: null,
    },
  ],
  ...over,
});

const staged = (over: Partial<SnapshotSession> = {}) => ({
  v: SNAPSHOT_VERSION,
  writtenAt: 1_000,
  sessions: [saved(over)],
});

describe("identity — three fields, and each earns its place", () => {
  it("adopts when all three agree", () => {
    expect(identityMatches(saved(), disc())).toBe(true);
  });

  it("refuses a recycled pid", () => {
    // A pid alone is recycled, and on a busy box quickly.
    expect(identityMatches(saved({ pid: 4242 }), disc({ pid: 9999 }))).toBe(false);
  });

  it("refuses a session id that outlived its process", () => {
    // The id lives in a transcript path long after the session is gone, so a
    // new process reusing the pid must not inherit the old agent state.
    expect(identityMatches(saved({ startedAt: 1_000 }), disc({ startedAt: 7_000 }))).toBe(false);
  });

  it("treats a missing field as disagreement, never as agreement", () => {
    // Absence is not confirmation. Adopting on a null is how a snapshot ends up
    // resurrecting a session that ended while the daemon was down.
    expect(identityMatches(saved({ pid: null }), disc())).toBe(false);
    expect(identityMatches(saved(), disc({ pid: null }))).toBe(false);
    expect(identityMatches(saved({ startedAt: null }), disc())).toBe(false);
    expect(identityMatches(saved(), disc({ startedAt: null }))).toBe(false);
  });
});

describe("a staged session is not in the registry until discovery vouches", () => {
  it("holds it aside rather than loading it", () => {
    // Before confirmation it must be invisible: it is a claim about a process
    // that may have exited. Every surface already renders "not heard from"
    // honestly, so that is the state to be in.
    const r = new Registry({ nowMs: () => 1_000 });
    r.stageRestore(staged());
    expect(r.list()).toEqual([]);
    expect(r.pendingRestoreCount()).toBe(1);
  });

  it("adopts the agent state once the provider reports the same process", () => {
    const r = new Registry({ nowMs: () => 1_000 });
    r.stageRestore(staged());
    r.reconcile([disc()], { provider: "claude" });

    const s = r.list()[0];
    expect(s?.sessionId).toBe("s1");
    expect(s?.restored).toBe(true);
    // The thing this whole feature exists for.
    expect(s?.agents.get("s1")?.state).toBe("blocked");
    expect(s?.agents.get("s1")?.blockedMs).toBe(840_000);
    expect(r.pendingRestoreCount()).toBe(0);
  });

  it("does NOT adopt when the provider reports a different process", () => {
    const r = new Registry({ nowMs: () => 1_000 });
    r.stageRestore(staged());
    r.reconcile([disc({ pid: 9999 })], { provider: "claude" });

    // Listed as silent, not restored: same id, different process.
    expect(r.list()).toEqual([]);
    expect(r.silent().map((d) => d.sessionId)).toEqual(["s1"]);
  });

  it("discards a saved session a complete answer does not mention", () => {
    // The provider saying "not running" is the strongest evidence available,
    // and keeping it "just in case" is how astir reports work that stopped.
    const r = new Registry({ nowMs: () => 1_000 });
    r.stageRestore(staged());
    r.reconcile([], { provider: "claude" });
    expect(r.pendingRestoreCount()).toBe(0);
    expect(r.list()).toEqual([]);
  });

  it("keeps it staged when the answer was INCOMPLETE", () => {
    // A profile that failed to list is not the provider saying "not running".
    // Discarding on it would lose state to a transient error.
    const r = new Registry({ nowMs: () => 1_000 });
    r.stageRestore(staged());
    r.reconcile([], { provider: "claude", complete: false });
    expect(r.pendingRestoreCount()).toBe(1);
  });

  it("does not let one provider's answer discard another's saved sessions", () => {
    const r = new Registry({ nowMs: () => 1_000 });
    r.stageRestore(staged({ provider: "codex" }));
    r.reconcile([], { provider: "claude" });
    expect(r.pendingRestoreCount()).toBe(1);
  });

  it("stops calling it restored the moment an event arrives", () => {
    // The point at which the state stops being a memory and becomes an
    // observation — and where a restored `blocked` that has since resolved is
    // corrected.
    const r = new Registry({ nowMs: () => 1_000 });
    r.stageRestore(staged());
    r.reconcile([disc()], { provider: "claude" });
    expect(r.list()[0]?.restored).toBe(true);

    r.apply(ev({ kind: "pre_tool", tool: "Edit" }), "/repo");
    expect(r.list()[0]?.restored).toBe(false);
  });
});

describe("what is written", () => {
  it("carries agent state and NOT the map", () => {
    // DMN-06 permits agent state only. Heat rebuilds as work continues; the
    // active/blocked accounting does not.
    //
    // The discriminator has to be a file the MAP knows and the agent is no
    // longer on — `toolPath` is legitimately one path (what this agent is
    // touching now) and is agent state. An earlier version of this test
    // asserted no path appeared at all, which conflated the two and failed
    // against correct code.
    const r = new Registry({ nowMs: () => 1_000 });
    r.apply(ev({ kind: "pre_tool", tool: "Edit", paths: ["src/old.ts"] }), "/repo");
    r.apply(ev({ kind: "pre_tool", tool: "Edit", paths: ["src/current.ts"] }), "/repo");
    const snap = r.snapshot();
    const json = JSON.stringify(snap);

    expect(snap.sessions[0]?.agents.length).toBeGreaterThan(0);
    // The map holds both files; the snapshot must hold neither as map data.
    expect(r.list()[0]?.map.size).toBe(2);
    expect(json).not.toContain("src/old.ts");
    // And no per-file accumulation of any kind travelled with it.
    expect(json).not.toContain("totals");
    expect(json).not.toContain("heat");
  });

  it("does not write a session that has already ended", () => {
    // It lingers only so "what just finished" is answerable. Restoring one
    // would resurrect it.
    const r = new Registry({ nowMs: () => 1_000 });
    r.apply(ev({ kind: "session_start" }), "/repo");
    r.apply(ev({ kind: "session_end" }), "/repo");
    expect(r.snapshot().sessions.map((s) => s.sessionId)).toEqual([]);
  });
});

describe("reading a snapshot back", () => {
  it("round-trips through JSON", () => {
    const r = new Registry({ nowMs: () => 1_000 });
    r.apply(ev({ kind: "pre_tool", tool: "Edit" }), "/repo");
    const back = parseSnapshot(JSON.parse(JSON.stringify(r.snapshot())));
    expect(back?.sessions[0]?.agents[0]?.id).toBe("s1");
  });

  it("refuses an unknown MAJOR rather than reading it partially", () => {
    // VER-01. A half-understood snapshot restores a half-true world, which is
    // worse than restoring nothing.
    expect(parseSnapshot({ v: { major: 99, minor: 0 }, writtenAt: 1, sessions: [] })).toBeNull();
  });

  it("returns null for anything unreadable, rather than throwing", () => {
    // Every failure has the same right answer: start empty. A daemon that will
    // not boot because its recovery file is corrupt has turned a convenience
    // into an outage.
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot("nonsense")).toBeNull();
    expect(parseSnapshot({ v: { major: 1 } })).toBeNull();
    expect(parseSnapshot({ v: { major: 1, minor: 0 }, writtenAt: 1 })).toBeNull();
  });

  it("skips a malformed session instead of losing the whole file", () => {
    const back = parseSnapshot({
      v: { major: 1, minor: 0 },
      writtenAt: 1,
      sessions: [{ sessionId: 5 }, { sessionId: "ok", provider: "claude", cwd: "/r", agents: [] }],
    });
    expect(back?.sessions.map((s) => s.sessionId)).toEqual(["ok"]);
  });
});
