import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionState } from "../src/model/session-state.js";
import { systemClock } from "../src/model/clock.js";
import { Counters } from "../src/log/logger.js";
import { RelayServer } from "../src/relay/server.js";

let server: RelayServer | undefined;
const tmpDirs: string[] = [];
afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(staticDir?: string) {
  const state = new SessionState({ sessionId: "s1", provider: "claude", cwd: process.cwd(), clock: systemClock });
  server = new RelayServer({ state, token: "tok", counters: new Counters(), flushMs: 10, ...(staticDir ? { staticDir } : {}) });
  const port = await server.listen();
  return { port, state };
}

/** A temp web/dist-alike plus a secret file OUTSIDE it (traversal target). */
function makeWebDir() {
  const base = mkdtempSync(join(tmpdir(), "clide-static-"));
  tmpDirs.push(base);
  const root = join(base, "dist");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<h1>clide</h1>");
  writeFileSync(join(root, "assets", "app.js"), "export const x = 1;\n");
  writeFileSync(join(base, "secret.txt"), "TOP-SECRET");
  return root;
}
const auth = { headers: { Authorization: "Bearer tok", "content-type": "application/json" } };

describe("RelayServer", () => {
  it("/healthz is open and returns sessionId+state", async () => {
    const { port } = await start();
    const r = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(r.status).toBe(200);
    expect((await r.json()).sessionId).toBe("s1");
  });
  it("rejects missing/wrong token on /state with 401", async () => {
    const { port } = await start();
    expect((await fetch(`http://127.0.0.1:${port}/state`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/state`, { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
  });
  it("accepts a valid event on /events and reflects it in /state", async () => {
    const { port } = await start();
    const e = { v: 1, eventId: "1", provider: "claude", sessionId: "s1", ts: 1, kind: "post_tool", agentId: "s1", tool: "Edit", paths: ["src/a.ts"], op: "edit", ok: true };
    const post = await fetch(`http://127.0.0.1:${port}/events`, { method: "POST", ...auth, body: JSON.stringify(e) });
    expect(post.status).toBe(200);
    const snap = await (await fetch(`http://127.0.0.1:${port}/state`, auth)).json();
    expect(snap.agents.find((a: any) => a.id === "s1")).toBeTruthy();
  });
  it("emitSpec is callable (broadcasts a spec frame to SSE clients)", async () => {
    const { port } = await start();
    server!.emitSpec("docs/x.md", "created"); // no SSE client connected → no throw
    expect(port).toBeGreaterThan(0);
  });
  it("/reasoning requires the token and updates the Now line", async () => {
    const { port } = await start();
    await fetch(`http://127.0.0.1:${port}/events`, { method: "POST", ...auth, body: JSON.stringify({ v: 1, eventId: "1", provider: "claude", sessionId: "s1", ts: 1, kind: "session_start", agentId: "s1", paths: [], op: null }) });
    expect((await fetch(`http://127.0.0.1:${port}/reasoning`, { method: "POST", body: "{}" })).status).toBe(401);
    await fetch(`http://127.0.0.1:${port}/reasoning`, { method: "POST", ...auth, body: JSON.stringify({ agentId: "s1", ts: 2, text: "Refactoring the login handling" }) });
    const snap = await (await fetch(`http://127.0.0.1:${port}/state`, auth)).json();
    expect(snap.agents.find((a: any) => a.id === "s1").now).toBe("Refactoring the login handling");
  });
});

describe("RelayServer static files", () => {
  it("serves index.html at / with NO Authorization header", async () => {
    const { port } = await start(makeWebDir());
    const r = await fetch(`http://127.0.0.1:${port}/`); // no auth header on purpose
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await r.text()).toBe("<h1>clide</h1>");
  });
  it("serves index.html when the URL carries the token/session query string", async () => {
    const { port } = await start(makeWebDir());
    const r = await fetch(`http://127.0.0.1:${port}/?token=tok&session=s1`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("<h1>clide</h1>");
  });
  it("serves a nested asset with a js content-type, unauthenticated", async () => {
    const { port } = await start(makeWebDir());
    const r = await fetch(`http://127.0.0.1:${port}/assets/app.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await r.text()).toContain("export const x");
  });
  it("404s a missing static file instead of throwing", async () => {
    const { port } = await start(makeWebDir());
    const r = await fetch(`http://127.0.0.1:${port}/nope.js`);
    expect(r.status).toBe(404);
    // server still alive afterwards
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
  });
  it("does not leak a file outside the static root (traversal → 404)", async () => {
    const { port } = await start(makeWebDir());
    for (const p of ["/../secret.txt", "/..%2Fsecret.txt", "/assets/../../secret.txt", "/%2e%2e%2fsecret.txt"]) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      expect(r.status).toBe(404);
      expect(await r.text()).not.toContain("TOP-SECRET");
    }
  });
  it("does NOT weaken auth: /state still 401s without a token while static is open", async () => {
    const { port } = await start(makeWebDir());
    expect((await fetch(`http://127.0.0.1:${port}/state`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/stream`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/events`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/reasoning`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/state`, auth)).status).toBe(200); // token still works
  });
  it("without staticDir, / keeps the old behaviour: 401 unauthenticated, 404 with a token", async () => {
    const { port } = await start();
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/`, auth)).status).toBe(404);
  });
});

describe("RelayServer method checks", () => {
  it("POST /state does not return a snapshot (404), GET /state does", async () => {
    const { port } = await start();
    const post = await fetch(`http://127.0.0.1:${port}/state`, { method: "POST", ...auth, body: "{}" });
    expect(post.status).toBe(404);
    expect((await post.json()).sessionId).toBeUndefined();
    const get = await fetch(`http://127.0.0.1:${port}/state`, auth);
    expect(get.status).toBe(200);
    expect((await get.json()).sessionId).toBe("s1");
  });
  it("POST /stream does not open an SSE stream (404)", async () => {
    const { port } = await start();
    const r = await fetch(`http://127.0.0.1:${port}/stream`, { method: "POST", ...auth, body: "{}" });
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).not.toContain("event-stream");
  });
});
