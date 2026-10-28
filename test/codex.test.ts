/**
 * #24 — Codex as a second provider.
 *
 * Everything here reads `fixtures/codex/capture.json`, sanitised from real
 * codex-cli 0.154.0 and 0.165.0 sessions. The adapter was written against it
 * rather than against the published schemas, and the places they would have
 * disagreed are asserted on the fixture itself, so a re-capture that changes
 * them fails here instead of silently agreeing with a stale comment. The one
 * payload no capture has produced yet is in `fixtures/codex/declared.json`,
 * which says so.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { classifyCodexTool, normalizeCodexHook, patchTargets } from "../src/adapters/codex/normalize.js";
import { validateEvent } from "../src/contract/event.js";
import { Daemon } from "../src/daemon/server.js";
import { Registry } from "../src/model/registry.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
type Step = { afterMs: number; payload: Record<string, unknown> };
const capture = JSON.parse(readFileSync(join(root, "test", "fixtures", "codex", "capture.json"), "utf8")) as {
  _capture: Record<string, unknown>;
  events: Record<string, Record<string, unknown>>;
  /** First capture: a request an automatic reviewer answered. */
  permissionSequence: Step[];
  /** Second capture: Esc at the approval prompt. */
  escSequence: Step[];
  /** Second capture: the root spawns a subagent, which runs and stops. */
  spawnSequence: Step[];
  /** Second capture: three Bash calls at once, and their results. */
  parallelSequence: Step[];
};
const fixture = (name: string): Record<string, unknown> => {
  const p = capture.events[name];
  if (p === undefined) throw new Error(`no fixture ${name}`);
  return p;
};
const sequence = capture.permissionSequence.map((s) => s.payload);
const esc = capture.escSequence.map((s) => s.payload);
const spawned = capture.spawnSequence.map((s) => s.payload);
const parallel = capture.parallelSequence.map((s) => s.payload);
const names = (steps: Array<Record<string, unknown>>) => steps.map((p) => p.hook_event_name);
const declared = JSON.parse(
  readFileSync(join(root, "test", "fixtures", "codex", "declared.json"), "utf8"),
) as {
  _declared: Record<string, unknown>;
  events: Record<string, Record<string, unknown>>;
};
const decl = (name: string): Record<string, unknown> => {
  const p = declared.events[name];
  if (p === undefined) throw new Error(`no declared fixture ${name}`);
  return p;
};

const deps = {
  readSidecar: () => null,
  newId: () => "e1",
  realpath: (p: string) => p,
  now: () => 1_787_000_000,
};
const normalize = (payload: unknown) => normalizeCodexHook(payload, deps);

