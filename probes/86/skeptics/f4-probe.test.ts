/** VR3 F4 refutation probe — runs unchanged on 07c3935 and 96d3367. */
import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type AstirEvent, CONTRACT_VERSION } from "../src/contract/event.js";
import * as sessions from "../src/discovery/sessions.js";
import { Registry } from "../src/model/registry.js";

const LOG = process.env.F4_LOG ?? "/dev/null";
const TAG = process.env.F4_TAG ?? "?";
const say = (l: string) => appendFileSync(LOG, `[${TAG}] ${l}\n`);

// biome-ignore lint/suspicious/noExplicitAny: probe works on both commits
const claudeScreen = (sessions as any).claudeScreen as
  | ((s: string | null, w: string | null) => unknown)
  | undefined;

const S = "sess-f4";
const SUB = "sub-dead";
const SUB2 = "sub-prompt";

function mk(provider: "claude" | "codex") {
  let t = 0;
  let seq = 0;
  const r = new Registry({ nowMs: () => t });
  const ev = (over: Partial<AstirEvent>): AstirEvent => ({
    v: CONTRACT_VERSION,
    eventId: `f${++seq}`,
    provider,
    sessionId: S,
    ts: t,
    kind: "pre_tool",
    agentId: S,
    agentType: null,
    parentAgentId: null,
    parentSource: null,
    tool: "Bash",
    description: null,
    paths: [],
    op: null,
    ok: null,
    notificationKind: null,
    ...over,
  });
  const at = (ms: number) => {
    t = ms;
  };
  const apply = (over: Partial<AstirEvent>) => r.apply(ev(over), "/repo");
  const poll = (status: string | null, waitingFor: string | null) => {
    const screen = claudeScreen?.(status, waitingFor);
    const row = {
      sessionId: S,
      cwd: "/repo",
      pid: 4242,
      status,
      name: "repo",
      startedAt: null,
      ...(screen === undefined ? {} : { screen }),
    };
    // biome-ignore lint/suspicious/noExplicitAny: shape differs by commit
    r.reconcile([row as any], { provider: "claude", complete: true, observedAt: t } as any);
  };
  const ag = (id: string) => r.get(S)?.agents.get(id);
  return { r, at, apply, poll, ag, now: () => t };
}

