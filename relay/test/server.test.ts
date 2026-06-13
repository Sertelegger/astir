import { describe, it, expect, afterEach } from "vitest";
import { SessionState } from "../src/model/session-state.js";
import { systemClock } from "../src/model/clock.js";
import { Counters } from "../src/log/logger.js";
import { RelayServer } from "../src/relay/server.js";

let server: RelayServer | undefined;
afterEach(async () => { if (server) await server.close(); server = undefined; });

async function start() {
  const state = new SessionState({ sessionId: "s1", provider: "claude", cwd: process.cwd(), clock: systemClock });
  server = new RelayServer({ state, token: "tok", counters: new Counters(), flushMs: 10 });
  const port = await server.listen();
  return { port, state };
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
  it("/reasoning requires the token and updates the Now line", async () => {
    const { port } = await start();
    await fetch(`http://127.0.0.1:${port}/events`, { method: "POST", ...auth, body: JSON.stringify({ v: 1, eventId: "1", provider: "claude", sessionId: "s1", ts: 1, kind: "session_start", agentId: "s1", paths: [], op: null }) });
    expect((await fetch(`http://127.0.0.1:${port}/reasoning`, { method: "POST", body: "{}" })).status).toBe(401);
    await fetch(`http://127.0.0.1:${port}/reasoning`, { method: "POST", ...auth, body: JSON.stringify({ agentId: "s1", ts: 2, text: "Refactoring the login handling" }) });
    const snap = await (await fetch(`http://127.0.0.1:${port}/state`, auth)).json();
    expect(snap.agents.find((a: any) => a.id === "s1").now).toBe("Refactoring the login handling");
  });
});