describe("the fixture is a capture, not a construction", () => {
  it("records where it came from", () => {
    expect(capture._capture.provider).toBe("codex");
    expect(capture._capture.cliVersion).toMatch(/^codex-cli \d+\.\d+\.\d+/);
    expect(capture._capture.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Two captures, each with its own version and date; the top level names
    // the latest.
    const captures = capture._capture.captures as Array<{
      cliVersion: string;
      capturedAt: string;
      gave?: string[];
    }>;
    expect(captures.length).toBeGreaterThanOrEqual(2);
    for (const c of captures) {
      expect(c.cliVersion).toMatch(/^codex-cli \d+\.\d+\.\d+$/);
      expect(c.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(captures.at(-1)?.cliVersion).toBe(capture._capture.cliVersion);
    expect(captures.at(-1)?.capturedAt).toBe(capture._capture.capturedAt);
    // What the latest one gave is really in the fixture.
    for (const where of captures.at(-1)?.gave ?? []) {
      const [top, key] = where.split(/\.(.+)/) as [string, string | undefined];
      const node = (capture as unknown as Record<string, Record<string, unknown>>)[top];
      expect(key === undefined ? node : node?.[key], where).toBeDefined();
    }
  });

  it("shows a PermissionRequest carries no tool_use_id", () => {
    // Why the block cannot be matched to the call it is about, and why it is
    // cleared by the agent's NEXT event of any kind rather than by a matching
    // PostToolUse — the first captured request never got one.
    for (const request of [sequence[1] ?? {}, esc[1] ?? {}]) {
      expect(request.hook_event_name).toBe("PermissionRequest");
      expect(request).not.toHaveProperty("tool_use_id");
      expect(request).toHaveProperty("tool_name");
    }
  });

  it("shows Esc at an approval prompt sends Interrupt, and nothing after it", () => {
    // No PostToolUse for the requested call and no Stop: the Interrupt is the
    // only word that the request is over.
    expect(names(esc)).toEqual(["PreToolUse", "PermissionRequest", "Interrupt"]);
    const [pre, request, interrupt] = esc;
    expect(request?.tool_name).toBe(pre?.tool_name);
    expect(interrupt?.session_id).toBe(request?.session_id);
    expect(interrupt?.turn_id).toBe(request?.turn_id);
    expect(interrupt).not.toHaveProperty("agent_id");
  });

  it("shows a subagent shares the root's session, runs its own turn, and is named by agent_id", () => {
    // Why a subagent's events must be told apart by agent_id: session_id
    // cannot do it.
    const start = fixture("SubagentStart");
    const stop = fixture("SubagentStop");
    const spawn = fixture("PreToolUse:spawn");
    expect(start.session_id).toBe(spawn.session_id);
    expect(start.turn_id).not.toBe(spawn.turn_id);
    expect(typeof start.agent_id).toBe("string");
    expect(start.agent_id).not.toBe(start.session_id);
    expect(stop.agent_id).toBe(start.agent_id);
    expect(stop.turn_id).toBe(start.turn_id);
    // No verdict: a subagent cannot be reported as failed.
    expect(stop).toHaveProperty("last_assistant_message");
    expect(stop).toHaveProperty("agent_transcript_path");
    for (const key of Object.keys(stop)) expect(key).not.toMatch(/success|status|error|^ok$|result|exit/);
  });

  it("shows the spawn call returns before the subagent starts", () => {
    // So the root is not mid-tool while its subagent runs.
    expect(names(spawned)).toEqual([
      "PreToolUse",
      "PostToolUse",
      "SubagentStart",
      "SubagentStop",
      "PreToolUse",
    ]);
    const [pre, post, start] = capture.spawnSequence;
    expect(pre?.payload).toEqual(fixture("PreToolUse:spawn"));
    expect(post?.payload.tool_use_id).toBe(pre?.payload.tool_use_id);
    expect(post?.afterMs ?? 0).toBeLessThan(start?.afterMs ?? 0);
    // A different id format from every other tool's `exec-<uuid>`.
    expect(pre?.payload.tool_use_id).toMatch(/^call_[0-9a-f]{32}$/);
  });

  it("shows tool calls run in parallel, and finish in a different order", () => {
    const pres = parallel.slice(0, 3);
    const posts = parallel.slice(3);
    expect(names(pres)).toEqual(["PreToolUse", "PreToolUse", "PreToolUse"]);
    expect(names(posts)).toEqual(["PostToolUse", "PostToolUse", "PostToolUse"]);
    const started = capture.parallelSequence.slice(0, 3).map((s) => s.afterMs);
    expect(Math.max(...started) - Math.min(...started)).toBeLessThan(100);
    expect(Math.min(...capture.parallelSequence.slice(3).map((s) => s.afterMs))).toBeGreaterThan(
      Math.max(...started),
    );
    // Only the tool_use_id pairs a result with its call.
    const ids = (ps: typeof parallel) => ps.map((p) => p.tool_use_id);
    expect(new Set(ids(posts))).toEqual(new Set(ids(pres)));
    expect(ids(posts)).not.toEqual(ids(pres));
  });

  it("shows no captured tool event carries agent_id — the captured subagent ran no tool", () => {
    // Which is why a subagent's own tool call is still only declared.
    const all = [...Object.values(capture.events), ...sequence, ...esc, ...spawned, ...parallel].filter(
      (p) => p.hook_event_name === "PreToolUse" || p.hook_event_name === "PostToolUse",
    );
    expect(all.length).toBeGreaterThan(0);
    for (const p of all) expect(p).not.toHaveProperty("agent_id");
  });

  it("shows the captured permission was answered with nobody looking, in ~12s", () => {
    // The evidence for the Codex dwell. An automatic reviewer answered it and
    // the agent moved on to a different tool — at 5s astir would have
    // interrupted someone about a decision that was never theirs.
    const [pre, request, next] = capture.permissionSequence;
    expect(pre?.payload.hook_event_name).toBe("PreToolUse");
    expect(request?.payload.hook_event_name).toBe("PermissionRequest");
    expect(next?.payload.hook_event_name).toBe("PreToolUse");
    expect(next?.payload.tool_name).not.toBe(request?.payload.tool_name);
    const answeredAfter = (next?.afterMs ?? 0) - (request?.afterMs ?? 0);
    expect(answeredAfter).toBeGreaterThan(5_000);
    expect(answeredAfter).toBeLessThan(30_000);
  });

  it("shows apply_patch names files by ABSOLUTE path", () => {
    const command = (fixture("PreToolUse:apply_patch").tool_input as { command: string }).command;
    expect(command).toMatch(/^\*\*\* Update File: \//m);
  });
});

describe("every captured event normalizes to a valid contract event, or to nothing on purpose", () => {
  const mapped: Record<string, string> = {
    SessionStart: "session_start",
    "PreToolUse:Bash": "pre_tool",
    "PostToolUse:Bash": "post_tool",
    "PreToolUse:apply_patch": "pre_tool",
    "PostToolUse:apply_patch": "post_tool",
    "PreToolUse:spawn": "pre_tool",
    Stop: "stop",
    Interrupt: "stop",
    SessionEnd: "session_end",
  };

  for (const [name, kind] of Object.entries(mapped)) {
    it(`${name} → ${kind}`, () => {
      const r = normalize(fixture(name));
      expect(r.event?.kind).toBe(kind);
      expect(r.event?.provider).toBe("codex");
      // The root agent's id IS the session id, as for Claude. None of these
      // carries an agent_id to say otherwise; only the subagent events do.
      expect(r.event?.agentId).toBe(fixture(name).session_id);
      expect(validateEvent(r.event).ok).toBe(true);
    });
  }

  it("SubagentStart and SubagentStop → the subagent's own events, not the root's", () => {
    for (const [name, kind] of [
      ["SubagentStart", "subagent_start"],
      ["SubagentStop", "subagent_stop"],
    ] as const) {
      const r = normalize(fixture(name));
      expect(r.event?.kind, name).toBe(kind);
      expect(r.event?.agentId, name).toBe(fixture(name).agent_id);
      expect(r.event?.sessionId, name).toBe(fixture(name).session_id);
      expect(validateEvent(r.event).ok, name).toBe(true);
    }
  });

  it("PermissionRequest → a human-blocking notification", () => {
    const r = normalize(sequence[1]);
    expect(r.event?.kind).toBe("notification");
    expect(r.event?.notificationKind).toBe("permission_prompt");
    expect(validateEvent(r.event).ok).toBe(true);
  });

  for (const name of ["UserPromptSubmit", "PreCompact", "PostCompact"]) {
    it(`${name} is deliberately unmapped, but still attributed`, () => {
      const r = normalize(fixture(name));
      expect(r.event).toBeNull();
      // So a gap is still counted against the right session.
      expect(r.claimedSessionId).toBe(fixture(name).session_id);
      expect(r.cwd).toBe("/home/user/repo");
    });
  }

  it("refuses what is not a payload at all", () => {
    expect(normalize(null).event).toBeNull();
    expect(normalize("x").event).toBeNull();
    expect(normalize({ hook_event_name: "Stop" }).event).toBeNull();
    expect(normalize({ session_id: "s" }).event).toBeNull();
  });
});

describe("Interrupt and the subagent events, as captured", () => {
  it("Interrupt ends the turn", () => {
    const r = normalize(fixture("Interrupt"));
    expect(r.event?.kind).toBe("stop");
    expect(r.event?.agentId).toBe(fixture("Interrupt").session_id);
    expect(validateEvent(r.event).ok).toBe(true);
  });

  it("SubagentStart names the subagent, attached to the root and marked inferred", () => {
    const r = normalize(fixture("SubagentStart"));
    expect(r.event).toMatchObject({
      kind: "subagent_start",
      agentId: fixture("SubagentStart").agent_id,
      agentType: "default",
      parentAgentId: null,
      parentSource: "inferred",
    });
    expect(validateEvent(r.event).ok).toBe(true);
  });

  it("SubagentStop ends the subagent without inventing a verdict", () => {
    const r = normalize(fixture("SubagentStop"));
    // Parentage is claimed once, by SubagentStart. Every other event makes no
    // claim, so a lost SubagentStart leaves the agent unparented rather than
    // guessed at.
    expect(r.event).toMatchObject({
      kind: "subagent_stop",
      ok: null,
      agentType: "default",
      parentSource: null,
    });
    expect(JSON.stringify(r)).not.toContain("<redacted: the subagent's reply>");
  });

  it("the spawn call is the root's own tool call, with no paths in its brief", () => {
    const r = normalize(fixture("PreToolUse:spawn"));
    expect(r.event).toMatchObject({
      kind: "pre_tool",
      tool: "collaborationspawn_agent",
      op: "other",
      paths: [],
      agentId: fixture("PreToolUse:spawn").session_id,
    });
  });
});

describe("a subagent's own tool call — declared, not yet captured", () => {
  it("says so, and says where the shape came from", () => {
    // A declared fixture that passes for a captured one is how §14 erodes.
    expect(declared._declared.note).toMatch(/^NOT CAPTURED/);
    expect(declared._declared.declaredBy).toMatch(/rust-v\d+\.\d+\.\d+/);
    for (const name of Object.keys(declared.events)) {
      expect((declared._declared.sources as Record<string, string>)[name], name).toBeDefined();
    }
  });

  it("holds only what no capture has produced", () => {
    // Anything captured belongs in capture.json, and must leave this file.
    expect(Object.keys(declared.events)).toEqual(["PreToolUse:subagent"]);
    for (const name of Object.keys(declared.events)) expect(capture.events[name], name).toBeUndefined();
  });

  it("is the captured subagent's, so the two files describe one session", () => {
    const start = fixture("SubagentStart");
    const pre = decl("PreToolUse:subagent");
    expect(pre.session_id).toBe(start.session_id);
    expect(pre.agent_id).toBe(start.agent_id);
    expect(pre.agent_type).toBe(start.agent_type);
  });

  it("a subagent's tool call is the subagent's, not the root's", () => {
    const r = normalize(decl("PreToolUse:subagent"));
    expect(r.event?.agentId).toBe(decl("PreToolUse:subagent").agent_id);
    expect(r.event?.agentId).not.toBe(r.event?.sessionId);
    // Only SubagentStart claims parentage.
    expect(r.event?.parentSource).toBeNull();
  });
});

describe("SEC-01 — the prompt and the model's reply never become part of an event", () => {
  it("drops UserPromptSubmit and Stop content even when the relay did not strip it", () => {
    // The fixture keeps both fields, with markers in place of the text, so this
    // proves the adapter's own line of defence independent of the relay's.
    for (const payload of [fixture("UserPromptSubmit"), fixture("Stop")]) {
      const out = JSON.stringify(normalize(payload));
      expect(out).not.toContain("<redacted: the user's prompt>");
      expect(out).not.toContain("<redacted: the model's reply>");
    }
  });

  it("never carries a tool's output or command text, for any captured event", () => {
    const all = [
      ...Object.values(capture.events),
      ...sequence,
      ...esc,
      ...spawned,
      ...parallel,
      ...Object.values(declared.events),
    ];
    for (const payload of all) {
      const out = JSON.stringify(normalize(payload).event);
      expect(out).not.toContain("<redacted");
    }
  });
});

describe("CAP-03/04 — where Codex's work lands on the map", () => {
  it("maps an apply_patch to the file it edits, repo-relative", () => {
    const r = normalize(fixture("PreToolUse:apply_patch"));
    expect(r.event?.op).toBe("edit");
    expect(r.event?.paths).toEqual(["crates/core/src/stream.rs"]);
    expect(r.event?.tool).toBe("apply_patch");
  });

  it("gives Bash no paths — Codex reads through its shell, and a command line is not a path list", () => {
    const r = normalize(fixture("PreToolUse:Bash"));
    expect(r.event?.op).toBe("other");
    expect(r.event?.paths).toEqual([]);
  });

  it("keeps an MCP tool's path argument, as CAP-03 requires of unknown tools", () => {
    const r = normalize(sequence[0]);
    expect(r.event?.op).toBe("other");
    expect(r.event?.paths).toEqual(["docs"]);
  });

  it("counts a patched file outside the repo as dropped rather than losing it silently", () => {
    const payload = {
      ...fixture("PreToolUse:apply_patch"),
      tool_input: { command: "*** Begin Patch\n*** Update File: /elsewhere/x.rs\n*** End Patch\n" },
    };
    const r = normalize(payload);
    expect(r.event?.paths).toEqual([]);
    expect(r.droppedPaths).toBe(1);
  });

  it("marks a finished tool ok, because Codex has no failure event to say otherwise", () => {
    expect(normalize(fixture("PostToolUse:Bash")).event?.ok).toBe(true);
    expect(normalize(fixture("PreToolUse:Bash")).event?.ok).toBeNull();
  });
});

describe("patchTargets — the apply_patch grammar", () => {
  const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch", ""].join("\n");

  it("an added file is a write", () => {
    expect(patchTargets(patch("*** Add File: a.ts", "+x"))).toEqual({ op: "write", rawPaths: ["a.ts"] });
  });

  it("a deleted file leaves no path, because heat on it could never cool", () => {
    expect(patchTargets(patch("*** Delete File: a.ts"))).toEqual({ op: "other", rawPaths: [] });
  });

  it("a moved file is recorded where it ends up", () => {
    const p = patch("*** Update File: old.ts", "*** Move to: new.ts", "@@", "-a", "+b");
    expect(patchTargets(p)).toEqual({ op: "edit", rawPaths: ["new.ts"] });
  });

  it("a move after an added file renames nothing — it belongs to an Update File", () => {
    const p = patch("*** Update File: a.ts", "*** Add File: b.ts", "*** Move to: c.ts");
    expect(patchTargets(p).rawPaths).toEqual(["a.ts", "b.ts"]);
  });

  it("a move with no file above it moves nothing", () => {
    expect(patchTargets(patch("*** Move to: new.ts"))).toEqual({ op: "other", rawPaths: [] });
  });

  it("a patch that edits and creates is an edit with both files", () => {
    const p = patch("*** Update File: a.ts", "@@", "-a", "+b", "*** Add File: b.ts", "+c");
    expect(patchTargets(p)).toEqual({ op: "edit", rawPaths: ["a.ts", "b.ts"] });
  });

  it("reads CRLF patches", () => {
    expect(patchTargets("*** Begin Patch\r\n*** Update File: a.ts\r\n*** End Patch\r\n").rawPaths).toEqual([
      "a.ts",
    ]);
  });

  it("ignores a hunk line that merely looks like a directive", () => {
    // Body lines carry a +, - or space prefix, so they can never match.
    expect(patchTargets(patch("*** Update File: a.ts", "+*** Add File: evil.ts")).rawPaths).toEqual(["a.ts"]);
  });

  it("is not fooled by an apply_patch without a command string", () => {
    expect(classifyCodexTool("apply_patch", { input: 3 })).toEqual({ op: "other", rawPaths: [] });
    expect(classifyCodexTool("apply_patch", null)).toEqual({ op: "other", rawPaths: [] });
  });
});

describe("a Codex permission blocks, and the agent's next move unblocks it", () => {
  it("replays the captured sequence through the registry", () => {
    let t = 0;
    let n = 0;
    const registry = new Registry({ nowMs: () => t });
    const apply = (payload: unknown) => {
      // Distinct ids: the registry drops a repeated eventId as a redelivery.
      const r = normalizeCodexHook(payload, { ...deps, newId: () => `e${++n}` });
      if (r.event === null) throw new Error("expected an event");
      expect(registry.apply(r.event, r.cwd).applied).toBe(true);
    };

    apply(sequence[0]);
    t += 63;
    apply(sequence[1]);
    const blocked = registry.blockedAgents();
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.provider).toBe("codex");
    expect(blocked[0]?.reason).toBe("permission_prompt");

    // No PostToolUse ever came for the requested call. Its absence must not
    // leave the agent blocked forever: the next PreToolUse is the answer.
    t += 11_894;
    apply(sequence[2]);
    expect(registry.blockedAgents()).toEqual([]);
  });
});

describe("what unblocks a Codex agent, and what must not", () => {
  /** The real Registry, on a clock the test moves to each step's `afterMs`. */
  function replay() {
    let n = 0;
    let t = 0;
    const registry = new Registry({ nowMs: () => t });
    const apply = (payload: unknown) => {
      const r = normalizeCodexHook(payload, { ...deps, newId: () => `e${++n}` });
      if (r.event === null) throw new Error("expected an event");
      expect(registry.apply(r.event, r.cwd).applied).toBe(true);
    };
    const step = (s: Step | undefined) => {
      if (s === undefined) throw new Error("missing step");
      t = s.afterMs;
      apply(s.payload);
    };
    const agent = (sessionId: unknown, agentId: unknown = sessionId) =>
      registry.get(String(sessionId))?.agents.get(String(agentId));
    return { registry, apply, step, agent };
  }

  it("replays the captured Esc: blocked at the PermissionRequest, unblocked by the Interrupt alone", () => {
    // No Stop and no PostToolUse follow an interrupted approval, so without
    // Interrupt the agent would stay blocked and keep reminding you.
    const { registry, step, agent } = replay();
    const [pre, request, interrupt] = capture.escSequence;
    const session = request?.payload.session_id;

    step(pre);
    step(request);
    expect(registry.blockedAgents()).toMatchObject([
      { sessionId: session, agentId: session, provider: "codex", reason: "permission_prompt" },
    ]);

    step(interrupt);
    expect(registry.blockedAgents()).toEqual([]);
    expect(agent(session)?.state).toBe("waiting");
    // The whole wait was the human's, from the request to the Esc.
    expect(agent(session)?.blockedMs).toBe((interrupt?.afterMs ?? 0) - (request?.afterMs ?? 0));
    // And that took the Interrupt only: the capture has nothing after it.
    expect(capture.escSequence).toHaveLength(3);
  });

  it("replays the captured spawn: the subagent runs and ends under the session, and the root is untouched by it", () => {
    const { registry, step, agent } = replay();
    const [pre, post, start, stop, next] = capture.spawnSequence;
    const session = pre?.payload.session_id;
    const sub = start?.payload.agent_id;

    step(pre);
    step(post);
    const rootBefore = { ...agent(session) };
    expect(rootBefore.state).toBe("thinking");

    step(start);
    expect(agent(session, sub)).toMatchObject({
      agentType: "default",
      parentId: null,
      parentSource: "inferred",
      state: "thinking",
    });
    step(stop);
    expect(agent(session, sub)?.state).toBe("done");
    expect(registry.get(String(session))?.agents.size).toBe(2);

    // Nothing the subagent did moved the root: not its state, not when that
    // state began, not its clock.
    const root = agent(session);
    for (const key of [
      "state",
      "stateSince",
      "lastEventTs",
      "lastActivityMs",
      "activeMs",
      "turnMs",
      "tool",
    ] as const) {
      expect(root?.[key], key).toEqual(rootBefore[key]);
    }

    // The root's own next call is still the root's.
    step(next);
    expect(agent(session)?.state).toBe("tool-running");
    expect(agent(session, sub)?.state).toBe("done");

    // And the root never became anyone's child. Asserted outright, not against
    // `rootBefore`: an event that marked every agent inferred would already
    // have marked the root by then, because the registry's update path does
    // not exclude it — and the stale value would reach /state and the stream.
    expect(agent(session)).toMatchObject({ parentId: null, parentSource: null });
  });

  it("a subagent's activity does not clear the root agent's block", () => {
    // Every agent in a Codex tree shares the root's session_id. Treating them
    // all as the root let any subagent event answer the root's prompt. The
    // subagent's tool call is the declared one; the rest is captured, from one
    // session.
    const { registry, apply } = replay();
    apply(esc[0]);
    apply(esc[1]);
    apply(fixture("SubagentStart"));
    apply(decl("PreToolUse:subagent"));
    apply(fixture("SubagentStop"));
    const blocked = registry.blockedAgents();
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.agentId).toBe(esc[1]?.session_id);
  });

  it("KNOWN LIMITATION: a parallel sibling's PostToolUse clears a pending PermissionRequest", () => {
    // Codex runs tool calls in parallel, and a PermissionRequest names no
    // tool_use_id, so astir cannot tell the requested call's result from a
    // sibling's: any PostToolUse ends the block, and the human who has not
    // answered yet is no longer counted as waited on. No capture has a request
    // pending while siblings run, so this splices the captured request into
    // the captured parallel calls (same session). The turn_id is moved to
    // theirs only for realism: neither the adapter nor the relay reads it.
    // If this starts failing, the limitation is fixed: rename the test and
    // remove the CHANGELOG entry.
    const { registry, apply, agent } = replay();
    const [a, b, c, siblingDone] = parallel;
    const session = a?.session_id;
    apply(a);
    apply(b);
    apply(c);
    // Say the request is for `a`, the first call. Nothing in it says so.
    apply({ ...esc[1], turn_id: a?.turn_id });
    expect(registry.blockedAgents()).toHaveLength(1);

    // A sibling finishes first, as `b` did in the capture. Nobody has
    // answered `a`, but this is indistinguishable from `a` finishing after an
    // approval.
    expect(siblingDone?.hook_event_name).toBe("PostToolUse");
    expect(siblingDone?.tool_use_id).toBe(b?.tool_use_id);
    expect(siblingDone?.tool_use_id).not.toBe(a?.tool_use_id);
    apply(siblingDone);
    expect(registry.blockedAgents()).toEqual([]);
    expect(agent(session)?.state).toBe("thinking");
  });
});

describe("the daemon speaks Codex", () => {
  const TOKEN = "t".repeat(48);
  const open: Daemon[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((d) => d.close()));
  });

  async function daemon() {
    const registry = new Registry({ nowMs: () => 1_000 });
    const d = new Daemon({ token: TOKEN, registry });
    open.push(d);
    const port = await d.listen(0);
    const post = async (provider: string, payload: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}/hook/${provider}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    return { registry, post, port };
  }

  it("ingests a Codex hook at /hook/codex", async () => {
    const { registry, post } = await daemon();
    const res = await post("codex", fixture("SessionStart"));

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    const session = registry.list().find((s) => s.sessionId === fixture("SessionStart").session_id);
    expect(session?.provider).toBe("codex");
  });

  it("takes the agent's pid from the relay's header, and nothing that is not one", async () => {
    // Codex's only liveness signal (discovery/pids.ts). A header, because it is
    // the relay's measurement rather than anything the provider said.
    const { registry, port } = await daemon();
    const send = (sessionId: string, pid: string) =>
      fetch(`http://127.0.0.1:${port}/hook/codex`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "x-astir-agent-pid": pid,
        },
        body: JSON.stringify({ ...fixture("SessionStart"), session_id: sessionId }),
      });
    await send("good", "4242");
    await send("hex", "0x10");
    await send("init", "1");
    await send("neg", "-5");
    expect(registry.get("good")?.pid).toBe(4242);
    expect(registry.get("hex")?.pid).toBeNull();
    expect(registry.get("init")?.pid).toBeNull();
    expect(registry.get("neg")?.pid).toBeNull();
  });

  it("routes only to a provider astir speaks, not to whatever an object inherits", async () => {
    // `NORMALIZERS[segment]` on a plain object finds `Object` itself at
    // `/hook/constructor` and calls it as a normalizer.
    const { port } = await daemon();
    for (const segment of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const res = await fetch(`http://127.0.0.1:${port}/hook/${segment}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(fixture("SessionStart")),
      });
      expect(res.status, segment).toBe(404);
    }
  });

  it("hands watchPaths to Claude only — Codex has no FileChanged to read them", async () => {
    // A real directory, so the scan has something to find; with a cwd that
    // does not exist both providers would get nothing and this would prove
    // nothing. The Claude half is the control.
    const repo = mkdtempSync(join(tmpdir(), "astir-codex-watch-"));
    mkdirSync(join(repo, "src"));
    try {
      const { post } = await daemon();
      const claude = await post("claude", {
        session_id: "claude-1",
        hook_event_name: "SessionStart",
        cwd: repo,
        source: "startup",
      });
      const codex = await post("codex", { ...fixture("SessionStart"), cwd: repo });

      expect(claude.body).toHaveProperty("hookSpecificOutput");
      expect(codex.body.applied).toBe(true);
      expect(codex.body).not.toHaveProperty("hookSpecificOutput");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("the Codex plugin is wired to what exists", () => {
  const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

  it("points Codex at its own hooks file, not Claude's http hooks", () => {
    // Without the pointer Codex reads hooks/hooks.json, whose hooks are all
    // `type: "http"` — a type Codex does not run.
    const manifest = read(".codex-plugin/plugin.json");
    expect(manifest.hooks).toBe("./hooks/codex-hooks.json");
    expect(manifest.name).toBe(read(".claude-plugin/plugin.json").name);
  });

  it("registers exactly the events the adapter maps", () => {
    // Registering UserPromptSubmit would send the prompt to the relay for
    // nothing; registering an unmapped event costs a process per occurrence.
    const hooks = read("hooks/codex-hooks.json").hooks as Record<string, unknown>;
    expect(Object.keys(hooks).sort()).toEqual(
      [
        "Interrupt",
        "PermissionRequest",
        "PostToolUse",
        "PreToolUse",
        "SessionEnd",
        "SessionStart",
        "Stop",
        "SubagentStart",
        "SubagentStop",
      ].sort(),
    );
    for (const name of Object.keys(hooks)) {
      expect(normalize({ ...fixture("SessionStart"), hook_event_name: name }).event).not.toBeNull();
    }
  });

  it("can never exit 2 — which would deny the permission, block the tool, or replace its result", () => {
    // If the script is missing — an upgrade deletes the old plugin folder
    // mid-turn — `sh` exits 2 with an error on stderr, and Codex reads exit 2
    // plus stderr as a decision. Every command is guarded so it cannot.
    const hooks = read("hooks/codex-hooks.json").hooks as Record<
      string,
      Array<{ hooks: Array<{ command: string; commandWindows?: string; timeout: number; async?: boolean }> }>
    >;
    for (const [event, entries] of Object.entries(hooks)) {
      for (const h of entries.flatMap((e) => e.hooks)) {
        expect(h.command, event).toMatch(/2>\/dev\/null \|\| true$|>\/dev\/null 2>&1 \|\| true$/);
        // Windows replaces `command` with this; without it every hook fails.
        expect(h.commandWindows, event).toBeDefined();
      }
    }
    // Codex clamps these two to 3s and warns at every session start otherwise.
    for (const event of ["SessionEnd", "Interrupt"]) {
      for (const h of hooks[event]?.flatMap((e) => e.hooks) ?? []) expect(h.timeout).toBeLessThanOrEqual(3);
    }
    // Starting the daemon must not hold up the session coming up.
    const ensure = hooks.SessionStart?.flatMap((e) => e.hooks).find((h) =>
      h.command.includes("ensure-daemon"),
    );
    expect(ensure?.async).toBe(true);
  });

  it.skipIf(process.platform === "win32")("exits 0 and says nothing when the script is not there", () => {
    const hooks = read("hooks/codex-hooks.json").hooks as Record<
      string,
      Array<{ hooks: Array<{ command: string }> }>
    >;
    const command = hooks.PermissionRequest?.[0]?.hooks[0]?.command ?? "";
    const empty = mkdtempSync(join(tmpdir(), "astir-missing-plugin-"));
    try {
      const r = spawnSync("sh", ["-c", command], {
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: empty },
        input: "{}",
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("runs only command hooks, with scripts that are in the repo", () => {
    const hooks = read("hooks/codex-hooks.json").hooks as Record<
      string,
      Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }>
    >;
    for (const entries of Object.values(hooks)) {
      for (const h of entries.flatMap((e) => e.hooks)) {
        expect(h.type).toBe("command");
        expect(h.timeout).toBeGreaterThan(0);
        const script = /\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+?)"/.exec(h.command)?.[1];
        expect(script, h.command).toBeDefined();
        expect(() => readFileSync(join(root, script ?? ""), "utf8")).not.toThrow();
      }
    }
  });
});
