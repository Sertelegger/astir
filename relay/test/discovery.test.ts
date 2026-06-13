import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDiscovery, readDiscovery, type Discovery } from "../src/security/discovery.js";

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const rec: Discovery = {
  v: 1, provider: "claude", sessionId: "s1", pid: process.pid,
  cwd: "/repo", port: 51000, token: "deadbeef", startedAt: 1781200000, state: "live",
};

describe("discovery", () => {
  it("writes with 0600 perms and round-trips", () => {
    dir = mkdtempSync(join(tmpdir(), "clide-"));
    const path = join(dir, "s1.json");
    writeDiscovery(path, rec);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readDiscovery(path)).toEqual(rec);
  });
  it("returns null for a missing file", () => {
    dir = mkdtempSync(join(tmpdir(), "clide-"));
    expect(readDiscovery(join(dir, "nope.json"))).toBeNull();
  });
});
