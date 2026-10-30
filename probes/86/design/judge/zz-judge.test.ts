/**
 * #86 judge harness: one tree-agnostic replay, run unchanged on held 96d3367
 * and on each candidate prototype. Real Registry + NotifyLoop on a fake clock.
 * Cadence: 100 ms steps; a poll begins every 5 s from `phase` and lands 300 ms
 * later with what was on screen when it began; tick + pulse every 1 s; at the
 * same ms, hooks before polls before the pulse. Times are ms after the first
 * PreToolUse (0); a dialog becomes visible ~0.8 s after its PreToolUse.
 *
 * Env: J_TREE label, J_OUT jsonl path, J_CORPUS orig|real, J_BATCH 0|1 (emit
 * PostToolBatch for self-denied asks, for B), J_EVID 0|1 (B evidenceDwell),
 * J_DPLUS 0|1 (emulate D+: reconcile when registry.dialogCheckDue()).
 */
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

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
type P = Record<string, unknown>;
const cap = JSON.parse(readFileSync(join(root, "test", "fixtures", "claude", "permission-request.json"), "utf8")) as {
  sequence: Array<{ payload: P }>;
};
const step = (n: string) => cap.sequence.find((s) => s.payload.hook_event_name === n)!.payload;
const PRE = step("PreToolUse");
const REQ = step("PermissionRequest");
const NOTE = step("Notification");
const SESSION = String(REQ.session_id);
const CWD = String(REQ.cwd);

const TREE = process.env.J_TREE ?? "?";
const OUT = process.env.J_OUT ?? "/dev/null";
const CORPUS = process.env.J_CORPUS ?? "real";
const BATCH = process.env.J_BATCH === "1";
const EVID = process.env.J_EVID === "1";
const DPLUS = process.env.J_DPLUS === "1";
const MODE = `${CORPUS}${BATCH ? "+batch" : ""}${EVID ? "+evid" : ""}${DPLUS ? "+dplus" : ""}`;

let makeCorrelator: (() => unknown) | null = null;
try {
  const path = "../src/adapters/claude/correlate.js";
  const m = (await import(/* @vite-ignore */ path)) as { ClaudeCallCorrelator: new () => unknown };
  makeCorrelator = () => new m.ClaudeCallCorrelator();
} catch {
  makeCorrelator = null;
}

const SUB = "a5cf41e52d9b8f355";
const SUB2 = "b6df52f63e0c9a466";
const BG = "c7e0a1b2c3d4e5f60";
const DIALOG = "permission prompt";

/** One tool call. In the orig corpus every call shares the fixture's tool_input (as the probes do). */
function call(agent: string | null, id: string, tool = "Bash") {
  const input = CORPUS === "orig" ? PRE.tool_input : { command: `cmd-${id}`, description: "x" };
  const tuid = CORPUS === "orig" ? (agent === null ? String(PRE.tool_use_id) : `toolu_${agent}`) : `toolu_${id}`;
  const ag = agent === null ? {} : { agent_id: agent, agent_type: "general-purpose" };
  return {
    pre: { ...PRE, ...ag, tool_name: tool, tool_input: input, tool_use_id: tuid } as P,
    req: { ...REQ, ...ag, tool_name: tool, tool_input: input } as P,
    post: { ...PRE, ...ag, hook_event_name: "PostToolUse", tool_name: tool, tool_input: input, tool_use_id: tuid, tool_response: {} } as P,
    batch: {
      ...PRE,
      ...ag,
      hook_event_name: "PostToolBatch",
      tool_calls: [{ tool_name: tool, tool_input: input, tool_use_id: tuid, tool_response: {} }],
    } as P,
  };
}
const notice = (type = "permission_prompt") => ({ ...NOTE, notification_type: type, message: "<x>" }) as P;
const subStop = (agent: string) => ({ ...PRE, agent_id: agent, hook_event_name: "SubagentStop" }) as P;
const fileChanged = { session_id: SESSION, cwd: CWD, hook_event_name: "FileChanged", file_path: `${CWD}/src/x.ts`, event: "change" } as P;
/** A self-denied background ask: its PreToolUse and PermissionRequest, and (B only) the batch that closes it. */
const selfDenied = (at: number, agent: string, id: string): Array<[number, P]> => {
  const c = call(agent, id);
  const out: Array<[number, P]> = [
    [at, c.pre],
    [at, c.req],
  ];
  if (BATCH) out.push([at + 100, c.batch]);
  return out;
};

