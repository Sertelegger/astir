import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDiscovery } from "../src/discovery.js";

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
function seed(recs: object[]): string {
  dir = mkdtempSync(join(tmpdir(), "clide-agg-"));
  recs.forEach((r, i) => writeFileSync(join(dir, `s${i}.json`), JSON.stringify(r)));
  return dir;
}

describe("scanDiscovery", () => {
  it("returns live relays with port+token, skips ended/malformed", () => {
    const d = seed([
      { v: 1, sessionId: "a", provider: "claude", cwd: "/x", port: 1, token: "ta", state: "live" },
      { v: 1, sessionId: "b", provider: "codex", cwd: "/y", port: 2, token: "tb", state: "ended" },
      { v: 1, sessionId: "c", provider: "claude", cwd: "/z", port: 3, state: "live" }, // no token
    ]);
    const out = scanDiscovery(d);
    expect(out.map((r) => r.sessionId)).toEqual(["a"]);
    expect(out[0]).toMatchObject({ port: 1, token: "ta", provider: "claude" });
  });
  it("returns [] for a missing dir", () => { expect(scanDiscovery("/no/such")).toEqual([]); });
});
