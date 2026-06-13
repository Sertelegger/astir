import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceRelay } from "../src/resolve.js";

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
function sessions(recs: object[]): string {
  dir = mkdtempSync(join(tmpdir(), "clide-sess-"));
  recs.forEach((r, i) => writeFileSync(join(dir, `s${i}.json`), JSON.stringify(r)));
  return dir;
}

describe("resolveWorkspaceRelay", () => {
  it("returns the most-recent live relay matching the workspace cwd (REQ-080)", () => {
    const d = sessions([
      { v: 1, sessionId: "old", provider: "claude", cwd: "/repo", port: 1, token: "a", state: "live", startedAt: 100 },
      { v: 1, sessionId: "new", provider: "codex",  cwd: "/repo", port: 2, token: "b", state: "live", startedAt: 200 },
      { v: 1, sessionId: "other", provider: "claude", cwd: "/elsewhere", port: 3, token: "c", state: "live", startedAt: 300 },
    ]);
    const r = resolveWorkspaceRelay("/repo", d)!;
    expect(r.sessionId).toBe("new");
    expect(r.provider).toBe("codex");
    expect(r.port).toBe(2);
    expect(r.startedAt).toBe(200);
  });
  it("ignores non-live and non-matching; returns null when none match", () => {
    const d = sessions([
      { v: 1, sessionId: "ended", provider: "claude", cwd: "/repo", port: 1, token: "a", state: "ended", startedAt: 100 },
      { v: 1, sessionId: "x", provider: "claude", cwd: "/other", port: 2, token: "b", state: "live", startedAt: 200 },
    ]);
    expect(resolveWorkspaceRelay("/repo", d)).toBeNull();
  });
  it("returns null when the sessions dir is missing", () => {
    expect(resolveWorkspaceRelay("/repo", "/no/such/dir")).toBeNull();
  });
});
