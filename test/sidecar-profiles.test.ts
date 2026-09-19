/**
 * CAP-05 reads sidecars from every profile, not just `~/.claude`.
 *
 * `defaultReadSidecar` hardcoded the default profile, which is the same
 * blindness the multi-profile discovery fix removed from session listing — left
 * behind here, and failing in the direction that hides itself: a miss is
 * indistinguishable from "this agent has no sidecar", so parentage degrades to
 * `inferred` and astir reports a guess where it could have read the answer.
 *
 * Measured on the machine this was found on: `$CLAUDE_CONFIG_DIR` was
 * `~/.claude-nv` holding 812 sidecars, not one of them reachable, and every
 * agent on `/state` carried `parentSource: "inferred"` with no parent.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultReadSidecar } from "../src/daemon/server.js";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A config profile, optionally holding one agent's sidecar. */
function profile(opts: { session?: string; agent?: string; meta?: unknown } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "astir-cfg-"));
  made.push(dir);
  if (opts.session !== undefined && opts.agent !== undefined) {
    const sub = join(dir, "projects", "-repo-x", opts.session, "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, `agent-${opts.agent}.meta.json`), JSON.stringify(opts.meta ?? {}));
  }
  return dir;
}

describe("every profile is searched", () => {
  it("finds a sidecar in a NON-default profile", () => {
    // THE bug. The daemon runs under `$CLAUDE_CONFIG_DIR`, and its sessions'
    // sidecars live there — nowhere near `~/.claude`.
    const other = profile({ session: "s1", agent: "a1", meta: { spawnDepth: 1 } });
    expect(defaultReadSidecar("s1", "a1", [other])).toEqual({ spawnDepth: 1 });
  });

  it("keeps looking past a profile that does not have it", () => {
    const empty = profile();
    const holder = profile({ session: "s1", agent: "a1", meta: { parentAgentId: "p" } });
    expect(defaultReadSidecar("s1", "a1", [empty, holder])).toEqual({ parentAgentId: "p" });
  });

  it("keeps looking past a profile with no projects directory at all", () => {
    const bare = mkdtempSync(join(tmpdir(), "astir-bare-"));
    made.push(bare);
    const holder = profile({ session: "s1", agent: "a1", meta: { spawnDepth: 2 } });
    expect(defaultReadSidecar("s1", "a1", [bare, holder])).toEqual({ spawnDepth: 2 });
  });

  it("prefers the earlier profile when two hold the same agent", () => {
    // `candidateConfigDirs` puts `$CLAUDE_CONFIG_DIR` first, so "earlier" is the
    // profile this daemon was actually started under — the same precedence
    // session discovery uses, and it must not disagree with it.
    const first = profile({ session: "s1", agent: "a1", meta: { spawnDepth: 1 } });
    const second = profile({ session: "s1", agent: "a1", meta: { spawnDepth: 99 } });
    expect(defaultReadSidecar("s1", "a1", [first, second])).toEqual({ spawnDepth: 1 });
  });

  it("returns null when no profile has it, rather than throwing", () => {
    expect(defaultReadSidecar("nobody", "nothing", [profile()])).toBeNull();
  });

  it("survives unreadable JSON without hiding the profiles behind it", () => {
    // A corrupt sidecar in one profile must not make the rest unreachable.
    const bad = mkdtempSync(join(tmpdir(), "astir-bad-"));
    made.push(bad);
    const sub = join(bad, "projects", "-repo-x", "s1", "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-a1.meta.json"), "{ not json");
    const holder = profile({ session: "s1", agent: "a1", meta: { spawnDepth: 3 } });

    expect(defaultReadSidecar("s1", "a1", [bad, holder])).toEqual({ spawnDepth: 3 });
  });
});
