/** VR3 #86 — the same timelines on main 07c3935 (pre-#86), for comparison. */
import { appendFileSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeClaudeHook } from "../src/adapters/claude/normalize.js";
import { type AstirEvent, CONTRACT_VERSION } from "../src/contract/event.js";
import { Registry } from "../src/model/registry.js";
import { type DeliveryTarget, Dispatcher } from "../src/notify/dispatch.js";
import type { NotifyEnvelope } from "../src/notify/envelope.js";
import { NotifyLoop } from "../src/notify/loop.js";
import { NotifyPolicy } from "../src/notify/policy.js";

const LOG = "/tmp/claude-1000/-home-dev-repos-astir/d8458719-ef7f-472f-be54-5616006a1f7c/scratchpad/vr3-p86/vr3-main.log";
const say = (line: string) => appendFileSync(LOG, `${line}\n`);
type Payload = Record<string, unknown>;
type Step = { afterMs: number; payload: Payload };
const capture = JSON.parse(
  readFileSync("/home/dev/astir-vr3-p86/test/fixtures/claude/permission-request.json", "utf8"),
) as { sequence: Step[] };
const stepOf = (name: string) => {
  const s = capture.sequence.find((x) => x.payload.hook_event_name === name);
  if (s === undefined) throw new Error(name);
  return s;
};
const pre = stepOf("PreToolUse");
const request = stepOf("PermissionRequest");
const notification = stepOf("Notification");
const SESSION = String(request.payload.session_id);
const CWD = String(request.payload.cwd);
const SUB = "a5cf41e52d9b8f355";
const SUB2 = "b6df52f63e0c9a466";
const post = { ...pre.payload, hook_event_name: "PostToolUse", tool_response: {} };
const spawn = { ...pre.payload, tool_name: "Agent", tool_use_id: "toolu_spawn", tool_input: { prompt: "<redacted>" } };
const subPre = (id: string, toolUseId = `toolu_${id}`) => ({ ...pre.payload, agent_id: id, tool_use_id: toolUseId });
const subClaim = (id: string) => ({ ...request.payload, agent_id: id });
const DIALOG = "permission prompt";
const who = (e: NotifyEnvelope) => (e.session.agentId === SESSION ? "main" : e.session.agentId);
const deps = { readSidecar: () => null, newId: () => "e1", realpath: (p: string) => p, now: () => 1_793_000_000 };

function harness() {
  let t = 0;
  let n = 0;
  const now = () => t;
  const sent: NotifyEnvelope[] = [];
  const target: DeliveryTarget = { name: "test", live: () => true, deliver: async (e) => (sent.push(e), { ok: true }) };
  const registry = new Registry({ nowMs: now });
  const loop = new NotifyLoop({ registry, policy: new NotifyPolicy(), dispatcher: new Dispatcher([target]), now });
  const hook = (payload: Payload) => {
    const r = normalizeClaudeHook(payload, { ...deps, newId: () => `e${++n}` });
    if (r.event === null) return undefined; // PermissionRequest is unmapped before #86
    return registry.apply(r.event, r.cwd);
  };
  const poll = (status: string | null, _startedAt: number = t, _o: { waitingFor?: string } = {}) =>
    registry.reconcile([{ sessionId: SESSION, cwd: CWD, pid: 4242, status, name: "repo", startedAt: null }], {
      provider: "claude",
      complete: true,
    });
  const agent = (sessionId = SESSION, agentId = sessionId) => registry.get(sessionId)?.agents.get(agentId);
  const pollFor = async (status: string | null, from: number, to: number) => {
    for (let at = from; at <= to; at += 5_000) {
      t = at + 300;
      poll(status, at);
      t = at + 1_000;
      registry.tick();
      await loop.pulse();
    }
  };
  return { registry, loop, sent, hook, poll, pollFor, agent, at: (ms: number) => { t = ms; } };
}
async function run(opts: { hooks: Array<[number, Payload]>; screen: (at: number) => [string, string?]; until: number; phase?: number }) {
  const h = harness();
  const steps: Array<{ at: number; order: number; go: () => unknown }> = [];
  for (const [at, payload] of opts.hooks) steps.push({ at, order: 0, go: () => h.hook(payload) });
  for (let begun = opts.phase ?? 0; begun <= opts.until; begun += 5_000) {
    const [status] = opts.screen(begun);
    steps.push({ at: begun + 300, order: 1, go: () => h.poll(status, begun) });
  }
  for (let at = 0; at <= opts.until; at += 1_000) {
    steps.push({ at, order: 2, go: () => { h.registry.tick(); return h.loop.pulse(); } });
  }
  steps.sort((a, b) => a.at - b.at || a.order - b.order);
  for (const s of steps) { h.at(s.at); await s.go(); }
  return h;
}
const story = (h: ReturnType<typeof harness>) => h.sent.map((e) => `${e.kind}:${who(e)}@${e.ts / 1000}`);

