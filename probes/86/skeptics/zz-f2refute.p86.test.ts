/** F2 refute probe (#86 worktree). Independent re-implementation of the cadence. */
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { normalizeClaudeHook } from "../src/adapters/claude/normalize.js";
import { claudeScreen, type DiscoveredSession } from "../src/discovery/sessions.js";
import { Registry } from "../src/model/registry.js";
import { type DeliveryTarget, Dispatcher } from "../src/notify/dispatch.js";
import type { NotifyEnvelope } from "../src/notify/envelope.js";
import { NotifyLoop } from "../src/notify/loop.js";
import { NotifyPolicy } from "../src/notify/policy.js";

const LOG = process.env.F2_LOG ?? "/tmp/f2.log";
const say = (s: string) => appendFileSync(LOG, `${s}\n`);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
type P = Record<string, unknown>;
const cap = JSON.parse(readFileSync(join(root, "test/fixtures/claude/permission-request.json"), "utf8")) as {
  sequence: Array<{ payload: P }>;
};
const step = (n: string) => {
  const s = cap.sequence.find((x) => x.payload.hook_event_name === n);
  if (!s) throw new Error(n);
  return s.payload;
};
const pre = step("PreToolUse");
const req = step("PermissionRequest");
const note = step("Notification");
const SESSION = String(req.session_id);
const CWD = String(req.cwd);
const SUB = "a5cf41e52d9b8f355";
const SUB2 = "b6df52f63e0c9a466";
const post = { ...pre, hook_event_name: "PostToolUse", tool_response: {} };
const subPre = (id: string, tu = `toolu_${id}`) => ({ ...pre, agent_id: id, tool_use_id: tu });
const subPost = (id: string) => ({ ...post, agent_id: id, tool_use_id: `toolu_${id}` });
const subReq = (id: string) => ({ ...req, agent_id: id });

async function run(name: string, hooks: Array<[number, P]>, onScreen: (at: number) => boolean, until: number, phase: number, probes: number[]) {
  let t = 0;
  let n = 0;
  const sent: NotifyEnvelope[] = [];
  const target: DeliveryTarget = { name: "t", live: () => true, deliver: async (e) => (sent.push(e), { ok: true }) };
  const registry = new Registry({ nowMs: () => t });
  const loop = new NotifyLoop({ registry, policy: new NotifyPolicy(), dispatcher: new Dispatcher([target]), now: () => t });
  const steps: Array<{ at: number; o: number; go: () => unknown }> = [];
  for (const [at, p] of hooks)
    steps.push({
      at,
      o: 0,
      go: () => {
        const r = normalizeClaudeHook(p, { readSidecar: () => null, newId: () => `e${++n}`, realpath: (x: string) => x, now: () => 1 });
        if (r.event) registry.apply(r.event, r.cwd);
      },
    });
  for (let b = phase; b <= until; b += 5_000) {
    const up = onScreen(b);
    const screen = claudeScreen(up ? "waiting" : "busy", up ? "permission prompt" : null);
    const row: DiscoveredSession = { sessionId: SESSION, cwd: CWD, pid: 4242, status: up ? "waiting" : "busy", name: "r", startedAt: null, ...(screen ? { screen } : {}) };
    steps.push({ at: b + 300, o: 1, go: () => registry.reconcile([row], { provider: "claude", complete: true, observedAt: b }) });
  }
  for (let at = 0; at <= until; at += 1_000)
    steps.push({ at, o: 2, go: () => (registry.tick(), loop.pulse()) });
  for (const p of probes) steps.push({ at: p, o: 3, go: () => {
    const s = registry.get(SESSION);
    const desc = [...(s?.agents.values() ?? [])].map((a) => `${a.id === SESSION ? "main" : a.id.slice(0, 6)}=${a.state}/claim=${a.dialogSince}/held=${a.dialogHeldAt}`).join(" ");
    say(`[F2 ${name}] t=${p / 1000}s ${desc}`);
  } });
  steps.sort((a, b) => a.at - b.at || a.o - b.o);
  for (const s of steps) {
    t = s.at;
    await s.go();
  }
  const who = (e: NotifyEnvelope) => (e.session.agentId === SESSION ? "main" : e.session.agentId);
  say(`[F2 ${name}] story=${JSON.stringify(sent.map((e) => `${e.kind}:${who(e)}@${e.ts / 1000}`))}`);
}

describe("F2 refute (#86)", () => {
  it("S2 with and without dead SUB2 claim", async () => {
    for (const dead of [false, true]) {
      await run(
        `S2 dead=${dead}`,
        [
          [0, pre],
          [0, req],
          [300, req],
          ...((dead ? [[3_000, subPre(SUB2)], [3_000, subReq(SUB2)], [45_000, subPre(SUB2, "toolu_bg2")]] : []) as Array<[number, P]>),
          [6_400, note],
          [21_000, post],
          [26_200, note],
        ],
        (at) => at >= 400 && at < 200_000,
        180_000,
        1_000,
        [20_500, 21_500, 22_500, 27_000, 46_000, 180_000],
      );
    }
  });
  it("S2c", async () => {
    await run(
      "S2c",
      [
        [0, subPre(SUB)],
        [0, subReq(SUB)],
        [1_000, pre],
        [1_000, req],
        [1_300, req],
        [7_600, note],
        [61_000, post],
        [66_200, note],
        [300_000, subPost(SUB)],
      ],
      (at) => at >= 1_400 && at < 400_000,
      400_000,
      2_000,
      [3_000, 60_500, 61_500, 62_500, 67_000, 301_000, 400_000],
    );
  });
  it("S2c-variant: single main ask B (no parallel), SUB approved quick", async () => {
    // Control: is the dead held claim harmful without main's same-agent parallel ask?
    await run(
      "S2c-noparallel",
      [
        [0, subPre(SUB)],
        [0, subReq(SUB)],
        [1_000, pre],
        [1_000, req],
        [7_600, note],
        [61_000, post],
        [65_000, { ...pre, tool_use_id: "toolu_B" }],
        [65_000, { ...req, tool_use_id: "toolu_B" }],
        [71_200, note],
        [300_000, subPost(SUB)],
      ],
      (at) => (at >= 1_400 && at < 60_000) || (at >= 65_400 && at < 400_000),
      400_000,
      2_000,
      [62_000, 66_000, 72_000, 301_000, 400_000],
    );
  });
});