describe("F4 probe", () => {
  it("P1 claude: SUB2 blocked on its own prompt (explicitly attributed), SUB silent since 5 s", () => {
    const h = mk("claude");
    h.at(0);
    h.apply({ kind: "pre_tool", tool: "Agent" }); // main runs the Agent tool
    h.at(100);
    h.apply({ agentId: SUB, kind: "pre_tool", tool: "Bash" });
    h.at(5_000);
    h.apply({ agentId: SUB, kind: "post_tool", tool: "Bash" }); // last event; SubagentStop lost
    h.at(10_000);
    h.apply({ agentId: SUB2, kind: "pre_tool", tool: "Bash" });
    h.apply({ agentId: SUB2, kind: "notification", tool: null, notificationKind: "permission_prompt" });
    const marks: string[] = [];
    for (let a = 11_000; a <= 600_000; a += 5_000) {
      h.at(a + 300);
      h.poll("waiting", "permission prompt");
      h.at(a + 1_000);
      h.r.tick();
      if ([31_000, 46_000, 61_000, 301_000, 596_000].includes(a)) {
        marks.push(
          `t=${(a + 1_000) / 1000}s main=${h.ag(S)?.state} SUB=${h.ag(SUB)?.state}(active=${h.ag(SUB)?.activeMs}) SUB2=${h.ag(SUB2)?.state}`,
        );
      }
    }
    for (const m of marks) say(`P1 ${m}`);
    // SUB2 answers: its own post_tool, listing busy then idle.
    h.at(602_000);
    h.apply({ agentId: SUB2, kind: "post_tool", tool: "Bash" });
    h.at(603_000);
    h.apply({ agentId: SUB2, kind: "subagent_stop", tool: null, ok: true });
    h.at(605_000);
    h.apply({ kind: "post_tool", tool: "Agent" });
    h.at(606_000);
    h.apply({ kind: "stop", tool: null });
    for (let a = 610_000; a <= 700_000; a += 5_000) {
      h.at(a + 300);
      h.poll("idle", null);
      h.at(a + 1_000);
      h.r.tick();
    }
    say(
      `P1 end t=701s main=${h.ag(S)?.state} SUB=${h.ag(SUB)?.state} SUB.activeMs=${h.ag(SUB)?.activeMs} SUB.turnMs=${h.ag(SUB)?.turnMs}`,
    );
    expect(true).toBe(true);
  });

  it("P2 claude: main blocked on agent_needs_input (no listing end), SUB silent since 5 s, 1 h", () => {
    const h = mk("claude");
    h.at(0);
    h.apply({ kind: "pre_tool", tool: "Agent" });
    h.at(100);
    h.apply({ agentId: SUB, kind: "pre_tool", tool: "Bash" });
    h.at(5_000);
    h.apply({ agentId: SUB, kind: "post_tool", tool: "Bash" });
    h.at(6_000);
    h.apply({ kind: "notification", tool: null, notificationKind: "agent_needs_input" });
    say(`P2 t=6s main=${h.ag(S)?.state}`);
    for (let a = 10_000; a <= 3_600_000; a += 5_000) {
      h.at(a + 300);
      h.poll("idle", null);
      h.at(a + 1_000);
      h.r.tick();
      if (a === 30_000 || a === 60_000 || a === 3_600_000)
        say(
          `P2 t=${(a + 1000) / 1000}s main=${h.ag(S)?.state}(${h.ag(S)?.blockedReason ?? ""}) SUB=${h.ag(SUB)?.state}(active=${h.ag(SUB)?.activeMs})`,
        );
    }
    expect(true).toBe(true);
  });

  it("P3 codex: main blocked, sibling silent 16 min (no listing)", () => {
    const h = mk("codex");
    h.at(0);
    h.apply({ agentId: SUB, kind: "post_tool", tool: "shell" });
    h.apply({ kind: "notification", tool: null, notificationKind: "permission_prompt" });
    h.at(16 * 60_000);
    h.r.tick();
    say(`P3 t=16min main=${h.ag(S)?.state} SUB=${h.ag(SUB)?.state}`);
    expect(true).toBe(true);
  });

  it("P4 control: no block; listing waiting (e.g. turn ended input needed), SUB silent", () => {
    const h = mk("claude");
    h.at(0);
    h.apply({ kind: "pre_tool", tool: "Agent" });
    h.at(100);
    h.apply({ agentId: SUB, kind: "pre_tool", tool: "Bash" });
    h.at(5_000);
    h.apply({ agentId: SUB, kind: "post_tool", tool: "Bash" });
    for (let a = 10_000; a <= 60_000; a += 5_000) {
      h.at(a + 300);
      h.poll("idle", null);
      h.at(a + 1_000);
      h.r.tick();
    }
    say(`P4 t=61s main=${h.ag(S)?.state} SUB=${h.ag(SUB)?.state}`);
    expect(true).toBe(true);
  });
  it("P5 counter-case: SUB genuinely running a long tool while SUB2 is blocked", () => {
    const h = mk("claude");
    h.at(0);
    h.apply({ kind: "pre_tool", tool: "Agent" });
    h.at(5_000);
    h.apply({ agentId: SUB, kind: "pre_tool", tool: "Bash" }); // a 10-minute build, no events until it ends
    h.at(10_000);
    h.apply({ agentId: SUB2, kind: "pre_tool", tool: "Bash" });
    h.apply({ agentId: SUB2, kind: "notification", tool: null, notificationKind: "permission_prompt" });
    for (let a = 11_000; a <= 121_000; a += 5_000) {
      h.at(a + 300);
      h.poll("waiting", "permission prompt");
      h.at(a + 1_000);
      h.r.tick();
    }
    say(`P5 t=122s SUB(live build)=${h.ag(SUB)?.state} main=${h.ag(S)?.state}`);
    expect(true).toBe(true);
  });
});