type Screen = (at: number) => [string, string?];
type Poll = { begun: number; land: number; s: [string, string?] };

const deps = { readSidecar: () => null, realpath: (p: string) => p, now: () => 1_793_000_000 };

async function sim(opts: {
  hooks: Array<[number, P]>;
  screen: Screen;
  end: number;
  phase?: number;
  polls?: Poll[];
  watch?: string[];
}) {
  let t = 0;
  let n = 0;
  const now = () => t;
  const sent: NotifyEnvelope[] = [];
  const target: DeliveryTarget = {
    name: "t",
    live: () => true,
    deliver: async (e) => {
      sent.push(e);
      return { ok: true };
    },
  };
  const registry = new Registry({ nowMs: now, ...(EVID ? { evidenceDwell: true } : {}) } as never);
  const loop = new NotifyLoop({ registry, policy: new NotifyPolicy(), dispatcher: new Dispatcher([target]), now });
  const correlator = makeCorrelator?.();
  const notApplied: string[] = [];
  const hook = (p: P) => {
    const r = normalizeClaudeHook(p as never, { ...deps, newId: () => `e${++n}`, ...(correlator ? { correlator } : {}) } as never);
    if (r.event === null) {
      notApplied.push(`${t}:${String(p.hook_event_name)}:null`);
      return;
    }
    const a = registry.apply(r.event, r.cwd);
    if (!a.applied) notApplied.push(`${t}:${String(p.hook_event_name)}`);
  };
  const listed = (status: string, waitingFor?: string): DiscoveredSession => {
    const screen = claudeScreen(status, waitingFor ?? null);
    return { sessionId: SESSION, cwd: CWD, pid: 4242, status, name: "repo", startedAt: null, ...(screen === undefined ? {} : { screen }) } as DiscoveredSession;
  };
  const poll = (p: Poll) =>
    registry.reconcile([listed(p.s[0], p.s[1])], { provider: "claude", complete: true, observedAt: p.begun } as never);
  const hooks = [...opts.hooks].sort((a, b) => a[0] - b[0]);
  const pending: Poll[] = opts.polls ? [...opts.polls] : [];
  const watch = opts.watch ?? [SESSION];
  const trace: string[] = [];
  const last = new Map<string, string>();
  const phase = opts.phase ?? 0;
  for (let ms = 0; ms <= opts.end; ms += 100) {
    t = ms;
    while (hooks.length > 0 && hooks[0]![0] <= ms) hook(hooks.shift()![1]);
    if (!opts.polls && ms >= phase && (ms - phase) % 5_000 === 0) pending.push({ begun: ms, land: ms + 300, s: opts.screen(ms) });
    for (const p of pending.filter((x) => x.land === ms)) poll(p);
    if (ms % 1_000 === 0) {
      registry.tick();
      if (DPLUS) {
        const r = registry as unknown as { dialogCheckDue?: () => boolean };
        if (r.dialogCheckDue?.()) pending.push({ begun: ms, land: ms + 300, s: opts.screen(ms) });
      }
      await loop.pulse();
    }
    for (const id of watch) {
      const a = registry.get(SESSION)?.agents.get(id);
      const st = a ? `${a.state}/${a.blockedReason ?? "-"}` : "none";
      if (last.get(id) !== st) {
        trace.push(`${ms / 1000}:${id === SESSION ? "main" : id.slice(0, 3)}=${st}`);
        last.set(id, st);
      }
    }
  }
  const who = (e: NotifyEnvelope) => (e.session.agentId === SESSION ? "main" : e.session.agentId.slice(0, 3));
  const story = sent.map((e) => `${e.kind === "blocked" ? "B" : e.kind === "resolved" ? "R" : e.kind}:${who(e)}@${e.ts / 1000}`);
  const final: Record<string, unknown> = {};
  for (const id of watch) {
    const a = registry.get(SESSION)?.agents.get(id);
    final[id === SESSION ? "main" : id.slice(0, 3)] = a
      ? { state: a.state, reason: a.blockedReason ?? null, activeMs: a.activeMs, blockedMs: a.blockedMs }
      : null;
  }
  const blocksBegun = (registry as unknown as { blocksBegun?: () => number }).blocksBegun?.() ?? null;
  return { story, trace, final, notApplied, blocksBegun };
}

