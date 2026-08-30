import { describe, expect, it } from "vitest";
import {
  classifyTool,
  type NormalizeDeps,
  normalizeClaudeHook,
  resolveParent,
  type SidecarMeta,
  toRepoRelative,
} from "../src/adapters/claude/normalize.js";

const REPO = "/repo";
/** Identity realpath so these tests never touch the filesystem. */
const identity = (p: string): string => p;

function deps(over: Partial<NormalizeDeps> = {}): NormalizeDeps {
  return {
    now: () => 1_786_900_000,
    newId: () => "fixed-id",
    realpath: identity,
    readSidecar: () => null,
    ...over,
  };
}

describe("CAP-03 tool→op", () => {
  it("maps the documented tool families", () => {
    expect(classifyTool("Edit", { file_path: "/repo/a.ts" }).op).toBe("edit");
    expect(classifyTool("Write", { file_path: "/repo/a.ts" }).op).toBe("write");
    expect(classifyTool("Read", { file_path: "/repo/a.ts" }).op).toBe("read");
    expect(classifyTool("Grep", { path: "/repo/src" }).op).toBe("read");
    expect(classifyTool("Bash", { command: "ls" }).op).toBe("other");
  });

  it("keeps paths on the `other` branch — v1 discarded them, losing MCP tool paths", () => {
    const c = classifyTool("mcp__filesystem__read_file", { path: "/repo/x.ts" });
    expect(c.op).toBe("other");
    expect(c.rawPaths).toEqual(["/repo/x.ts"]);
  });
});

describe("CAP-04 path normalization", () => {
  it("relativizes absolute in-repo paths to posix form", () => {
    expect(toRepoRelative(REPO, "/repo/src/a.ts", identity)).toBe("src/a.ts");
  });

  it("resolves an already-relative path against cwd", () => {
    expect(toRepoRelative(REPO, "src/a.ts", identity)).toBe("src/a.ts");
  });

  it("returns null for out-of-repo paths rather than emitting `../..`", () => {
    expect(toRepoRelative(REPO, "/elsewhere/x.ts", identity)).toBeNull();
    expect(toRepoRelative(REPO, "../x.ts", identity)).toBeNull();
  });

  it("follows symlinks, so a linked repo root does not drop every path", () => {
    // The v1 bug: cwd is a symlink, tool reports the realpath, and every path
    // relativized to `../..` and was silently discarded — zero heat, no error.
    const realpath = (p: string): string => p.replace("/link", "/real");
    expect(toRepoRelative("/link/repo", "/real/repo/src/a.ts", realpath)).toBe("src/a.ts");
  });
});

describe("CAP-05 parentage", () => {
  it("treats an absent parentAgentId WITH spawnDepth as an exact 'parent is main'", () => {
    const sidecar: SidecarMeta = { agentType: "general-purpose", toolUseId: "toolu_1", spawnDepth: 1 };
    expect(resolveParent("s", "a", () => sidecar)).toEqual({
      parentAgentId: null,
      parentSource: "sidecar",
    });
  });

  it("uses parentAgentId for a nested agent", () => {
    const sidecar: SidecarMeta = { toolUseId: "toolu_2", spawnDepth: 2, parentAgentId: "parent-1" };
    expect(resolveParent("s", "a", () => sidecar)).toEqual({
      parentAgentId: "parent-1",
      parentSource: "sidecar",
    });
  });

  it("marks it inferred when no sidecar exists, rather than guessing", () => {
    expect(resolveParent("s", "a", () => null).parentSource).toBe("inferred");
  });
});

