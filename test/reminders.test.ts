/**
 * PSH-02 (#98) — how often a blocked agent is reminded is a setting, and the
 * default is calm.
 *
 * The one schedule astir had (now `insistent`) sent 32 alerts in a block's
 * first 90 minutes, and in use that was too many. `calm` re-alerts at +10 and
 * +30 minutes, then hourly; `off` sends the first alert only. The choice is
 * `notify.reminders` in `~/.astir/config.json`, `ASTIR_REMINDERS` overrides it,
 * and a running daemon picks up an edit without a restart.
 *
 * The schedules are driven through the real `NotifyLoop` at the daemon's 1 s
 * tick on a fake clock: sampling the policy at hand-picked instants would let a
 * stale `lastAt` fake a pass, and the loop is what decides when a person hears.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configPath } from "../src/config/paths.js";
import { daemonReminders, describeReminders } from "../src/config/plugin.js";
import { readReminders, remindersSource, reportReminders } from "../src/config/reminders.js";
import { type AstirEvent, CONTRACT_VERSION, type Kind } from "../src/contract/event.js";
import { Daemon } from "../src/daemon/server.js";
import { Registry } from "../src/model/registry.js";
import { Dispatcher } from "../src/notify/dispatch.js";
import { NotifyLoop } from "../src/notify/loop.js";
import { NotifyPolicy, type ReminderSchedule } from "../src/notify/policy.js";

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

let seq = 0;
function ev(kind: Kind, over: Partial<AstirEvent> = {}): AstirEvent {
  seq++;
  return {
    v: CONTRACT_VERSION,
    eventId: `rem${seq}`,
    provider: "claude",
    sessionId: "s1",
    ts: 1_786_900_000 + seq,
    kind,
    agentId: "s1",
    agentType: null,
    parentAgentId: null,
    parentSource: null,
    tool: null,
    description: null,
    paths: [],
    op: null,
    ok: null,
    notificationKind: null,
    ...over,
  };
}

/**
 * The real loop, on a fake clock, with the dwell (PSH-16) at zero so the
 * first alert lands at t=0 and every later one reads as its offset from it.
 */
function rig(policy: NotifyPolicy = new NotifyPolicy(), clock = { t: 0 }) {
  const now = () => clock.t;
  const sent: { kind: string; at: number }[] = [];
  const registry = new Registry({ nowMs: now });
  const loop = new NotifyLoop({
    registry,
    policy,
    dispatcher: new Dispatcher([
      {
        name: "test",
        live: () => true,
        deliver: async (envelope) => {
          sent.push({ kind: envelope.kind, at: clock.t });
          return { ok: true };
        },
      },
    ]),
    now,
    dwellMs: () => 0,
  });
  return {
    sent,
    block: () => registry.apply(ev("notification", { notificationKind: "permission_prompt" }), "/repo"),
    work: () => registry.apply(ev("pre_tool"), "/repo"),
    /** One pulse at `ms`, with nothing in between: a machine that slept. */
    pulseAt: async (ms: number) => {
      clock.t = ms;
      await loop.pulse();
    },
    /** Pulse every second up to and including `ms`, as the daemon's tick does. */
    runTo: async (ms: number) => {
      while (clock.t < ms) {
        clock.t += SEC;
        await loop.pulse();
      }
    },
    /** When each `blocked` alert went out, in ms from t=0. */
    alertsAt: () => sent.filter((s) => s.kind === "blocked").map((s) => s.at),
    /** The same, in minutes, for schedules that land on whole minutes. */
    alertMinutes: () => sent.filter((s) => s.kind === "blocked").map((s) => s.at / MIN),
  };
}

/** `from`, `from + step`, … up to and including `to`. */
const range = (from: number, to: number, step: number): number[] => {
  const out: number[] = [];
  for (let m = from; m <= to; m += step) out.push(m);
  return out;
};

