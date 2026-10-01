/**
 * #24 — Codex as a second provider.
 *
 * Everything here reads `fixtures/codex/capture.json`, sanitised from real
 * codex-cli 0.154.0 sessions. The adapter was written against it rather than
 * against the published schemas, and the places they would have disagreed are
 * asserted on the fixture itself, so a re-capture that changes them fails here
 * instead of silently agreeing with a stale comment.
 */

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
const capture = JSON.parse(readFileSync(join(root, "test", "fixtures", "codex", "capture.json"), "utf8")) as {
  _capture: Record<string, unknown>;
  events: Record<string, Record<string, unknown>>;
  permissionSequence: Array<{ afterMs: number; payload: Record<string, unknown> }>;
};
const fixture = (name: string): Record<string, unknown> => {
  const p = capture.events[name];
  if (p === undefined) throw new Error(`no fixture ${name}`);
  return p;
};
const sequence = capture.permissionSequence.map((s) => s.payload);

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
  });

  it("shows a PermissionRequest carries no tool_use_id", () => {
    // Why the block cannot be matched to the call it is about, and why it is
    // cleared by the agent's NEXT event of any kind rather than by a matching
    // PostToolUse — the captured request never got one.
    const request = sequence[1] ?? {};
    expect(request.hook_event_name).toBe("PermissionRequest");
    expect(request).not.toHaveProperty("tool_use_id");
    expect(request).toHaveProperty("tool_name");
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
    Stop: "stop",
    SessionEnd: "session_end",
  };

  for (const [name, kind] of Object.entries(mapped)) {
    it(`${name} → ${kind}`, () => {
      const r = normalize(fixture(name));
      expect(r.event?.kind).toBe(kind);
      expect(r.event?.provider).toBe("codex");
      // The root agent's id IS the session id, as for Claude. No capture has
      // ever carried an agent_id to say otherwise.
      expect(r.event?.agentId).toBe(fixture(name).session_id);
      expect(validateEvent(r.event).ok).toBe(true);
    });
  }

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

  it("an event Codex declares but nobody has captured stays unmapped", () => {
    // §14: SubagentStart, SubagentStop and Interrupt have no fixture, so
    // mapping them would mean inventing their payloads.
    for (const hook of ["SubagentStart", "SubagentStop", "Interrupt"]) {
      expect(normalize({ ...fixture("SessionStart"), hook_event_name: hook }).event).toBeNull();
    }
  });

  it("refuses what is not a payload at all", () => {
    expect(normalize(null).event).toBeNull();
    expect(normalize("x").event).toBeNull();
    expect(normalize({ hook_event_name: "Stop" }).event).toBeNull();
    expect(normalize({ session_id: "s" }).event).toBeNull();
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
    const all = [...Object.values(capture.events), ...sequence];
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
      ["PermissionRequest", "PostToolUse", "PreToolUse", "SessionEnd", "SessionStart", "Stop"].sort(),
    );
    for (const name of Object.keys(hooks)) {
      expect(normalize({ ...fixture("SessionStart"), hook_event_name: name }).event).not.toBeNull();
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