describe("normalizeClaudeHook", () => {
  it("maps a real SubagentStart shape, carrying agent identity", () => {
    const { event } = normalizeClaudeHook(
      {
        session_id: "s1",
        cwd: REPO,
        hook_event_name: "SubagentStart",
        agent_id: "a1",
        agent_type: "general-purpose",
      },
      deps(),
    );
    expect(event?.kind).toBe("subagent_start");
    expect(event?.agentId).toBe("a1");
    expect(event?.agentType).toBe("general-purpose");
  });

  it("gives the main agent the session id", () => {
    const { event } = normalizeClaudeHook(
      { session_id: "s1", cwd: REPO, hook_event_name: "SessionStart" },
      deps(),
    );
    expect(event?.agentId).toBe("s1");
  });

  it("counts dropped paths instead of discarding them silently (OBS-01)", () => {
    const { event, droppedPaths } = normalizeClaudeHook(
      {
        session_id: "s1",
        cwd: REPO,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "/elsewhere/x.ts" },
      },
      deps(),
    );
    expect(event?.paths).toEqual([]);
    expect(droppedPaths).toBe(1);
  });

  it("classifies the blocking notification kinds", () => {
    const { event } = normalizeClaudeHook(
      {
        session_id: "s1",
        cwd: REPO,
        hook_event_name: "Notification",
        notification_type: "permission_prompt",
      },
      deps(),
    );
    expect(event?.notificationKind).toBe("permission_prompt");
  });

  it("derives ok from the event kind — tool_failed is a distinct hook, not ok:false", () => {
    const failed = normalizeClaudeHook(
      { session_id: "s1", cwd: REPO, hook_event_name: "PostToolUseFailure", tool_name: "Edit" },
      deps(),
    ).event;
    expect(failed?.kind).toBe("tool_failed");
    expect(failed?.ok).toBe(false);
  });

  it("returns null for a deliberately unmapped hook", () => {
    expect(
      normalizeClaudeHook({ session_id: "s1", cwd: REPO, hook_event_name: "PreCompact" }, deps()).event,
    ).toBeNull();
  });
});

describe("the subagent's brief, from its sidecar", () => {
  /** Exactly the shape observed in all 383 sidecars on this machine. */
  const real: SidecarMeta = {
    agentType: "general-purpose",
    description: "Extract chunk 5 social preview svg",
    toolUseId: "toolu_01F8VeoWJGxApFgxsHwCR9v1",
    spawnDepth: 1,
  };

  const hook = (over: Record<string, unknown> = {}) => ({
    hook_event_name: "SubagentStart",
    session_id: "s1",
    cwd: "/repo",
    agent_id: "sub-1",
    agent_type: "general-purpose",
    ...over,
  });

  const deps = (sidecar: SidecarMeta | null) => ({
    now: () => 1_786_900_000,
    newId: () => "e1",
    realpath: (p: string) => p,
    readSidecar: () => sidecar,
  });

  it("carries the description onto the event", () => {
    // It was already being read for parentage and thrown away — the one thing
    // that distinguishes eight concurrent `general-purpose` agents.
    const { event } = normalizeClaudeHook(hook(), deps(real));
    expect(event?.description).toBe("Extract chunk 5 social preview svg");
  });

  it("reads the sidecar ONCE for both parentage and the brief", () => {
    let reads = 0;
    normalizeClaudeHook(hook(), {
      ...deps(real),
      readSidecar: () => {
        reads++;
        return real;
      },
    });
    // It is the only disk touch on the hook path, and hooks are synchronous.
    expect(reads).toBe(1);
  });

  it("is null when there is no sidecar, rather than a guess", () => {
    expect(normalizeClaudeHook(hook(), deps(null)).event?.description).toBeNull();
  });

  it("is null for events that are not a spawn", () => {
    // Only `subagent_start` carries it; a sidecar read on every tool call would
    // put a stat() in the hot path for a field that cannot have changed.
    const { event } = normalizeClaudeHook(
      hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "a.ts" } }),
      deps(real),
    );
    expect(event?.kind).toBe("pre_tool");
    expect(event?.description).toBeNull();
  });

  it("never carries a tool argument body, only the tool name", () => {
    // NG1. The command is in the payload; it must not survive normalisation.
    const { event } = normalizeClaudeHook(
      hook({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /tmp/secret", description: "clean up" },
      }),
      deps(null),
    );
    expect(event?.tool).toBe("Bash");
    expect(JSON.stringify(event)).not.toContain("rm -rf");
    expect(event?.description, "the TOOL's description is not the AGENT's brief").toBeNull();
  });
});