describe("PSH-02 — the reminder schedules, through the real loop", () => {
  it("PSH-02 — calm re-alerts at +10, +30, then hourly, 26 alerts in 24h", async () => {
    // A bare policy, as every caller that does not choose gets: calm is the
    // default.
    const r = rig();
    r.block();
    await r.pulseAt(0);
    await r.runTo(24 * HOUR);
    expect(r.alertMinutes()).toEqual([0, 10, 30, ...range(90, 1410, 60)]);
    expect(r.alertMinutes()).toHaveLength(26);
  });

  it("PSH-02 — insistent is the old schedule, unchanged: 32 alerts in the first 90 minutes", async () => {
    const r = rig(new NotifyPolicy({ reminders: "insistent" }));
    r.block();
    await r.pulseAt(0);
    await r.runTo(24 * HOUR);
    // Every minute to 10, every 2 to 30, every 5 to 90, then every 15 — each
    // measured from the reminder before it, so a phase's first reminder comes
    // one of its own gaps after the last of the phase before.
    expect(r.alertMinutes()).toEqual([
      ...range(0, 9, 1),
      ...range(11, 29, 2),
      ...range(34, 89, 5),
      ...range(104, 1439, 15),
    ]);
    expect(r.alertMinutes().filter((m) => m <= 90)).toHaveLength(32);
  });

  it("PSH-02 — off alerts once, and the block's end still sends its resolved doorbell", async () => {
    const r = rig(new NotifyPolicy({ reminders: "off" }));
    r.block();
    await r.pulseAt(0);
    await r.runTo(3 * HOUR);
    expect(r.alertMinutes()).toEqual([0]);

    // Without it a receiver on another machine keeps the agent listed as
    // waiting for good: `off` turns off reminders, not the doorbell.
    r.work();
    await r.runTo(3 * HOUR + SEC);
    expect(r.sent.map((s) => s.kind)).toEqual(["blocked", "resolved"]);
  });

  it("PSH-02 — under calm, a late poll fires one reminder, not a burst", async () => {
    // The machine slept from just after the first alert to +45 minutes: both
    // +10 and +30 are overdue, and one reminder covers them. The next is an
    // hour after that one, not an hour after +30.
    const r = rig();
    r.block();
    await r.pulseAt(0);
    await r.pulseAt(45 * MIN);
    await r.runTo(3 * HOUR);
    expect(r.alertMinutes()).toEqual([0, 45, 105, 165]);
  });

  it("PSH-02 — under calm, a late +10 moves +30 along rather than letting it follow at once", async () => {
    // Every step is measured from the reminder sent before it: +10 is ten
    // minutes after the first alert, +30 twenty after +10. Counted from the
    // first alert instead, a +10 that a late poll sent at 29:59 was followed
    // by +30 a second later.
    const r = rig();
    r.block();
    await r.pulseAt(0);
    await r.pulseAt(30 * MIN - SEC);
    await r.runTo(2 * HOUR);
    expect(r.alertsAt()).toEqual([0, 30 * MIN - SEC, 50 * MIN - SEC, 110 * MIN - SEC]);

    const mid = rig();
    mid.block();
    await mid.pulseAt(0);
    await mid.pulseAt(15 * MIN);
    await mid.runTo(100 * MIN);
    expect(mid.alertMinutes()).toEqual([0, 15, 35, 95]);
  });

  it("PSH-02 — under insistent, a late poll fires one reminder, not a burst", async () => {
    // Slept through eight one-minute reminders: one fires, then the cadence
    // resumes from it.
    const r = rig(new NotifyPolicy({ reminders: "insistent" }));
    r.block();
    await r.pulseAt(0);
    await r.pulseAt(8 * MIN);
    await r.runTo(10 * MIN);
    expect(r.alertMinutes()).toEqual([0, 8, 9]);
  });

  it.each(["calm", "insistent", "off"] as const)(
    "PSH-02 — %s ends at 24h: a block still standing is not announced again",
    async (schedule) => {
      // The policy forgets an entry once it is a day old. Forgetting one whose
      // agent is still blocked read it as new on the next pulse: a fresh first
      // alert, and the whole schedule over again.
      const r = rig(new NotifyPolicy({ reminders: schedule }));
      r.block();
      await r.pulseAt(0);
      await r.runTo(24 * HOUR);
      const atDayEnd = r.alertMinutes().length;
      await r.runTo(26 * HOUR);
      expect(r.alertMinutes()).toHaveLength(atDayEnd);
      expect(r.alertMinutes().every((m) => m < 24 * 60)).toBe(true);
    },
  );

  it("PSH-02 — a new block after one has ended starts its schedule from the start", async () => {
    const r = rig();
    r.block();
    await r.pulseAt(0);
    await r.runTo(31 * MIN);
    r.work();
    await r.runTo(40 * MIN);
    r.block();
    await r.runTo(60 * MIN);
    // The new block is first seen on the pulse a second after it began.
    expect(r.alertsAt()).toEqual([0, 10 * MIN, 30 * MIN, 40 * MIN + SEC, 50 * MIN + SEC]);
  });

  it("PSH-02 — the schedule is read at each decision, so a change applies to a block in progress", async () => {
    // Insistent for the first five minutes, then the setting changes to calm:
    // the next reminder is calm's +10 step, measured from the last reminder
    // sent, and +30's twenty minutes after that.
    let schedule: ReminderSchedule = "insistent";
    const r = rig(new NotifyPolicy({ reminders: () => schedule }));
    r.block();
    await r.pulseAt(0);
    await r.runTo(5 * MIN);
    schedule = "calm";
    await r.runTo(40 * MIN);
    schedule = "off";
    await r.runTo(3 * HOUR);
    expect(r.alertMinutes()).toEqual([0, 1, 2, 3, 4, 5, 15, 35]);
  });

  it("PSH-02 — calm is the default", () => {
    // Pinned on the policy itself too: the daemon is not the only caller.
    const calm = new NotifyPolicy();
    const chosen = new NotifyPolicy({ reminders: "calm" });
    for (const p of [calm, chosen]) p.shouldNotify("k", "blocked", 0);
    for (let t = SEC; t <= 2 * HOUR; t += SEC) {
      expect(calm.shouldNotify("k", "blocked", t), `t=${t}`).toBe(chosen.shouldNotify("k", "blocked", t));
    }
    expect(calm.sentCount("k")).toBe(4);
  });
});