function emit(name: string, r: Awaited<ReturnType<typeof sim>>, extra: Record<string, unknown> = {}) {
  appendFileSync(OUT, `${JSON.stringify({ tree: TREE, mode: MODE, name, story: r.story, final: r.final, blocksBegun: r.blocksBegun, trace: r.trace, notApplied: r.notApplied, ...extra })}\n`);
}
const waitingIf = (up: (at: number) => boolean, otherwise = "busy"): Screen => (at) => (up(at) ? ["waiting", DIALOG] : [otherwise]);

describe(`judge ${TREE} ${MODE}`, () => {
  it("probe timelines", async () => {
    // ---------- S1: parallel re-claim while A is on screen ----------
    {
      const sub = call(SUB, "s1sub");
      const a = call(null, "s1a");
      const b = call(null, "s1b");
      const hooks: Array<[number, P]> = [
        [0, sub.pre],
        [0, sub.req], // approved 0.8 s; runs to 120 s
        [3_000, a.pre],
        [3_000, a.req], // A on screen 3.4..60
        ...(CORPUS === "real" ? ([[8_400, b.pre]] as Array<[number, P]>) : []),
        [8_500, CORPUS === "real" ? b.req : a.req], // B, queued
        [9_400, notice()],
        [61_000, a.post], // A approved 60; B on screen 60..90
        ...(CORPUS === "real" ? ([[66_200, notice()], [90_500, b.post]] as Array<[number, P]>) : []),
        [120_000, sub.post],
      ];
      emit("S1", await sim({ hooks, screen: waitingIf((t) => t >= 3_400 && t < 90_000), end: 130_000, phase: 4_000, watch: [SESSION, SUB] }));
      const ctl = hooks.filter(([at]) => at !== 8_400 && at !== 8_500 && at !== 66_200 && at !== 90_500);
      emit("S1-control", await sim({ hooks: ctl, screen: waitingIf((t) => t >= 3_400 && t < 60_000), end: 130_000, phase: 4_000, watch: [SESSION, SUB] }));
    }
    // ---------- S2: main's A and parallel B; dead SUB2 self-denied claim ----------
    for (const dead of [false, true]) {
      const a = call(null, "s2a");
      const b = call(null, "s2b");
      const hooks: Array<[number, P]> = [
        [0, a.pre],
        [0, a.req],
        ...(CORPUS === "real" ? ([[300, b.pre]] as Array<[number, P]>) : []),
        [300, CORPUS === "real" ? b.req : a.req],
        ...(dead ? [...selfDenied(3_000, SUB2, "s2d"), [45_000, call(SUB2, "s2d2").pre] as [number, P]] : []),
        [6_400, notice()],
        [21_000, a.post],
        [26_200, notice()],
      ];
      emit(`S2 dead=${dead}`, await sim({ hooks, screen: waitingIf((t) => t >= 400 && t < 200_000), end: 180_000, phase: 1_000, watch: [SESSION, SUB2] }));
    }
    // ---------- S2c: SUB approved at 0.5 s runs 5 min; main's A then B ----------
    {
      const sub = call(SUB, "s2csub");
      const a = call(null, "s2ca");
      const b = call(null, "s2cb");
      const hooks: Array<[number, P]> = [
        [0, sub.pre],
        [0, sub.req],
        [1_000, a.pre],
        [1_000, a.req],
        ...(CORPUS === "real" ? ([[1_300, b.pre]] as Array<[number, P]>) : []),
        [1_300, CORPUS === "real" ? b.req : a.req],
        [7_600, notice()],
        [61_000, a.post],
        [66_200, notice()],
        [300_000, sub.post],
      ];
      emit("S2c", await sim({ hooks, screen: waitingIf((t) => t >= 1_400 && t < 400_000), end: 400_000, phase: 2_000, watch: [SESSION, SUB] }));
    }
    // ---------- S3: main approves at 4 s (tool to 64 s); SUB's queued dialog 4..30 ----------
    for (const subNotice of [true, false]) {
      const a = call(null, "s3a");
      const sub = call(SUB, "s3sub");
      const hooks: Array<[number, P]> = [
        [0, a.pre],
        [0, a.req],
        [2_000, sub.pre],
        [2_000, sub.req],
        ...(subNotice ? ([[10_200, notice()]] as Array<[number, P]>) : []),
        [31_000, sub.post],
        [64_000, a.post],
      ];
      emit(`S3 notice=${subNotice}`, await sim({ hooks, screen: waitingIf((t) => t >= 400 && t < 30_000), end: 70_000, phase: 1_000, watch: [SESSION, SUB] }));
    }
    // ---------- S8: main's A up 0.4..20, SUB queued 0.5 s later, up 20..40 ----------
    {
      const a = call(null, "s8a");
      const sub = call(SUB, "s8sub");
      const hooks: Array<[number, P]> = [
        [0, a.pre],
        [0, a.req],
        [500, sub.pre],
        [500, sub.req],
        [6_400, notice()],
        [21_000, a.post],
        ...(CORPUS === "real" ? ([[26_200, notice()]] as Array<[number, P]>) : []),
        [41_000, sub.post],
      ];
      emit("S8", await sim({ hooks, screen: waitingIf((t) => t >= 400 && t < 40_000), end: 60_000, phase: 0, watch: [SESSION, SUB] }));
    }
    // ---------- RY (VR3-86-1): explicit polls ----------
    {
      const a = call(null, "rya");
      const sub = call(SUB, "rysub");
      const b = call(null, "ryb");
      const hooks: Array<[number, P]> = [
        [0, a.pre],
        [0, a.req],
        [1_000, sub.pre],
        [1_000, sub.req],
        ...(CORPUS === "real" ? ([[3_000, b.pre]] as Array<[number, P]>) : []),
        [3_000, CORPUS === "real" ? b.req : a.req],
        [6_400, notice()],
      ];
      const polls: Poll[] = [
        { begun: 500, land: 1_300, s: ["waiting", DIALOG] },
        { begun: 5_000, land: 5_300, s: ["waiting", DIALOG] },
        { begun: 10_000, land: 10_300, s: ["waiting", DIALOG] },
        { begun: 15_000, land: 15_300, s: ["waiting", DIALOG] },
      ];
      emit("RY", await sim({ hooks, screen: () => ["waiting", DIALOG], polls, end: 20_000, watch: [SESSION, SUB] }));
    }
    // ---------- S4: SUB's last event at 5 s; SUB2's dialog seen 10..600 s ----------
    {
      const spawn = call(null, "s4spawn", "Agent");
      const sub = call(SUB, "s4sub");
      const sub2 = call(SUB2, "s4sub2");
      const hooks: Array<[number, P]> = [
        [0, spawn.pre],
        [100, sub.pre],
        [5_000, sub.post],
        [10_000, sub2.pre],
        [10_000, sub2.req],
        [16_400, notice()],
      ];
      emit("S4", await sim({ hooks, screen: waitingIf((t) => t >= 10_400 && t < 600_000), end: 600_000, phase: 1_000, watch: [SESSION, SUB, SUB2] }));
    }
    // ---------- S4b: agent_needs_input on main, then Esc (listing idle), 20 min ----------
    {
      const spawn = call(null, "s4bspawn", "Agent");
      const sub = call(SUB, "s4bsub");
      const hooks: Array<[number, P]> = [
        [0, spawn.pre],
        [100, sub.pre],
        [5_000, sub.post],
        [6_000, notice("agent_needs_input")],
      ];
      emit("S4b", await sim({ hooks, screen: (t) => (t < 9_000 ? ["busy"] : ["idle"]), end: 1_200_000, phase: 0, watch: [SESSION, SUB] }));
    }
  }, 600_000);

  it("self-denied background asks", async () => {
    // ---------- R1: self-denied BG ask newer than main's unseen real dialog ----------
    for (const bgNext of [3_000, 5_000, 8_000, 15_000, 40_000]) {
      const m = call(null, "r1m");
      const hooks: Array<[number, P]> = [
        [0, m.pre],
        [0, m.req],
        ...selfDenied(1_000, BG, "r1bg"),
        [6_400, notice()],
        [bgNext, call(BG, "r1bg2").pre],
        [60_000, m.post],
      ];
      emit(`R1 bgNext=${bgNext}`, await sim({ hooks, screen: waitingIf((t) => t >= 400 && t < 59_000), end: 120_000, phase: 2_000, watch: [SESSION, BG] }));
    }
    // ---------- R6 sweep ----------
    const r6: string[] = [];
    let lost = 0;
    let bgAlerted = 0;
    let falseRes = 0;
    const firsts: number[] = [];
    for (const bgAt of [500, 1_500, 3_000, 5_000]) {
      for (const bgDelay of [2_000, 4_000, 6_000, 8_000, 12_000, 20_000]) {
        for (const phase of [0, 1_000, 2_000, 3_000, 4_000]) {
          const m = call(null, "r6m");
          const hooks: Array<[number, P]> = [
            [0, m.pre],
            [0, m.req],
            ...selfDenied(bgAt, BG, "r6bg"),
            [6_400, notice()],
            [bgAt + bgDelay, call(BG, "r6bg2").pre],
            [60_000, m.post],
          ];
          const r = await sim({ hooks, screen: waitingIf((t) => t >= 400 && t < 59_000), end: 70_000, phase, watch: [SESSION, BG] });
          const mainB = r.story.filter((s) => s.startsWith("B:main"));
          if (mainB.length === 0) lost++;
          else firsts.push(Number(mainB[0]!.split("@")[1]));
          if (r.story.some((s) => s.startsWith(`B:${BG.slice(0, 3)}`))) bgAlerted++;
          if (r.story.some((s) => s.startsWith("R:") && Number(s.split("@")[1]) < 59)) falseRes++;
          r6.push(`${bgAt}/${bgDelay}/${phase} ${r.story.join(",")}`);
        }
      }
    }
    appendFileSync(
      OUT,
      `${JSON.stringify({ tree: TREE, mode: MODE, name: "R6 sweep", lost, bgAlerted, falseRes, firstMin: Math.min(...firsts), firstMax: Math.max(...firsts), firstHist: hist(firsts), rows: r6.slice(0, 0) })}\n`,
    );
    // ---------- R1-rev: BG self-denied ask shortly BEFORE main's real ask ----------
    {
      let wrong = 0;
      let lostRev = 0;
      const firstsRev: number[] = [];
      for (const delta of [300, 500, 800]) {
        for (const bgNext of [3_000, 8_000, 40_000]) {
          for (const phase of [0, 1_000, 2_000, 3_000, 4_000]) {
            const m = call(null, "rrm");
            const hooks: Array<[number, P]> = [
              ...selfDenied(1_000, BG, "rrbg"),
              [1_000 + delta, m.pre],
              [1_400 + delta, m.req],
              [1_000 + delta + 6_600, notice()],
              [1_000 + bgNext, call(BG, "rrbg2").pre],
              [60_000, m.post],
            ];
            const r = await sim({ hooks, screen: waitingIf((t) => t >= 1_800 + delta && t < 59_000), end: 70_000, phase, watch: [SESSION, BG] });
            if (r.story.some((s) => s.startsWith(`B:${BG.slice(0, 3)}`))) wrong++;
            const mb = r.story.filter((s) => s.startsWith("B:main"));
            if (mb.length === 0) lostRev++;
            else firstsRev.push(Math.round((Number(mb[0]!.split("@")[1]) - (1 + delta / 1000)) * 10) / 10);
          }
        }
      }
      appendFileSync(OUT, `${JSON.stringify({ tree: TREE, mode: MODE, name: "R1-rev sweep (45)", bgNamed: wrong, mainLost: lostRev, firstAfterPre: hist(firstsRev) })}\n`);
    }
    // ---------- self-denied BG ask alone ----------
    for (const [label, scr] of [
      ["busy", (() => ["busy"]) as Screen],
      ["idle", (() => ["idle"]) as Screen],
    ] as Array<[string, Screen]>) {
      for (const bgNext of [3_000, 40_000]) {
        const hooks: Array<[number, P]> = [...selfDenied(500, BG, "solo"), [500 + bgNext, call(BG, "solo2").pre]];
        emit(`selfdenied-alone listing=${label} bgNext=${bgNext}`, await sim({ hooks, screen: scr, end: 60_000, phase: 1_000, watch: [SESSION, BG] }));
      }
    }
    // ---------- stale self-denied ask, then a real main dialog answered early (dwell bypass?) ----------
    {
      const rows: string[] = [];
      let falseAlerts = 0;
      let runs = 0;
      for (const ansAt of [2_000, 3_000, 4_000]) {
        for (const phase of [0, 500, 1_000, 1_500, 2_000, 2_500, 3_000, 3_500, 4_000, 4_500]) {
          const m = call(null, "stm");
          const hooks: Array<[number, P]> = [
            ...selfDenied(0, BG, "stbg"),
            [3_000, m.pre],
            [3_400, m.req],
            [3_800 + ansAt + 200, m.post], // approved, quick tool
          ];
          const r = await sim({ hooks, screen: waitingIf((t) => t >= 3_800 && t < 3_800 + ansAt), end: 40_000, phase, watch: [SESSION] });
          runs++;
          if (r.story.some((s) => s.startsWith("B:"))) falseAlerts++;
          rows.push(`${ansAt}/${phase} ${r.story.join(",")}`);
        }
      }
      appendFileSync(OUT, `${JSON.stringify({ tree: TREE, mode: MODE, name: "stale-ask + answered at 2-4 s (30 runs)", falseAlerts, runs, rows })}\n`);
    }
  }, 900_000);

  it("baselines and discriminators", async () => {
    // (i) lone dialog latency, 10 phases x 2 Notification times; plus no Notification at 6 s (user typing)
    for (const [label, notAt] of [
      ["N6.4", 6_400],
      ["N6.8", 6_800],
      ["typing N12.8", 12_800],
    ] as Array<[string, number]>) {
      const lat: number[] = [];
      for (let phase = 0; phase < 5_000; phase += 500) {
        const m = call(null, "lone");
        const hooks: Array<[number, P]> = [
          [0, m.pre],
          [400, m.req],
          [notAt, notice()],
          [40_500, m.post],
        ];
        const r = await sim({ hooks, screen: waitingIf((t) => t >= 800 && t < 40_000), end: 45_000, phase });
        const b = r.story.find((s) => s.startsWith("B:"));
        lat.push(b ? Math.round((Number(b.split("@")[1]) - 0.8) * 10) / 10 : -1);
      }
      appendFileSync(OUT, `${JSON.stringify({ tree: TREE, mode: MODE, name: `(i) lone ${label}: alert s after visible`, lat: hist(lat) })}\n`);
    }
    // (ii) Esc at 20 s
    {
      const res: string[] = [];
      for (let phase = 0; phase < 5_000; phase += 1_000) {
        const m = call(null, "esc");
        const hooks: Array<[number, P]> = [
          [0, m.pre],
          [400, m.req],
          [6_600, notice()],
        ];
        const r = await sim({ hooks, screen: (t) => (t >= 800 && t < 20_000 ? ["waiting", DIALOG] : ["idle"]), end: 90_000, phase });
        res.push(r.story.join(","));
      }
      appendFileSync(OUT, `${JSON.stringify({ tree: TREE, mode: MODE, name: "(ii) Esc at 20", stories: res })}\n`);
    }
    // early answers: Esc / approve-with-long-tool at 1..5.5 s after visible, 10 phases each
    for (const kind of ["esc", "approve-long"]) {
      const out: Record<string, number> = {};
      for (const ans of [1_000, 2_000, 3_000, 4_000, 4_500, 5_500]) {
        let alerts = 0;
        for (let phase = 0; phase < 5_000; phase += 500) {
          const m = call(null, "early");
          const hooks: Array<[number, P]> = [
            [0, m.pre],
            [400, m.req],
            ...(kind === "approve-long" ? ([[120_000, m.post]] as Array<[number, P]>) : []),
          ];
          const up = (t: number) => t >= 800 && t < 800 + ans;
          const r = await sim({
            hooks,
            screen: (t) => (up(t) ? ["waiting", DIALOG] : [kind === "esc" ? "idle" : "busy"]),
            end: 30_000,
            phase,
          });
          if (r.story.some((s) => s.startsWith("B:"))) alerts++;
        }
        out[`ans${ans / 1000}`] = alerts;
      }
      appendFileSync(OUT, `${JSON.stringify({ tree: TREE, mode: MODE, name: `early ${kind}: alerts /10 phases`, out })}\n`);
    }
    // (iii) approve at 20 s, tool runs to 200 s
    {
      const m = call(null, "long");
      const hooks: Array<[number, P]> = [
        [0, m.pre],
        [400, m.req],
        [6_600, notice()],
        [200_000, m.post],
      ];
      emit("(iii) approve@20 long tool to 200", await sim({ hooks, screen: waitingIf((t) => t >= 800 && t < 20_000), end: 210_000, phase: 2_000 }));
    }
    // (v) subagent's dialog approved at 30 s, its tool runs to 200 s
    {
      const spawn = call(null, "vspawn", "Agent");
      const sub = call(SUB, "vsub");
      const hooks: Array<[number, P]> = [
        [0, spawn.pre],
        [1_000, sub.pre],
        [1_400, sub.req],
        [7_600, notice()],
        [200_000, sub.post],
        [200_500, subStop(SUB)],
        [201_000, spawn.post],
      ];
      emit("(v) sub dialog, approved@30, sub tool to 200", await sim({ hooks, screen: waitingIf((t) => t >= 1_800 && t < 30_000), end: 210_000, phase: 2_000, watch: [SESSION, SUB] }));
    }
    // NEW fan-out: main runs two Agent calls; SUB1's dialog 2.4..60; SUB2 finishes at 15 s (after the Notification)
    for (const sub2Done of [15_000, 30_000]) {
      const sp1 = call(null, "fo1", "Agent");
      const sp2 = call(null, "fo2", "Agent");
      const s1 = call(SUB, "fos1");
      const s2 = call(SUB2, "fos2");
      const hooks: Array<[number, P]> = [
        [0, sp1.pre],
        [0, sp2.pre],
        [1_000, s2.pre],
        [2_000, s1.pre],
        [2_000, s1.req],
        [8_800, notice()],
        [sub2Done - 500, s2.post],
        [sub2Done - 100, subStop(SUB2)],
        [sub2Done, sp2.post],
        [61_000, s1.post],
        [62_000, subStop(SUB)],
        [62_500, sp1.post],
      ];
      emit(`fanout sub2Done=${sub2Done / 1000}`, await sim({ hooks, screen: waitingIf((t) => t >= 2_400 && t < 60_000), end: 70_000, phase: 1_000, watch: [SESSION, SUB, SUB2] }));
    }
    // NEW FileChanged during an announced main dialog (0.8..60)
    {
      const m = call(null, "fc");
      const hooks: Array<[number, P]> = [
        [0, m.pre],
        [400, m.req],
        [6_600, notice()],
        [10_000, fileChanged],
        [20_000, fileChanged],
        [60_500, m.post],
      ];
      emit("FileChanged at 10,20 during dialog 0.8..60", await sim({ hooks, screen: waitingIf((t) => t >= 800 && t < 60_000), end: 70_000, phase: 2_000 }));
    }
    // NEW identical input: SUB's dialog up 1.8..60; SUB2 runs the same command auto-approved, done at 15 s
    {
      const spawn1 = call(null, "id1", "Agent");
      const spawn2 = call(null, "id2", "Agent");
      const s1 = call(SUB, "idsame");
      const input = s1.pre.tool_input;
      const s2pre = { ...s1.pre, agent_id: SUB2, tool_use_id: "toolu_idother", tool_input: input };
      const s2post = { ...s1.post, agent_id: SUB2, tool_use_id: "toolu_idother", tool_input: input };
      const hooks: Array<[number, P]> = [
        [0, spawn1.pre],
        [0, spawn2.pre],
        [1_000, s1.pre],
        [1_400, s1.req],
        [3_000, s2pre],
        [7_600, notice()],
        [15_000, s2post],
        [60_500, s1.post],
      ];
      emit("identical input, other agent auto-approved", await sim({ hooks, screen: waitingIf((t) => t >= 1_800 && t < 60_000), end: 70_000, phase: 2_000, watch: [SESSION, SUB, SUB2] }));
    }
    // NEW AskUserQuestion after an approved Bash dialog (listing lags: busy for ~6 s, then 'input needed')
    {
      const a = call(null, "aqa");
      const q = call(null, "aqq", "AskUserQuestion");
      const hooks: Array<[number, P]> = [
        [0, a.pre],
        [400, a.req],
        [6_600, notice()],
        [20_500, a.post],
        [21_000, q.pre],
        [21_400, q.req],
        [27_800, notice()],
        [50_500, q.post],
      ];
      const scr: Screen = (t) =>
        t >= 800 && t < 20_000 ? ["waiting", DIALOG] : t >= 28_000 && t < 50_000 ? ["waiting", "input needed"] : ["busy"];
      for (const phase of [0, 2_000, 4_000]) emit(`AskUserQuestion after Bash phase=${phase}`, await sim({ hooks, screen: scr, end: 60_000, phase }));
    }
    // S5: agent_needs_input during an unannounced block, then Esc at 3.5 s
    {
      const m = call(null, "s5");
      const hooks: Array<[number, P]> = [
        [0, m.pre],
        [0, m.req],
        [3_000, notice("agent_needs_input")],
      ];
      emit("S5", await sim({ hooks, screen: (t) => (t >= 400 && t < 3_500 ? ["waiting", DIALOG] : ["idle"]), end: 120_000, phase: 1_000 }));
    }
  }, 900_000);

  it("degraded listing", async () => {
    for (const [label, mk] of [
      ["down", () => ({ polls: [] as Poll[] })],
      ["masked", () => ({})],
    ] as Array<[string, () => { polls?: Poll[] }]>) {
      const masked: Screen = () => ["waiting", "input needed"];
      {
        const m = call(null, "dl");
        const hooks: Array<[number, P]> = [[0, m.pre], [400, m.req], [6_600, notice()], [20_500, m.post]];
        emit(`${label}: lone approve@20`, await sim({ hooks, screen: masked, end: 40_000, phase: 1_000, ...mk() }));
      }
      {
        const m = call(null, "de");
        const hooks: Array<[number, P]> = [[0, m.pre], [400, m.req], [6_600, notice()]];
        emit(`${label}: lone Esc@20 (nothing after)`, await sim({ hooks, screen: masked, end: 90_000, phase: 1_000, ...mk() }));
      }
      {
        const sp1 = call(null, "dfo1", "Agent");
        const sp2 = call(null, "dfo2", "Agent");
        const s1 = call(SUB, "dfos1");
        const s2 = call(SUB2, "dfos2");
        const hooks: Array<[number, P]> = [
          [0, sp1.pre], [0, sp2.pre], [1_000, s2.pre], [2_000, s1.pre], [2_000, s1.req], [8_800, notice()],
          [14_500, s2.post], [14_900, subStop(SUB2)], [15_000, sp2.post],
          [61_000, s1.post], [62_000, subStop(SUB)], [62_500, sp1.post],
        ];
        emit(`${label}: fanout sub2Done=15`, await sim({ hooks, screen: masked, end: 70_000, phase: 1_000, watch: [SESSION, SUB, SUB2], ...mk() }));
      }
      {
        const spawn = call(null, "dvspawn", "Agent");
        const sub = call(SUB, "dvsub");
        const hooks: Array<[number, P]> = [[0, spawn.pre], [1_000, sub.pre], [1_400, sub.req], [7_600, notice()], [90_000, sub.post], [90_500, subStop(SUB)], [91_000, spawn.post]];
        emit(`${label}: (v) sub approved@30 tool to 90`, await sim({ hooks, screen: masked, end: 100_000, phase: 1_000, watch: [SESSION, SUB], ...mk() }));
      }
    }
  }, 600_000);

  it("missed poll", async () => {
    // No poll runs between the dialog's opening and its Notification (a failed or slow listing spawn);
    // approved at 8 s, the tool runs to 100 s; the listing reads busy from 10 s.
    const m = call(null, "mp");
    const hooks: Array<[number, P]> = [[0, m.pre], [400, m.req], [6_600, notice()], [100_000, m.post]];
    const polls: Poll[] = [];
    polls.push({ begun: 0, land: 300, s: ["busy"] });
    for (let b = 10_000; b <= 110_000; b += 5_000) polls.push({ begun: b, land: b + 300, s: ["busy"] });
    emit("missed poll: approve@8, long tool", await sim({ hooks, screen: () => ["busy"], polls, end: 110_000 }));
  }, 60_000);

  it("question lag", async () => {
    // AskUserQuestion alone: the listing reads busy until `lag`, then waiting/"input needed"; Notification at 6.6 s; answered at 30 s.
    for (const lag of [7_000, 8_000]) {
      let lost = 0;
      let falseRes = 0;
      const rows: string[] = [];
      for (let phase = 0; phase < 5_000; phase += 500) {
        const q = call(null, "ql", "AskUserQuestion");
        const hooks: Array<[number, P]> = [[0, q.pre], [400, q.req], [6_600, notice()], [30_500, q.post]];
        const scr: Screen = (t) => (t >= lag && t < 30_000 ? ["waiting", "input needed"] : ["busy"]);
        const r = await sim({ hooks, screen: scr, end: 40_000, phase });
        if (!r.story.some((x) => x.startsWith("B:"))) lost++;
        if (r.story.some((x) => x.startsWith("R:") && Number(x.split("@")[1]) < 30)) falseRes++;
        rows.push(`${phase}: ${r.story.join(",")}`);
      }
      appendFileSync(OUT, `${JSON.stringify({ tree: TREE, mode: MODE, name: `question lag=${lag / 1000}`, lost, falseRes, rows })}\n`);
    }
  }, 120_000);
});

function hist(xs: number[]): Record<string, number> {
  const h: Record<string, number> = {};
  for (const x of xs) h[String(x)] = (h[String(x)] ?? 0) + 1;
  return h;
}
