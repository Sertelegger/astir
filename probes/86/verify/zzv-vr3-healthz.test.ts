import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Daemon } from "../src/daemon/server.js";
import { claudeScreen, type DiscoveredSession } from "../src/discovery/sessions.js";
import { parseProfileLines, PROFILE_SEPARATOR } from "../src/discovery/remote.js";
import { Registry } from "../src/model/registry.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
type Payload = Record<string, unknown>;
const capture = JSON.parse(readFileSync(join(root, "test", "fixtures", "claude", "permission-request.json"), "utf8")) as {
  sequence: { afterMs: number; payload: Payload }[];
};
const step = (n: string) => capture.sequence.find((x) => x.payload.hook_event_name === n)!.payload;
const pre = step("PreToolUse");
const request = step("PermissionRequest");
const notification = step("Notification");
const SESSION = String(request.payload?.session_id ?? request.session_id);
const CWD = String(request.cwd);
const codex = JSON.parse(readFileSync(join(root, "test", "fixtures", "codex", "capture.json"), "utf8")) as {
  escSequence: { payload: Payload }[];
};
const TOKEN = "t".repeat(48);
const listed = (status: string, waitingFor?: string): DiscoveredSession => {
  const screen = claudeScreen(status, waitingFor ?? null);
  return { sessionId: SESSION, cwd: CWD, pid: 4242, status, name: "repo", startedAt: null, ...(screen ? { screen } : {}) };
};

describe("vr3 healthz", () => {
  const open: Daemon[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((d) => d.close()));
  });
  async function boot(t: { v: number }) {
    const registry = new Registry({ nowMs: () => t.v });
    const d = new Daemon({ token: TOKEN, registry });
    open.push(d);
    const port = await d.listen(0);
    const send = async (prov: string, payload: Payload) => {
      const r = await fetch(`http://127.0.0.1:${port}/hook/${prov}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { status: r.status, body: await r.json() };
    };
    const health = async () => (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as { counters: Record<string, number> };
    return { registry, d, port, send, health };
  }

  it("a plain permission_prompt Notification (no claim) through ingest is counted", async () => {
    const t = { v: 0 };
    const b = await boot(t);
    console.log("SESSION", SESSION);
    console.log("pre", JSON.stringify(await b.send("claude", pre)));
    t.v = 100;
    console.log("notif", JSON.stringify(await b.send("claude", notification)));
    const h = await b.health();
    console.log("healthz.counters (plain notification)", JSON.stringify(h.counters));
    console.log("blockedCount", b.registry.blockedCount(), "blocksBegun", b.registry.blocksBegun());
    expect(h.counters.blocked).toBe(1);
    // answered, then a second plain block
    t.v = 200;
    await b.send("claude", { ...pre, tool_use_id: "toolu_2" });
    t.v = 300;
    await b.send("claude", notification);
    const h2 = await b.health();
    console.log("healthz.counters (2 plain)", JSON.stringify(h2.counters));
    expect(h2.counters.blocked).toBe(2);
    // a duplicate Notification on an already-blocked agent adds none
    t.v = 400;
    await b.send("claude", notification);
    expect((await b.health()).counters.blocked).toBe(2);
  });

  it("codex PermissionRequest (-> permission_prompt) through ingest is counted", async () => {
    const t = { v: 0 };
    const b = await boot(t);
    for (const s of codex.escSequence.slice(0, 2)) {
      t.v += 100;
      console.log("codex", String(s.payload.hook_event_name), JSON.stringify(await b.send("codex", s.payload)));
    }
    const h = await b.health();
    console.log("healthz.counters (codex)", JSON.stringify(h.counters));
    expect(h.counters.blocked).toBe(1);
  });

  it("listing-made + ingest-made in one daemon both counted", async () => {
    const t = { v: 0 };
    const b = await boot(t);
    await b.send("claude", pre);
    await b.send("claude", request);
    t.v = 1_300;
    b.registry.reconcile([listed("waiting", "permission prompt")], { provider: "claude", observedAt: 1_000 });
    expect((await b.health()).counters.blocked).toBe(1);
    t.v = 6_300;
    b.registry.reconcile([listed("idle")], { provider: "claude", observedAt: 6_000 }); // Esc
    console.log("after Esc", b.registry.get(SESSION)?.agents.get(SESSION)?.state);
    t.v = 7_000;
    await b.send("claude", { ...pre, tool_use_id: "toolu_3" });
    t.v = 7_100;
    await b.send("claude", notification); // plain, no claim
    const h = await b.health();
    console.log("healthz.counters (listing + ingest)", JSON.stringify(h.counters));
    expect(h.counters.blocked).toBe(2);
  });

  it("retracted sighting block: does the counter keep it?", async () => {
    const t = { v: 0 };
    const b = await boot(t);
    const BG = "b6df52f63e0c9a466";
    await b.send("claude", pre);
    await b.send("claude", request); // main claim @0
    t.v = 3_000;
    await b.send("claude", { ...pre, agent_id: BG, tool_use_id: "toolu_bg" });
    await b.send("claude", { ...request, agent_id: BG }); // bg claim @3000 (self-denied)
    t.v = 5_300;
    b.registry.reconcile([listed("waiting", "permission prompt")], { provider: "claude", observedAt: 5_000 });
    const s = () => b.registry.get(SESSION)!.agents;
    console.log("@5.3 main", s().get(SESSION)?.state, "bg", s().get(BG)?.state, "blocksBegun", b.registry.blocksBegun());
    t.v = 6_400;
    await b.send("claude", notification); // main's Notification
    console.log("@6.4 main", s().get(SESSION)?.state, "bg", s().get(BG)?.state, "blocksBegun", b.registry.blocksBegun());
    const h = await b.health();
    console.log("healthz.counters (retracted)", JSON.stringify(h.counters), "blockedCount", b.registry.blockedCount());
  });

  it("remote rows parse and carry screen", () => {
    const one = JSON.stringify([
      { sessionId: "r1", cwd: "/x", pid: 1, status: "waiting", waitingFor: "permission prompt", name: "a" },
      { sessionId: "r2", cwd: "/x", pid: 2, status: "busy", name: "b" },
      { sessionId: "r3", cwd: "/x", pid: 3, status: "idle" },
    ]);
    const two = JSON.stringify([{ sessionId: "r4", cwd: "/y", state: "waiting", waitingFor: "input needed" }]);
    const rows = parseProfileLines(`${one}\n${PROFILE_SEPARATOR}\n${two}\n${PROFILE_SEPARATOR}\n`);
    console.log("remote rows", JSON.stringify(rows));
    expect(rows?.map((r) => [r.sessionId, r.status, r.screen])).toEqual([
      ["r1", "waiting", "permission-dialog"],
      ["r2", "busy", "working"],
      ["r3", "idle", "at-prompt"],
      ["r4", "waiting", "other-dialog"],
    ]);
    for (const r of rows ?? []) expect(r).not.toHaveProperty("waitingFor");
  });
});