describe("PSH-02 — the setting: notify.reminders in ~/.astir/config.json", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });
  /** A fresh home, with `config` as its ~/.astir/config.json when given. */
  const home = (config?: string): string => {
    const h = mkdtempSync(join(tmpdir(), "astir-reminders-"));
    homes.push(h);
    if (config !== undefined) {
      mkdirSync(join(h, ".astir"), { recursive: true });
      writeFileSync(configPath(h), config);
    }
    return h;
  };

  it("PSH-02 — the file is ~/.astir/config.json", () => {
    expect(configPath("/h")).toBe("/h/.astir/config.json");
  });

  it("PSH-02 — no file, or no key, is calm from the default", () => {
    expect(readReminders({ home: home(), env: {} })).toEqual({ schedule: "calm", source: "default" });
    expect(readReminders({ home: home("{}"), env: {} })).toEqual({ schedule: "calm", source: "default" });
    expect(readReminders({ home: home('{"notify": {}}'), env: {} })).toEqual({
      schedule: "calm",
      source: "default",
    });
  });

  it.each(["off", "calm", "insistent"] as const)(
    "PSH-02 — reads %s from the nested notify.reminders key",
    (s) => {
      const h = home(JSON.stringify({ notify: { reminders: s } }));
      expect(readReminders({ home: h, env: {} })).toEqual({ schedule: s, source: "config" });
    },
  );

  it("PSH-02 — a literal dotted key is not the setting", () => {
    // `notify.reminders` is a path, as the config's other sections are
    // (`hub.ssh`, `hub.url`): one spelling, not two.
    const h = home('{"notify.reminders": "off"}');
    expect(readReminders({ home: h, env: {} })).toEqual({ schedule: "calm", source: "default" });
  });

  it("PSH-02 — ASTIR_REMINDERS wins over the file", () => {
    const h = home('{"notify": {"reminders": "off"}}');
    expect(readReminders({ home: h, env: { ASTIR_REMINDERS: "insistent" } })).toEqual({
      schedule: "insistent",
      source: "env",
    });
    // Empty is unset, as a shell's `ASTIR_REMINDERS=` means.
    expect(readReminders({ home: h, env: { ASTIR_REMINDERS: "" } })).toEqual({
      schedule: "off",
      source: "config",
    });
  });

  it("PSH-02 — an unknown value runs calm, and says which value it refused", () => {
    expect(readReminders({ home: home('{"notify": {"reminders": "loud"}}'), env: {} })).toEqual({
      schedule: "calm",
      source: "config",
      rejected: "loud",
    });
    // Not a string at all: refused the same way, shown as written.
    expect(readReminders({ home: home('{"notify": {"reminders": 5}}'), env: {} })).toEqual({
      schedule: "calm",
      source: "config",
      rejected: "5",
    });
    // Case matters: the values are identifiers, as the spec spells them.
    expect(readReminders({ home: home(), env: { ASTIR_REMINDERS: "Calm" } })).toEqual({
      schedule: "calm",
      source: "env",
      rejected: "Calm",
    });
    // An unknown ASTIR_REMINDERS falls back to calm, not to the file.
    const h = home('{"notify": {"reminders": "off"}}');
    expect(readReminders({ home: h, env: { ASTIR_REMINDERS: "loud" } })).toEqual({
      schedule: "calm",
      source: "env",
      rejected: "loud",
    });
  });

  it("PSH-02 — a file that is not JSON runs calm, and says why", () => {
    const got = readReminders({ home: home("{ notify: "), env: {} });
    expect(got.schedule).toBe("calm");
    expect(got.source).toBe("default");
    expect(got.problem).toMatch(/not valid JSON/);
  });

  it("PSH-02 — any other shape of file is read without complaint", () => {
    for (const body of ["[]", '"calm"', "null", '{"notify": "calm"}', '{"notify": ["calm"]}']) {
      expect(readReminders({ home: home(body), env: {} }), body).toEqual({
        schedule: "calm",
        source: "default",
      });
    }
  });

  it("PSH-02 — reading never touches the file, or any other key in it", () => {
    // The file is the ADE plan's too (`v`, `hub`, `spaces`): this reader only
    // reads.
    const body = `{"v": {"major": 1, "minor": 0}, "hub": {"ssh": "megabrain"}, "notify": {"reminders": "off", "x": 1}}\n`;
    const h = home(body);
    const before = readFileSync(configPath(h), "utf8");
    readReminders({ home: h, env: {} });
    const get = remindersSource({ home: h, env: {}, now: () => 0 });
    get();
    expect(readFileSync(configPath(h), "utf8")).toBe(before);
  });
});

