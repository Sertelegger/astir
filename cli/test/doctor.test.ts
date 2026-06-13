import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findStale, cleanStale } from "../src/doctor.js";

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
function seed(recs: Record<string, object>): string {
  dir = mkdtempSync(join(tmpdir(), "clide-doc-"));
  for (const [name, rec] of Object.entries(recs)) writeFileSync(join(dir, name), JSON.stringify(rec));
  return dir;
}

describe("doctor findStale (REQ-018/094)", () => {
  it("returns discovery files whose relay is NOT live (injected probe)", () => {
    const d = seed({
      "live.json": { sessionId: "live", port: 1 },
      "dead.json": { sessionId: "dead", port: 2 },
      "junk.txt": {} as object, // ignored (not .json)
    });
    const isLive = (rec: { sessionId?: string }) => rec.sessionId === "live";
    const stale = findStale(d, isLive);
    expect(stale.map((p) => p.endsWith("dead.json"))).toEqual([true]);
  });
  it("cleanStale removes the stale files", () => {
    const d = seed({ "dead.json": { sessionId: "dead", port: 2 } });
    cleanStale(d, () => false);
    expect(existsSync(join(d, "dead.json"))).toBe(false);
  });
  it("missing dir → [] / no throw", () => {
    expect(findStale("/no/such", () => true)).toEqual([]);
  });
});