describe("VR3 on main 07c3935", () => {
  it("S1", async () => {
    const h = await run({
      hooks: [
        [0, subPre(SUB)], [0, subClaim(SUB)], [3_000, pre.payload], [3_000, request.payload],
        [8_500, request.payload], [9_400, notification.payload], [61_000, post], [66_200, notification.payload],
        [120_000, { ...post, agent_id: SUB, tool_use_id: `toolu_${SUB}` }],
      ],
      screen: (at) => (at >= 3_400 && at < 90_000 ? ["waiting", DIALOG] : ["busy"]),
      until: 130_000, phase: 4_000,
    });
    say(`[MAIN] S1: ${JSON.stringify(story(h))}`);
  });
  for (const withDeadClaim of [false, true]) {
    it(`S2 dead=${withDeadClaim}`, async () => {
      const h = await run({
        hooks: [
          [0, pre.payload], [0, request.payload], [300, request.payload],
          ...(withDeadClaim ? ([[3_000, subPre(SUB2)], [3_000, subClaim(SUB2)], [45_000, subPre(SUB2, "toolu_bg2")]] as Array<[number, Payload]>) : []),
          [6_400, notification.payload], // A's Notification (#86 run had the sighting instead)
          [21_000, post], [26_200, notification.payload],
        ],
        screen: (at) => (at >= 400 && at < 200_000 ? ["waiting", DIALOG] : ["busy"]),
        until: 180_000, phase: 1_000,
      });
      say(`[MAIN] S2 dead=${withDeadClaim}: ${JSON.stringify(story(h))} main=${h.agent()?.state}`);
    });
  }
  it("S2c", async () => {
    const h = await run({
      hooks: [
        [0, subPre(SUB)], [0, subClaim(SUB)], [1_000, pre.payload], [1_000, request.payload], [1_300, request.payload],
        [7_600, notification.payload], [61_000, post], [66_200, notification.payload],
        [300_000, { ...post, agent_id: SUB, tool_use_id: `toolu_${SUB}` }],
      ],
      screen: (at) => (at >= 1_400 && at < 400_000 ? ["waiting", DIALOG] : ["busy"]),
      until: 400_000, phase: 2_000,
    });
    say(`[MAIN] S2c: ${JSON.stringify(story(h))} main=${h.agent()?.state}`);
  });
  it("S8", async () => {
    const h = await run({
      hooks: [
        [0, pre.payload], [0, request.payload], [500, subPre(SUB)], [500, subClaim(SUB)], [6_400, notification.payload],
        [21_000, post], [41_000, { ...post, agent_id: SUB, tool_use_id: `toolu_${SUB}` }],
      ],
      screen: (at) => (at >= 400 && at < 40_000 ? ["waiting", DIALOG] : ["busy"]),
      until: 60_000, phase: 0,
    });
    say(`[MAIN] S8: ${JSON.stringify(story(h))}`);
  });
  it("S4 dead subagent while another's dialog is up", async () => {
    const h = harness();
    h.at(0); h.hook(spawn);
    h.at(100); h.hook(subPre(SUB));
    h.at(5_000); h.hook({ ...post, agent_id: SUB, tool_use_id: `toolu_${SUB}` });
    h.at(10_000); h.hook(subPre(SUB2)); h.hook(subClaim(SUB2));
    h.at(16_200); h.hook(notification.payload);
    await h.pollFor("waiting", 11_000, 600_000);
    say(`[MAIN] S4 at 600 s: SUB=${h.agent(SESSION, SUB)?.state} activeMs=${h.agent(SESSION, SUB)?.activeMs}`);
  });
  it("S4b agent_needs_input, Esc", async () => {
    const h = harness();
    h.at(0); h.hook(spawn);
    h.at(100); h.hook(subPre(SUB));
    h.at(5_000); h.hook({ ...post, agent_id: SUB, tool_use_id: `toolu_${SUB}` });
    h.at(6_000); h.hook({ ...notification.payload, notification_type: "agent_needs_input", message: "<redacted>" });
    await h.pollFor("idle", 10_000, 3_600_000);
    say(`[MAIN] S4b at 1 h: main=${h.agent()?.state} SUB=${h.agent(SESSION, SUB)?.state}`);
  });
  it("S4c Codex", () => {
    let t = 0; let seq = 0;
    const r = new Registry({ nowMs: () => t });
    const ev = (over: Partial<AstirEvent>): AstirEvent => ({
      v: CONTRACT_VERSION, eventId: `c${++seq}`, provider: "codex", sessionId: "cx", ts: 1_000 + seq, kind: "pre_tool",
      agentId: "cx", agentType: null, parentAgentId: null, parentSource: null, tool: "shell", description: null,
      paths: [], op: null, ok: null, notificationKind: null, ...over,
    });
    r.apply(ev({ agentId: "cx-sub", kind: "post_tool" }), "/repo");
    r.apply(ev({ kind: "notification", notificationKind: "permission_prompt", tool: null }), "/repo");
    t = 16 * 60_000; r.tick();
    say(`[MAIN] S4c Codex sibling at 16 min: ${r.get("cx")?.agents.get("cx-sub")?.state}`);
  });
  it("S5 agent_needs_input during a permission dialog, Esc", async () => {
    const h = harness();
    h.at(0); h.hook(pre.payload); h.hook(request.payload);
    h.at(3_000); await h.loop.pulse();
    h.hook({ ...notification.payload, notification_type: "agent_needs_input", message: "<redacted>" });
    h.at(4_300); h.poll("idle", 4_000);
    for (let at = 5_000; at <= 120_000; at += 1_000) { h.at(at); h.registry.tick(); await h.loop.pulse(); }
    say(`[MAIN] S5: ${JSON.stringify(story(h))} main=${h.agent()?.state}`);
  });
  it("S6 discovery down", async () => {
    const h = harness();
    h.at(0); h.hook(pre.payload); h.hook(request.payload);
    h.at(6_400); h.hook(notification.payload);
    for (let at = 7_000; at <= 12_000; at += 1_000) { h.at(at); await h.loop.pulse(); }
    say(`[MAIN] S6: ${JSON.stringify(story(h))}`);
    expect(true).toBe(true);
  });
});