describe("PSH-02 — a running daemon picks up an edited file without a restart", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });
  const freshHome = (): string => {
    const h = mkdtempSync(join(tmpdir(), "astir-reminders-live-"));
    homes.push(h);
    mkdirSync(join(h, ".astir"), { recursive: true });
    return h;
  };
  /** Write the file and give it an mtime of its own, so two writes in one millisecond still differ. */
  let stamp = 1_700_000_000;
  const write = (h: string, schedule: string): void => {
    writeFileSync(configPath(h), JSON.stringify({ notify: { reminders: schedule } }));
    stamp += 10;
    utimesSync(configPath(h), stamp, stamp);
  };

  it("PSH-02 — re-reads on an mtime change, checked at most every 5s", () => {
    const h = freshHome();
    write(h, "insistent");
    let t = 0;
    const get = remindersSource({ home: h, env: {}, now: () => t });
    expect(get()).toEqual({ schedule: "insistent", source: "config" });

    write(h, "off");
    t = 4_999;
    // Not looked at yet: the last check was under 5 s ago.
    expect(get().schedule).toBe("insistent");
    t = 5_000;
    expect(get()).toEqual({ schedule: "off", source: "config" });
  });

  it("PSH-02 — a file that appears, or goes away, is noticed too", () => {
    const h = freshHome();
    let t = 0;
    const get = remindersSource({ home: h, env: {}, now: () => t });
    expect(get()).toEqual({ schedule: "calm", source: "default" });

    write(h, "insistent");
    t += 5_000;
    expect(get()).toEqual({ schedule: "insistent", source: "config" });

    rmSync(configPath(h));
    t += 5_000;
    expect(get()).toEqual({ schedule: "calm", source: "default" });
  });

  it("PSH-02 — ASTIR_REMINDERS still wins over an edited file", () => {
    const h = freshHome();
    write(h, "off");
    let t = 0;
    const get = remindersSource({ home: h, env: { ASTIR_REMINDERS: "insistent" }, now: () => t });
    expect(get()).toEqual({ schedule: "insistent", source: "env" });
    write(h, "calm");
    t += 5_000;
    expect(get()).toEqual({ schedule: "insistent", source: "env" });
  });

  it("PSH-02 — an edited file changes a running loop's schedule, no restart", async () => {
    // The daemon's wiring, on a fake clock: the policy asks the source at each
    // decision, and the source re-reads the file.
    const h = freshHome();
    write(h, "insistent");
    const clock = { t: 0 };
    const source = remindersSource({ home: h, env: {}, now: () => clock.t });
    const r = rig(new NotifyPolicy({ reminders: () => source().schedule }), clock);
    r.block();
    await r.pulseAt(0);
    await r.runTo(3 * MIN);
    // Edited just after the +3 reminder: the source sees it within 5 s, well
    // before insistent's +4.
    write(h, "off");
    await r.runTo(2 * HOUR);
    expect(r.alertMinutes()).toEqual([0, 1, 2, 3]);
  });
});

