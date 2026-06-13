import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRelay, postEvent } from "../src/relay-io.js";

let home: string;
afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); });

function withDiscovery(rec: object): string {
  home = mkdtempSync(join(tmpdir(), "clide-home-"));
  mkdirSync(join(home, ".clide", "sessions"), { recursive: true });
  writeFileSync(join(home, ".clide", "sessions", "s1.json"), JSON.stringify(rec));
  return home;
}

describe("relay-io", () => {
  it("resolveRelay reads the discovery file for a session", () => {
    const h = withDiscovery({ v: 1, sessionId: "s1", port: 51000, token: "tok", state: "live" });
    expect(resolveRelay("s1", h)).toMatchObject({ port: 51000, token: "tok" });
    expect(resolveRelay("nope", h)).toBeNull();
  });
  it("postEvent POSTs to /events with the bearer token", async () => {
    let url = ""; let auth = ""; let body = "";
    const fake = (async (u: string, init: any) => { url = u; auth = init.headers.Authorization; body = init.body; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    await postEvent({ port: 51000, token: "tok" }, { v: 1, eventId: "e", provider: "codex", sessionId: "s1", ts: 1, kind: "stop", agentId: "s1", paths: [], op: null }, fake);
    expect(url).toBe("http://127.0.0.1:51000/events");
    expect(auth).toBe("Bearer tok");
    expect(JSON.parse(body).kind).toBe("stop");
  });
});
