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

const LOG = "/tmp/claude-1000/-home-dev-repos-astir/d8458719-ef7f-472f-be54-5616006a1f7c/scratchpad/vr3-f3r/main.log";
const say = (line: string) => appendFileSync(LOG, `${line}\n`);
type Payload = Record<string, unknown>;
type Step = { afterMs: number; payload: Payload };
const capture = JSON.parse(
  readFileSync("/tmp/claude-1000/-home-dev-repos-astir/d8458719-ef7f-472f-be54-5616006a1f7c/scratchpad/vr3-f3r/permission-request.json", "utf8"),
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


describe("F3R on main 07c3935", () => {
  it("S2 dead=true", async () => {
    const h = await run({
      hooks: [
        [0, pre.payload], [0, request.payload], [300, request.payload],
        [3_000, subPre(SUB2)], [3_000, subClaim(SUB2)], [45_000, subPre(SUB2, "toolu_bg2")],
        [6_400, notification.payload], [21_000, post], [26_200, notification.payload],
      ],
      screen: (at) => (at >= 400 && at < 200_000 ? ["waiting", DIALOG] : ["busy"]),
      until: 180_000, phase: 1_000,
    });
    say(`[MAIN] S2 dead=true: ${JSON.stringify(story(h))} main=${h.agent()?.state}`);
  });
  it("V2", async () => {
    const read = { ...pre.payload, tool_name: "Read", tool_use_id: "toolu_read" };
    const readPost = { ...read, hook_event_name: "PostToolUse", tool_response: {} };
    const h = await run({
      hooks: [
        [0, read], [0, pre.payload], [400, request.payload], [800, subPre(SUB2)], [800, subClaim(SUB2)],
        [900, readPost], [6_600, notification.payload], [45_000, subPre(SUB2, "toolu_bg2")],
      ],
      screen: (at) => (at >= 800 && at < 200_000 ? ["waiting", DIALOG] : ["busy"]),
      until: 180_000, phase: 1_000,
    });
    say(`[MAIN] V2: ${JSON.stringify(story(h))} main=${h.agent()?.state}`);
  });
});