describe("PSH-02 — doctor shows the schedule in force and where it came from", () => {
  const PATH = "/home/u/.astir/config.json";
  const text = (lines: string[]) => lines.join("\n");

  it("names the schedule, where it came from, and what it does", () => {
    const calm = text(
      describeReminders(
        { schedule: "calm", source: "default" },
        { schedule: "calm", source: "default" },
        PATH,
      ),
    );
    expect(calm).toMatch(/^ {2}reminders {7}calm, the default/);
    expect(calm).toContain("+10 and +30 min, then hourly");
    // The default is the case where nobody has seen the setting yet.
    expect(calm).toContain('"notify": { "reminders": "off" | "calm" | "insistent" }');
    expect(calm).toContain(PATH);

    const fromFile = text(
      describeReminders(
        { schedule: "insistent", source: "config" },
        { schedule: "insistent", source: "config" },
        PATH,
      ),
    );
    expect(fromFile).toContain(`insistent, from ${PATH}`);
    expect(fromFile).not.toContain('"notify": {');

    const fromEnv = text(
      describeReminders({ schedule: "off", source: "env" }, { schedule: "off", source: "env" }, PATH),
    );
    expect(fromEnv).toContain("off, from ASTIR_REMINDERS");
    expect(fromEnv).toContain("the first alert only");
  });

  it("an unknown value: says it is not a schedule, and that calm runs", () => {
    const out = text(
      describeReminders(
        { schedule: "calm", source: "config", rejected: "loud" },
        { schedule: "calm", source: "config", fellBack: true },
        PATH,
      ),
    );
    expect(out).toContain(`"loud" in ${PATH} is not a schedule`);
    expect(out).toContain("off, calm or insistent");
    expect(out).toMatch(/calm/);

    const env = text(
      describeReminders(
        { schedule: "calm", source: "env", rejected: "loud" },
        { schedule: "calm", source: "env", fellBack: true },
        PATH,
      ),
    );
    expect(env).toContain('ASTIR_REMINDERS="loud" is not a schedule');
  });

  it("says so for a daemon's unknown value doctor cannot see itself", () => {
    // The daemon's environment is its own: doctor knows it fell back, not
    // what it was given.
    const out = text(
      describeReminders(
        { schedule: "calm", source: "default" },
        { schedule: "calm", source: "env", fellBack: true },
        PATH,
      ),
    );
    expect(out).toContain("the daemon's ASTIR_REMINDERS is not a schedule");
  });

  it("the daemon's answer wins over this terminal's, and the difference is named", () => {
    // A daemon started by launchd does not see the ASTIR_REMINDERS exported
    // in the terminal doctor runs in.
    const out = text(
      describeReminders(
        { schedule: "insistent", source: "env" },
        { schedule: "calm", source: "default" },
        PATH,
      ),
    );
    expect(out).toMatch(/^ {2}reminders {7}calm, the default/);
    expect(out).toContain("this terminal reads insistent, from ASTIR_REMINDERS");
  });

  it("without the daemon's answer, says the reading is this terminal's", () => {
    const out = text(describeReminders({ schedule: "off", source: "config" }, null, PATH));
    expect(out).toContain(`off, from ${PATH}`);
    expect(out).toMatch(/read here/);
  });

  it("names a config file it could not read", () => {
    const out = text(
      describeReminders(
        { schedule: "calm", source: "default", problem: `${PATH} is not valid JSON` },
        { schedule: "calm", source: "default" },
        PATH,
      ),
    );
    expect(out).toContain(`${PATH} is not valid JSON`);
  });
});

describe("PSH-02 — the daemon says on /healthz which schedule it runs", () => {
  it("reports names only: the schedule, the source, and whether it fell back", () => {
    expect(reportReminders({ schedule: "calm", source: "config", rejected: "loud" })).toEqual({
      schedule: "calm",
      source: "config",
      fellBack: true,
    });
    expect(reportReminders({ schedule: "off", source: "env" })).toEqual({ schedule: "off", source: "env" });
    // A problem reading the file is doctor's to name from its own reading.
    expect(reportReminders({ schedule: "calm", source: "default", problem: "x" })).toEqual({
      schedule: "calm",
      source: "default",
    });
  });

  it("doctor reads it back, and treats anything else as not said", () => {
    expect(daemonReminders({ reminders: { schedule: "off", source: "env" } })).toEqual({
      schedule: "off",
      source: "env",
    });
    expect(daemonReminders({ reminders: { schedule: "calm", source: "config", fellBack: true } })).toEqual({
      schedule: "calm",
      source: "config",
      fellBack: true,
    });
    // An older daemon has no field: that is "cannot tell", never a schedule.
    for (const body of [
      {},
      null,
      "x",
      { reminders: { schedule: "loud", source: "env" } },
      { reminders: { schedule: "off" } },
    ]) {
      expect(daemonReminders(body)).toBeNull();
    }
  });

  it("is on the daemon's /healthz", async () => {
    let schedule: ReminderSchedule = "insistent";
    const daemon = new Daemon({
      token: "t".repeat(64),
      registry: new Registry({ nowMs: () => Date.now() }),
      reminders: () => reportReminders({ schedule, source: "config" }),
    });
    const port = await daemon.listen(0);
    try {
      const get = async () =>
        (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as { reminders?: unknown };
      expect((await get()).reminders).toEqual({ schedule: "insistent", source: "config" });
      // Read per request: a changed file shows without a restart.
      schedule = "off";
      expect((await get()).reminders).toEqual({ schedule: "off", source: "config" });
    } finally {
      await daemon.close();
    }
  });
});
