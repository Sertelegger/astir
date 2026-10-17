/**
 * astir-tui under `claude plugin test tui`: the engine's own `$`, with the
 * world beneath the plugin (astir's CLI, the session id, the file system, the
 * status line, the footer) answered here.
 *
 * Every behaviour the module has is a promise made to someone looking at a
 * terminal, so each test reads what they would see: the status line's text
 * and the footer's label. Nothing here inspects the module's internals.
 */
import type { CommandSpec, On, PaneOpenArgs, ProcessRunResult, RenderElement } from "claude-code";
import { describe, type Engine, expect, type MockClock, mock, test } from "claude-code/testing";

type Answer = (argv: readonly string[]) => ProcessRunResult | Promise<ProcessRunResult>;

interface World {
  clock: MockClock;
  /** Every argv astir was run with, in order. */
  runs: (readonly string[])[];
  /** Every timeout astir was run with, in order. */
  timeouts: (number | undefined)[];
  /** Every status line drawn; `undefined` is the line cleared. */
  statuses: (string | undefined)[];
  /** Every path the plugin asked about. */
  stats: string[];
  /** Every file the plugin read. */
  reads: string[];
  /** Every slash command the plugin registered. */
  registered: CommandSpec[];
  /** Every pane the plugin opened, as it asked. */
  opens: PaneOpenArgs[];
  /** Every pane id the plugin closed. */
  closes: string[];
  /** What astir answers from now on. */
  answer: (fn: Answer) => void;
  /** The session id `$.session.id()` answers from now on (a /clear mints a new one). */
  session: (id: string) => void;
}

/** A warning as the serialiser writes it. */
interface Warning {
  kind: string;
  text: string;
}

/** What the status line draws for astir's line: its own `astir:` lead dropped. */
function drawn(line: string | null): string | undefined {
  return line === null ? undefined : line.replace(/^astir:\s*/, "");
}

/** One of `status --line --json`'s rows, shaped as the serialiser writes it (src/status/line.ts). */
interface LineRow {
  sessionId: string;
  host: string | null;
  label: string;
  state: string | null;
  waitingMs: number | null;
  acknowledged: boolean;
  announced: boolean;
  focusable: boolean;
}

/** What `astir status --line --json` prints, shaped as the serialiser's v1. */
function printed(fields: {
  line: string | null;
  blocked: number;
  warnings?: readonly Warning[];
  v?: { major: number; minor: number };
  rows?: readonly unknown[];
}): string {
  return JSON.stringify({
    v: fields.v ?? { major: 1, minor: 0 },
    line: fields.line,
    blocked: fields.blocked,
    announced: 0,
    warnings: fields.warnings ?? [],
    rows: fields.rows ?? [],
  });
}

/**
 * What astir says in each state where a warning stands, word for word: each
 * one is `statusLine()`'s own output (src/status/line.ts), run for that state,
 * not written by hand. `rows` and `announced` are left to `printed`, and so is
 * `v` where it is 1.0. `contactLost` and `oldDaemon` are line v1.1's, written
 * from its spec's words before src/status/line.ts had them; what these tests
 * read of them is the warning's `kind`.
 */
const SAID = {
  daemonDown: {
    line: "astir: daemon not running — no one will be told",
    blocked: 0,
    warnings: [{ kind: "daemon-down", text: "astir: daemon not running — no one will be told" }],
  },
  timedOut: {
    line: "astir unreachable",
    blocked: 0,
    warnings: [{ kind: "unreachable", text: "astir unreachable" }],
  },
  noToken: {
    line: "astir: no token",
    blocked: 0,
    warnings: [{ kind: "unreachable", text: "astir: no token" }],
  },
  impostor: {
    line: "astir: port 47000 is macbook's daemon, not this machine's",
    blocked: 0,
    warnings: [{ kind: "impostor", text: "astir: port 47000 is macbook's daemon, not this machine's" }],
  },
  notifierHung: {
    line: "astir: notifier not answering",
    blocked: 2,
    warnings: [{ kind: "unreachable", text: "astir: notifier not answering" }],
  },
  noDelivery: {
    line: "astir: nothing can notify you — no notifier is reachable",
    blocked: 2,
    warnings: [{ kind: "no-delivery", text: "astir: nothing can notify you — no notifier is reachable" }],
  },
  silent: {
    line: "astir: hears nothing from this session",
    blocked: 2,
    warnings: [{ kind: "silent", text: "astir: hears nothing from this session" }],
  },
  // Line v1.1. The only agent waiting was on a machine the notifier has lost
  // contact with: its doorbell is not counted, so `blocked` is 0.
  contactLost: {
    line: "astir: lost contact with 1 machine where an agent was waiting",
    blocked: 0,
    v: { major: 1, minor: 1 },
    warnings: [
      { kind: "contact-lost", text: "astir: lost contact with 1 machine where an agent was waiting" },
    ],
  },
  // Line v1.1. A daemon from before /state 2.2 has no `announcedAt`, so the
  // line counts its raw blocks.
  oldDaemon: {
    line: "astir: the daemon is older than this astir — restart it · 2 waiting on you · oldest 3m",
    blocked: 2,
    v: { major: 1, minor: 1 },
    warnings: [{ kind: "old-daemon", text: "astir: the daemon is older than this astir — restart it" }],
  },
} as const;

function exited(stdout: string, exitCode = 0): ProcessRunResult {
  return { exitCode, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false };
}

/**
 * The world beneath the plugin. With `planted`, the folder above the plugin's
 * holds what an astir checkout would: a `.claude-plugin/marketplace.json` that
 * names `./tui` (this folder, under `claude plugin test tui`) as astir-tui's,
 * and a `dist/cli/main.js` that is a file. Anyone can put both beside a plugin folder loaded from a shared /tmp,
 * so nothing found there may decide what runs. With `openRefused`, opening a
 * pane fails.
 */
function world(on: On, opts: { planted?: boolean; openRefused?: boolean } = {}): World {
  const clock = mock.clock(on, { now: 1_000_000 });
  const runs: (readonly string[])[] = [];
  const timeouts: (number | undefined)[] = [];
  const statuses: (string | undefined)[] = [];
  const stats: string[] = [];
  const reads: string[] = [];
  const registered: CommandSpec[] = [];
  const opens: PaneOpenArgs[] = [];
  const closes: string[] = [];
  let answer: Answer = () => exited(printed({ line: null, blocked: 0 }));
  let session = "sess-1";

  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("turn.complete", () => ({ text: "answered" }));
  on("session.id", () => ({ value: session }));
  on("fs.read", (_$, e) => {
    reads.push(e.path);
    if (opts.planted === true && e.path.endsWith("/.claude-plugin/marketplace.json")) {
      // `./tui`: the folder `claude plugin test tui` loads this plugin from.
      return { value: JSON.stringify({ plugins: [{ name: "astir-tui", source: "./tui" }] }) };
    }
    throw new Error(`ENOENT: ${e.path}`);
  });
  on("fs.stat", (_$, e) => {
    stats.push(e.path);
    if (opts.planted === true) return { value: { kind: "file", size: 1, mtimeMs: 0, isLink: false } };
    throw new Error(`ENOENT: ${e.path}`);
  });
  on("process.run", (_$, e) => {
    runs.push(e.argv);
    timeouts.push(e.init?.timeoutMs);
    return Promise.resolve(answer(e.argv)).then((value) => ({ value }));
  });
  on("ui.status", (_$, e) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  on("command.register", (_$, e) => {
    registered.push(e);
    return { value: { command: e.name } };
  });
  on("ui.open", (_$, e) => {
    opens.push(e);
    if (opts.openRefused === true) throw new Error("no room for a pane");
    return { value: { isPlaced: true } };
  });
  on("ui.close", (_$, e) => {
    closes.push(e.id);
    return { value: undefined };
  });
  // The footer as the engine would draw it: its labels joined, as the
  // terminal does, so a test reads exactly what the plugin handed on.
  on("ui.render", { component: "SessionMode" }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return h(Text, {}, e.props.modes.join(" & ")) as RenderElement;
  });

  return {
    clock,
    runs,
    timeouts,
    statuses,
    stats,
    reads,
    registered,
    opens,
    closes,
    answer: (fn) => {
      answer = fn;
    },
    session: (id) => {
      session = id;
    },
  };
}

const SESSION_START = { cwd: "/work", surface: "terminal", isInteractive: true } as const;

async function start($: Engine, w: World): Promise<void> {
  await $.session.start(SESSION_START);
  await w.clock.settle();
}

/** The footer's labels, as drawn beside one the engine already had. */
async function footer($: Engine): Promise<string> {
  const tree = (await $.ui.render({
    component: "SessionMode",
    surface: "terminal",
    requestId: "footer",
    props: { modes: ["focus"] },
  })) as { children: unknown[] };
  return tree.children.join("");
}

/** Everything after the command itself: what astir is asked. */
function asked(argv: readonly string[] | undefined): readonly string[] {
  const at = argv?.indexOf("status") ?? -1;
  return at < 0 ? [] : (argv ?? []).slice(at);
}

describe("polling astir", () => {
  test("a session's start asks once at once, then every five seconds", async ($, on) => {
    const w = world(on);
    await start($, w);
    expect(w.runs).toHaveLength(1);
    await w.clock.advance(4_999);
    expect(w.runs).toHaveLength(1);
    await w.clock.advance(1);
    expect(w.runs).toHaveLength(2);
    await w.clock.advance(5_000);
    expect(w.runs).toHaveLength(3);
  });

  test("a session's start does not wait for astir, so the first prompt is not held", async ($, on) => {
    // The first session.start holds the first prompt; a run may take its
    // whole three seconds, and the person must not wait on it.
    const w = world(on);
    w.answer(async () => {
      await w.clock.sleep(2_000);
      return exited(printed({ line: null, blocked: 1 }));
    });
    let started = false;
    const starting = $.session.start(SESSION_START).then(() => {
      started = true;
    });
    await w.clock.settle();
    expect(w.runs).toHaveLength(1);
    expect(w.statuses).toEqual([]);
    expect(started).toBe(true);

    await w.clock.advance(2_000);
    await starting;
    expect(await footer($)).toBe("focus & astir 1");
  });

  test("session.start firing again in one environment replaces the poll, not adds one", async ($, on) => {
    // A reload re-fires session.start for a module it did not reload; two
    // polls would run astir twice every five seconds for the rest of the session.
    const w = world(on);
    await start($, w);
    await start($, w);
    expect(w.runs).toHaveLength(2);
    await w.clock.advance(5_000);
    expect(w.runs).toHaveLength(3);
    await w.clock.advance(5_000);
    expect(w.runs).toHaveLength(4);
  });

  test("session.start is observed, not answered", async ($, on) => {
    world(on);
    expect(await $.session.start(SESSION_START)).toEqual({ cwd: "/work" });
  });

  test("astir is given three seconds, inside the five-second period", async ($, on) => {
    const w = world(on);
    await start($, w);
    expect(w.timeouts).toEqual([3_000]);
  });

  test("before the session has done any work it is not asked about, so its silence is not a warning", async ($, on) => {
    // A session with no prompt yet is in astir's silent[] legitimately: its
    // hooks have not fired (measured live on 2.1.291). Asking about it would
    // warn "hears nothing from this session" at every fresh start.
    const w = world(on);
    await start($, w);
    expect(asked(w.runs[0])).toEqual(["status", "--line", "--json"]);
  });

  test("once a turn has completed, astir is asked about this session", async ($, on) => {
    const w = world(on);
    await start($, w);
    await $.turn.complete({ answer: "", durationMs: 1, isAborted: false, turnId: "t1", reason: "answer" });
    await w.clock.advance(5_000);
    expect(asked(w.runs.at(-1))).toEqual(["status", "--line", "--json", "--session", "sess-1"]);
  });

  test("a /clear's new session has done no work yet, so it is not asked about", async ($, on) => {
    const w = world(on);
    await start($, w);
    await $.turn.complete({ answer: "", durationMs: 1, isAborted: false, turnId: "t1", reason: "answer" });
    w.session("sess-2");
    await w.clock.advance(5_000);
    expect(asked(w.runs.at(-1))).toEqual(["status", "--line", "--json"]);
  });

  test("turn.complete is observed, never answered", async ($, on) => {
    world(on);
    const done = await $.turn.complete({
      answer: "",
      durationMs: 1,
      isAborted: false,
      turnId: "t1",
      reason: "answer",
    });
    expect(done).toEqual({ text: "answered" });
  });
});

describe("what is drawn", () => {
  test("astir's line is the status line, and its ungated count is in the footer", async ($, on) => {
    const w = world(on);
    w.answer(() => exited(printed({ line: "2 waiting on you · oldest 3m", blocked: 3 })));
    await start($, w);
    expect(w.statuses.at(-1)).toBe("2 waiting on you · oldest 3m");
    // PSH-16: the ambient count is not gated on announcement, so it may
    // exceed the line's.
    expect(await footer($)).toBe("focus & astir 3");
  });

  test("nothing to say clears the line, and the footer still counts", async ($, on) => {
    const w = world(on);
    w.answer(() => exited(printed({ line: null, blocked: 0 })));
    await start($, w);
    expect(w.statuses).toEqual([undefined]);
    expect(await footer($)).toBe("focus & astir 0");
  });

  test("an empty line is no line: the status line is cleared, not drawn blank", async ($, on) => {
    // `$.ui.status("")` would draw the warning sign with nothing after it.
    const w = world(on);
    w.answer(() => exited(printed({ line: "", blocked: 1 })));
    await start($, w);
    w.answer(() => exited(printed({ line: "\u0007\u001b", blocked: 1 })));
    await w.clock.advance(5_000);
    expect(w.statuses).toEqual([undefined, undefined]);
    expect(await footer($)).toBe("focus & astir 1");
  });

  test("before astir has answered, the footer says it does not know", async ($, on) => {
    world(on);
    expect(await footer($)).toBe("focus & astir ?");
  });

  test("control characters in a line are not drawn, C1 and C0 alike", async ($, on) => {
    // The impostor warning carries another daemon's host name; whatever that
    // daemon says about itself must not reach the terminal as escapes. ESC,
    // the one-byte CSI (U+009B), BEL, CR, BS and DEL are all control.
    const w = world(on);
    const host = "\u001b[2Je\u009b2Jv\u0007i\rl\b\u007f";
    w.answer(() => exited(printed({ line: `astir: port 47000 is ${host}'s daemon`, blocked: 0 })));
    await start($, w);
    expect(w.statuses.at(-1)).toBe("port 47000 is [2Je2Jvil's daemon");
  });

  test("astir's own `astir:` lead is dropped: the engine already names the line", async ($, on) => {
    // Drawn live as `⚠ astir-tui: astir: nothing can notify you` before this.
    const w = world(on);
    w.answer(() =>
      exited(printed({ line: "astir: nothing can notify you — no notifier is reachable", blocked: 0 })),
    );
    await start($, w);
    expect(w.statuses.at(-1)).toBe("nothing can notify you — no notifier is reachable");
  });
});

describe("a count astir says is not whole is not drawn as one", () => {
  // In every one of these astir writes `blocked: 0` (or a part of the count),
  // because the JSON has no "unknown". Its warning is what says the count
  // cannot be trusted, and the footer must read it: `astir 0` beside "daemon
  // not running" is the calm a broken state must never wear.
  const unknown: [string, (typeof SAID)[keyof typeof SAID]][] = [
    ["the daemon is not running", SAID.daemonDown],
    ["astir ran out of its budget", SAID.timedOut],
    ["the daemon refuses astir (no token)", SAID.noToken],
    ["another machine's daemon is on the port", SAID.impostor],
    // The local count is real, the other machines' are not known: a part
    // of a total drawn as the total is a wrong total.
    ["the notifier does not answer", SAID.notifierHung],
    // Deliberately not taught to COUNT_STANDS. A machine the notifier lost
    // contact with had an agent waiting whose state is now unknown, so the
    // count is a part, and `astir 0` would be the calm this exists to refuse.
    ["contact is lost with a machine where an agent was waiting", SAID.contactLost],
    // Deliberately not taught either: a daemon older than the CLI reading it
    // is a skew whose count this does not vouch for. The line says restart
    // it; the number waits until then.
    ["the daemon is older than this astir", SAID.oldDaemon],
  ];

  for (const [what, said] of unknown) {
    test(`${what}: astir's line is drawn and the footer does not know`, async ($, on) => {
      const w = world(on);
      w.answer(() => exited(printed({ line: "1 waiting on you · oldest 1m", blocked: 1 })));
      await start($, w);
      expect(await footer($)).toBe("focus & astir 1");

      w.answer(() => exited(printed(said)));
      await w.clock.advance(5_000);
      expect(w.statuses.at(-1)).toBe(drawn(said.line));
      expect(await footer($)).toBe("focus & astir ?");
    });
  }

  const whole: [string, (typeof SAID)[keyof typeof SAID]][] = [
    ["nothing can notify you", SAID.noDelivery],
    ["astir hears nothing from this session", SAID.silent],
  ];

  for (const [what, said] of whole) {
    test(`${what}: the daemon answered, so its count stands beside the warning`, async ($, on) => {
      const w = world(on);
      w.answer(() => exited(printed(said)));
      await start($, w);
      expect(w.statuses.at(-1)).toBe(drawn(said.line));
      expect(await footer($)).toBe("focus & astir 2");
    });
  }

  test("a warning this does not know is not taken to leave the count whole", async ($, on) => {
    // A later minor may add a kind. Reading an unknown one as harmless would
    // draw a count whose warning this cannot judge; its line is still drawn.
    const w = world(on);
    w.answer(() =>
      exited(
        printed({
          line: "astir: something new",
          blocked: 2,
          v: { major: 1, minor: 3 },
          warnings: [{ kind: "something-new", text: "astir: something new" }],
        }),
      ),
    );
    await start($, w);
    expect(w.statuses.at(-1)).toBe("something new");
    expect(await footer($)).toBe("focus & astir ?");
  });
});

describe("never a stale value", () => {
  const v1 = { v: { major: 1, minor: 0 }, announced: 0, rows: [] };
  const failures: [string, Answer][] = [
    [
      "astir cannot be run",
      () => {
        throw new Error("spawn astir ENOENT");
      },
    ],
    // What it printed would read as calm; the exit code says it is not to be read.
    ["astir exits non-zero, whatever it printed", () => exited(printed({ line: null, blocked: 0 }), 1)],
    ["astir prints what is not JSON", () => exited("usage: astir <command>\n")],
    ["astir prints JSON of another shape", () => exited(JSON.stringify({ v: { major: 1, minor: 0 } }))],
    ["astir prints a count that is no count", () => exited(printed({ line: null, blocked: -1 }))],
    ["astir prints a count that is not whole", () => exited(printed({ line: null, blocked: 1.5 }))],
    // A renamed or lost `line` must not clear the line beside a good count.
    ["astir prints no line", () => exited(JSON.stringify({ ...v1, blocked: 0, warnings: [] }))],
    [
      "astir prints a line that is no text",
      () => exited(JSON.stringify({ ...v1, line: 7, blocked: 0, warnings: [] })),
    ],
    ["astir prints no version", () => exited(JSON.stringify({ line: null, blocked: 0, warnings: [] }))],
    ["astir prints no warnings", () => exited(JSON.stringify({ ...v1, line: null, blocked: 0 }))],
  ];

  for (const [what, failing] of failures) {
    test(`${what}: the line says astir is unreachable and the footer does not know`, async ($, on) => {
      const w = world(on);
      w.answer(() => exited(printed({ line: "1 waiting on you · oldest 1m", blocked: 1 })));
      await start($, w);
      expect(await footer($)).toBe("focus & astir 1");

      w.answer(failing);
      await w.clock.advance(5_000);
      expect(w.statuses.at(-1)).toBe("astir unreachable");
      expect(await footer($)).toBe("focus & astir ?");
    });

    test(`${what}: the /astir pane draws no rows, and nothing to press but Close`, async ($, on) => {
      const w = world(on);
      w.answer(() =>
        exited(printed({ line: "1 waiting on you · oldest 1m", blocked: 1, rows: [{ ...API }, { ...WEB }] })),
      );
      await start($, w);
      const ui = await pane($, "terminal");
      expect(await keys(ui)).toEqual(["g", "d", "close", "go:s-api"]);

      w.answer(failing);
      await w.clock.advance(5_000);
      expect(await lines(ui)).toEqual(["astir unreachable"]);
      expect(await keys(ui)).toEqual(["close"]);
    });
  }

  test("a run that outlasts its timeout is unreachable, not the last answer", async ($, on) => {
    const w = world(on);
    w.answer(() => exited(printed({ line: null, blocked: 4 })));
    await start($, w);
    w.answer(() => Promise.reject(new Error("timed out after 3000 ms")));
    await w.clock.advance(5_000);
    expect(w.statuses.at(-1)).toBe("astir unreachable");
    expect(await footer($)).toBe("focus & astir ?");
  });

  test("an astir older than status --line says to update astir, not that versions disagree", async ($, on) => {
    // What a released astir (0.2.0) prints for `status --line --json`: it
    // ignores --line and prints its /state document, exit 0. That is not a
    // status --line of another version, and saying so would send the person
    // to update the wrong thing.
    const w = world(on);
    w.answer(() => exited(printed({ line: null, blocked: 1 })));
    await start($, w);
    w.answer(() =>
      exited(JSON.stringify({ v: { major: 2, minor: 1 }, blockedCount: 0, silent: [], sessions: [] })),
    );
    await w.clock.advance(5_000);
    expect(w.statuses.at(-1)).toBe("astir predates status --line — update astir");
    expect(await footer($)).toBe("focus & astir ?");
  });

  test("a CLI speaking another major version says so instead of being misread", async ($, on) => {
    const w = world(on);
    w.answer(() => exited(printed({ line: "x", blocked: 2, v: { major: 2, minor: 0 } })));
    await start($, w);
    expect(w.statuses.at(-1)).toBe("astir speaks status --line v2; astir-tui reads v1 — update one of them");
    expect(await footer($)).toBe("focus & astir ?");
  });

  test("a newer minor version is additive and read as usual", async ($, on) => {
    const w = world(on);
    w.answer(() => exited(printed({ line: null, blocked: 2, v: { major: 1, minor: 7 } })));
    await start($, w);
    expect(await footer($)).toBe("focus & astir 2");
  });
});

describe("finding astir", () => {
  test("with nothing set, astir is run from PATH", async ($, on) => {
    const w = world(on);
    await start($, w);
    expect(w.runs[0]).toEqual(["astir", "status", "--line", "--json"]);
  });

  test("a checkout's layout above the plugin is not taken on its word: nothing there is read or run", async ($, on) => {
    // The folder above a plugin loaded from a shared /tmp is anyone's to
    // write: a marketplace naming this folder astir-tui's and a
    // `dist/cli/main.js` beside it vouch only for whoever put them there, and
    // `$.fs.stat` has no owner to tell them apart from a checkout. Run every
    // five seconds as the person, that would be theirs to run. So what runs is
    // the person's own say: their settings, else their PATH.
    const w = world(on, { planted: true });
    await start($, w);
    await w.clock.advance(5_000);
    expect(w.reads).toEqual([]);
    expect(w.stats).toEqual([]);
    expect(w.runs).toEqual([
      ["astir", "status", "--line", "--json"],
      ["astir", "status", "--line", "--json"],
    ]);
  });

  test(
    "an entry in settings wins, run with the node in settings",
    { options: { entry: "/opt/astir/dist/cli/main.js", node: "/usr/local/bin/node22" } },
    async ($, on) => {
      const w = world(on, { planted: true });
      await start($, w);
      expect(w.runs[0]).toEqual([
        "/usr/local/bin/node22",
        "/opt/astir/dist/cli/main.js",
        "status",
        "--line",
        "--json",
      ]);
    },
  );

  test(
    "an entry with no node set is run with node from PATH",
    { options: { entry: "/opt/a.js" } },
    async ($, on) => {
      const w = world(on);
      await start($, w);
      expect(w.runs[0]).toEqual(["node", "/opt/a.js", "status", "--line", "--json"]);
    },
  );

  test("a blank entry is no entry: astir is run from PATH", { options: { entry: "  " } }, async ($, on) => {
    const w = world(on);
    await start($, w);
    expect(w.runs[0]).toEqual(["astir", "status", "--line", "--json"]);
  });

  test(
    "a node with no entry runs nothing of its own: astir is run from PATH",
    { options: { node: "/n" } },
    async ($, on) => {
      // `node` is what runs the entry; PATH's `astir` brings its own.
      const w = world(on, { planted: true });
      await start($, w);
      expect(w.runs[0]).toEqual(["astir", "status", "--line", "--json"]);
    },
  );
});

// ---------------------------------------------------------------------------
// /astir: the pane. Read as the person reads it: the lines it draws, the
// Buttons it offers, and what pressing one runs.
// ---------------------------------------------------------------------------

const SURFACES = ["terminal", "desktop"] as const;
type Surface = (typeof SURFACES)[number];

/** A row as astir prints it; whatever is not given is a quiet local session. */
function row(sessionId: string, fields: Partial<LineRow> = {}): LineRow {
  return {
    sessionId,
    host: null,
    label: sessionId,
    state: "idle",
    waitingMs: null,
    acknowledged: false,
    announced: false,
    focusable: false,
    ...fields,
  };
}

const MIN = 60_000;
/** Blocked three minutes, here, in a tmux pane astir can raise. */
const API = row("s-api", {
  label: "api",
  state: "blocked",
  waitingMs: 3 * MIN,
  announced: true,
  focusable: true,
});
/** Blocked five minutes on another machine: there is no window here to raise. */
const WEB = row("s-web", {
  label: "web",
  host: "macbook",
  state: "blocked",
  waitingMs: 5 * MIN,
  announced: true,
});
/** Blocked one minute here, but in no tmux pane astir can find (PSH-11). */
const LOOSE = row("s-loose", { label: "loose", state: "blocked", waitingMs: 1 * MIN, announced: true });
/** Blocked ten minutes and already dismissed, which astir calls `waiting`. */
const CLI = row("s-cli", {
  label: "cli",
  state: "waiting",
  waitingMs: 10 * MIN,
  acknowledged: true,
  announced: true,
  focusable: true,
});
/** Idle here, in a tmux pane. */
const DOCS = row("s-docs", { label: "docs", focusable: true });

/**
 * astir as the pane meets it: `status` prints these rows, and `focus` and
 * `dismiss` answer as given (by default, as a working daemon does).
 */
function astir(w: World, rows: readonly unknown[], acts: { focus?: Answer; dismiss?: Answer } = {}): void {
  w.answer((argv) => {
    if (argv[1] === "focus") return (acts.focus ?? (() => exited("focused s-api\n")))(argv);
    if (argv[1] === "dismiss") return (acts.dismiss ?? (() => exited("dismissed 1 waiting agent\n")))(argv);
    return exited(printed({ line: null, blocked: 1, rows }));
  });
}

/** The Pane's props as a surface hands them. */
function paneProps(fields: { isFocused?: boolean; bodyColumns?: number } = {}) {
  return {
    title: "astir",
    isFocused: fields.isFocused ?? true,
    bodyColumns: fields.bodyColumns ?? 80,
    placement: "inline" as const,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  };
}

/** The `/astir` pane, drawn through the plugin on `surface`. */
function pane($: Engine, surface: Surface, fields: { isFocused?: boolean; bodyColumns?: number } = {}) {
  return $.ui.mount({
    plugin: "astir-tui",
    surface,
    component: "Pane",
    requestId: "astir",
    props: paneProps(fields),
  });
}

type Pane = Awaited<ReturnType<typeof pane>>;

/** Every line of text the pane draws, in order, its runs of spaces closed up. */
async function lines(ui: Pane): Promise<string[]> {
  return (await ui.findAll({ type: "Text" })).map((t) => t.text.replace(/\s+/g, " ").trim());
}

/** Every Button the pane draws, in order. */
async function buttons(
  ui: Pane,
): Promise<{ key: string | undefined; label: unknown; hotkey: unknown; role: unknown }[]> {
  return (await ui.findAll({ type: "Button" })).map((b) => ({
    key: b.key,
    label: b.props.label,
    hotkey: b.props.hotkey,
    role: b.props.role,
  }));
}

async function keys(ui: Pane): Promise<(string | undefined)[]> {
  return (await buttons(ui)).map((b) => b.key);
}

/** Every run that was not a `status` poll: what a press did. */
function acts(w: World): (readonly string[])[] {
  return w.runs.filter((argv) => argv[1] !== "status");
}

/** `/astir`, typed at the prompt of an 80-column terminal's main screen. */
async function run($: Engine) {
  return $.command.run({
    command: "astir",
    args: "",
    origin: { kind: "composer" },
    presentation: { isFullscreen: false, columns: 80 },
  });
}

describe("/astir", () => {
  test("is a command that runs at once, even mid-turn", async ($, on) => {
    const w = world(on);
    await start($, w);
    expect(w.registered).toEqual([{ name: "astir", description: expect.any(String), immediate: true }]);
  });

  test("opens a pane that takes the keys and closes on Esc, and hands the model nothing", async ($, on) => {
    // Without `focus`, Esc during a turn belongs to the prompt and interrupts
    // Claude (G6). NG4: a `text` would be a transcript row the model reads.
    const w = world(on);
    await start($, w);
    const ran = await run($);
    expect(ran).toEqual({});
    expect(ran.text).toBeUndefined();
    expect(w.opens).toEqual([{ id: "astir", title: "astir", focus: true, closeOnEscape: true, rows: 4 }]);
  });

  test("a pane that cannot be opened still hands the model nothing", async ($, on) => {
    // Were the hook to fail and go unanswered, the engine would say so itself,
    // as the command's output: a transcript row the model reads (NG4).
    const w = world(on, { openRefused: true });
    await start($, w);
    expect(await run($)).toEqual({});
    expect(w.opens).toHaveLength(1);
  });

  test("asks astir again as it opens, not five seconds later", async ($, on) => {
    const w = world(on);
    await start($, w);
    expect(w.runs).toHaveLength(1);
    await run($);
    await w.clock.settle();
    expect(w.runs).toHaveLength(2);
    expect(asked(w.runs[1])).toEqual(["status", "--line", "--json"]);
  });

  test("opening does not wait on astir's answer", async ($, on) => {
    const w = world(on);
    await start($, w);
    w.answer(async () => {
      await w.clock.sleep(2_000);
      return exited(printed({ line: null, blocked: 0 }));
    });
    let opened = false;
    const running = run($).then(() => {
      opened = true;
    });
    await w.clock.settle();
    expect(opened).toBe(true);
    expect(w.opens).toHaveLength(1);
    await w.clock.advance(2_000);
    await running;
  });

  const sizes: [number, number][] = [
    [0, 4],
    [1, 4],
    [3, 6],
    [9, 12],
    [20, 12],
  ];
  for (const [n, want] of sizes) {
    test(`with ${n} rows it asks for ${want} rows: its rows and three, from 4 to 12`, async ($, on) => {
      const w = world(on);
      astir(
        w,
        Array.from({ length: n }, (_, i) => row(`s-${i}`)),
      );
      await start($, w);
      await run($);
      expect(w.opens.at(-1)?.rows).toBe(want);
    });
  }

  test("with astir unreachable it asks for the fewest rows", async ($, on) => {
    const w = world(on);
    w.answer(() => exited("usage: astir <command>\n"));
    await start($, w);
    await run($);
    expect(w.opens.at(-1)?.rows).toBe(4);
  });
});

describe("the /astir pane", () => {
  for (const surface of SURFACES) {
    test(`${surface}: astir's rows in astir's order, each with its state, its wait and whether it was dismissed`, async ($, on) => {
      const w = world(on);
      astir(w, [API, WEB, LOOSE, CLI, DOCS]);
      await start($, w);
      const ui = await pane($, surface);
      expect(await lines(ui)).toEqual([
        "api blocked for 3m",
        "web · macbook blocked for 5m",
        "loose blocked for 1m",
        "cli waiting for 10m dismissed",
        "docs idle",
      ]);
    });

    test(`${surface}: Go only on the rows astir says it can raise, then g, d and Close`, async ($, on) => {
      const w = world(on);
      astir(w, [API, WEB, LOOSE, CLI, DOCS]);
      await start($, w);
      const ui = await pane($, surface);
      expect(await keys(ui)).toEqual(["g", "d", "close", "go:s-api", "go:s-cli", "go:s-docs"]);
      for (const b of (await buttons(ui)).filter((x) => x.key?.startsWith("go:"))) {
        expect(b).toEqual({ key: b.key, label: "Go", hotkey: undefined, role: undefined });
      }
    });

    test(`${surface}: a remote row and a local row astir cannot raise get no Button`, async ($, on) => {
      // PSH-11: another machine's session has no window here, and a local one
      // under no tmux pane has none astir can find. Neither is guessed at.
      const w = world(on);
      astir(w, [WEB, LOOSE]);
      await start($, w);
      const ui = await pane($, surface);
      expect(await keys(ui)).toEqual(["d", "close"]);
    });

    test(`${surface}: g and d say whose they are: the longest-waiting blocked row each can act on`, async ($, on) => {
      // cli has waited longest, but it is dismissed; web is next, but on
      // another machine, so g cannot raise it while d can dismiss it.
      const w = world(on);
      astir(w, [API, WEB, LOOSE, CLI]);
      await start($, w);
      const ui = await pane($, surface);
      const drawn = await buttons(ui);
      expect(drawn.find((b) => b.hotkey === "g")).toEqual({
        key: "g",
        label: "go to api (3m)",
        hotkey: "g",
        role: undefined,
      });
      expect(drawn.find((b) => b.hotkey === "d")).toEqual({
        key: "d",
        label: "dismiss web · macbook (5m)",
        hotkey: "d",
        role: undefined,
      });
    });

    test(`${surface}: with no one blocked and undismissed, neither g nor d is drawn`, async ($, on) => {
      const w = world(on);
      astir(w, [CLI, DOCS]);
      await start($, w);
      const ui = await pane($, surface);
      expect(await keys(ui)).toEqual(["close", "go:s-cli", "go:s-docs"]);
    });

    test(`${surface}: however many rows, the only hotkeys are one g and one d`, async ($, on) => {
      // When two Buttons share a hotkey the later one gets it: one key per row
      // would make `g` press whichever row happened to be drawn last.
      const w = world(on);
      const many = Array.from({ length: 30 }, (_, i) =>
        row(`s-${i}`, {
          label: `repo-${i}`,
          host: i % 3 === 0 ? "macbook" : null,
          state: i % 5 === 4 ? "idle" : "blocked",
          waitingMs: i % 5 === 4 ? null : (30 - i) * MIN,
          acknowledged: i % 7 === 0,
          focusable: i % 3 !== 0,
        }),
      );
      astir(w, many);
      await start($, w);
      const ui = await pane($, surface);
      const drawn = await buttons(ui);
      const hotkeys = drawn.flatMap((b) => (b.hotkey === undefined ? [] : [b.hotkey]));
      expect([...hotkeys].sort()).toEqual(["d", "g"]);
      for (const b of drawn.filter((x) => x.hotkey === undefined)) {
        expect(b.key === "close" || (b.key?.startsWith("go:") === true && b.label === "Go")).toBe(true);
      }
    });

    test(`${surface}: Close closes the pane and runs nothing`, async ($, on) => {
      // Needed because a pane is refused the keys while the prompt has text,
      // and then Esc is the prompt's.
      const w = world(on);
      astir(w, [API]);
      await start($, w);
      const ui = await pane($, surface);
      expect((await buttons(ui)).find((b) => b.key === "close")).toEqual({
        key: "close",
        label: "Close",
        hotkey: undefined,
        role: "dismiss",
      });
      await ui.press({ key: "close" });
      expect(w.closes).toEqual(["astir"]);
      expect(acts(w)).toEqual([]);
    });

    test(`${surface}: Go runs astir focus for that row, and the pane closes once it has`, async ($, on) => {
      const w = world(on);
      astir(w, [API, DOCS]);
      await start($, w);
      const ui = await pane($, surface);
      await ui.press({ key: "go:s-docs" });
      expect(acts(w)).toEqual([["astir", "focus", "s-docs"]]);
      expect(w.timeouts.at(-1)).toBeDefined();
      expect(w.closes).toEqual(["astir"]);
    });

    test(`${surface}: g runs astir focus for the row it names`, async ($, on) => {
      const w = world(on);
      astir(w, [API, WEB, LOOSE, CLI]);
      await start($, w);
      const ui = await pane($, surface);
      await ui.press({ key: "g" });
      expect(acts(w)).toEqual([["astir", "focus", "s-api"]]);
      expect(w.closes).toEqual(["astir"]);
    });

    test(`${surface}: a Go that fails says why, in astir's words, and the pane stays open`, async ($, on) => {
      const w = world(on);
      astir(w, [API], { focus: () => exited("no tmux pane holds this session\n", 1) });
      await start($, w);
      const ui = await pane($, surface);
      await ui.press({ key: "go:s-api" });
      expect(w.closes).toEqual([]);
      expect(await lines(ui)).toEqual([
        "could not go to api: no tmux pane holds this session",
        "api blocked for 3m",
      ]);
    });

    test(`${surface}: d runs astir dismiss for the row it names, remote or not, and the row is read again`, async ($, on) => {
      const w = world(on);
      const dismissed = { ...WEB, state: "idle", acknowledged: true };
      astir(w, [API, WEB, LOOSE, CLI], {
        dismiss: () => {
          astir(w, [API, dismissed, LOOSE, CLI]);
          return exited("dismissed 1 waiting agent\n");
        },
      });
      await start($, w);
      const ui = await pane($, surface);
      const before = w.runs.length;
      await ui.press({ key: "d" });
      expect(w.runs.slice(before).map((argv) => argv.slice(0, 3))).toEqual([
        ["astir", "dismiss", "s-web"],
        ["astir", "status", "--line"],
      ]);
      expect(await lines(ui)).toEqual([
        "dismissed 1 waiting agent",
        "api blocked for 3m",
        "web · macbook idle for 5m dismissed",
        "loose blocked for 1m",
        "cli waiting for 10m dismissed",
      ]);
    });
  }

  test("a Go astir cannot answer says so, from the first line it wrote", async ($, on) => {
    // `astir focus` writes why on stderr when it cannot reach the daemon.
    const w = world(on);
    astir(w, [API], {
      focus: () => ({
        ...exited("", 1),
        stderr:
          "astir: could not reach a daemon on 127.0.0.1:47000\nfocus is performed by the daemon so that only one application needs\n",
      }),
    });
    await start($, w);
    const ui = await pane($, "terminal");
    await ui.press({ key: "go:s-api" });
    expect((await lines(ui))[0]).toBe("could not go to api: could not reach a daemon on 127.0.0.1:47000");
  });

  test("a Go that outlasts its timeout says astir did not answer", async ($, on) => {
    const w = world(on);
    astir(w, [API], {
      focus: () => {
        throw new Error("timed out after 5000 ms");
      },
    });
    await start($, w);
    const ui = await pane($, "terminal");
    await ui.press({ key: "go:s-api" });
    expect(w.closes).toEqual([]);
    expect((await lines(ui))[0]).toBe("could not go to api: astir did not answer");
  });

  test("an action's answer is cut to 120 characters", async ($, on) => {
    const w = world(on);
    astir(w, [API], { focus: () => exited(`${"x".repeat(300)}\n`, 1) });
    await start($, w);
    const ui = await pane($, "terminal", { bodyColumns: 200 });
    await ui.press({ key: "go:s-api" });
    const said = (await lines(ui))[0] ?? "";
    expect([...said].length).toBe(120);
    expect(said).toMatch(/^could not go to api: x+…$/);
  });

  test("what an action said stands through a reading begun just after it, and is gone a period later", async ($, on) => {
    // Pressed 100 ms before the poll is due, the reason a Go failed must not
    // be gone before it can be read.
    const w = world(on);
    astir(w, [API], { focus: () => exited("no tmux pane holds this session\n", 1) });
    await start($, w);
    const ui = await pane($, "terminal");
    await w.clock.advance(4_900);
    await ui.press({ key: "go:s-api" });
    const said = ["could not go to api: no tmux pane holds this session", "api blocked for 3m"];
    expect(await lines(ui)).toEqual(said);
    await w.clock.advance(100);
    expect(await lines(ui)).toEqual(said);
    await w.clock.advance(5_000);
    expect(await lines(ui)).toEqual(["api blocked for 3m"]);
  });

  test("a reading begun before an action's answer, or in the period after it, does not take it away", async ($, on) => {
    // Each poll here takes a second to answer.
    const w = world(on);
    let slow = false;
    w.answer(async (argv) => {
      if (argv[1] === "focus") return exited("no tmux pane holds this session\n", 1);
      if (slow) await w.clock.sleep(1_000);
      return exited(printed({ line: null, blocked: 1, rows: [API] }));
    });
    await start($, w);
    const ui = await pane($, "terminal");
    slow = true;
    const said = ["could not go to api: no tmux pane holds this session", "api blocked for 3m"];
    // Go fails at 5.5 s, while the poll asked at 5 s is still out.
    await w.clock.advance(5_500);
    await ui.press({ key: "go:s-api" });
    await w.clock.advance(500);
    expect(await lines(ui)).toEqual(said);
    // Asked at 10 s, inside the period, and answered at 11 s, after it.
    await w.clock.advance(5_000);
    expect(await lines(ui)).toEqual(said);
    // Asked at 15 s, once the answer has stood its period.
    await w.clock.advance(5_000);
    expect(await lines(ui)).toEqual(["api blocked for 3m"]);
  });

  test("a second answer stands a period of its own, not what was left of the first's", async ($, on) => {
    const w = world(on);
    const why = ["no tmux pane holds this session", "the session has no pid"];
    let tries = 0;
    astir(w, [API], { focus: () => exited(`${why[tries++ % 2]}\n`, 1) });
    await start($, w);
    const ui = await pane($, "terminal");
    await w.clock.advance(100);
    await ui.press({ key: "go:s-api" });
    await w.clock.advance(4_800);
    await ui.press({ key: "go:s-api" });
    // The first answer's period is over; the second has stood 1.1 s of its own
    // when /astir is typed again, and astir read well as it opens.
    await w.clock.advance(1_100);
    await run($);
    await w.clock.settle();
    expect((await lines(ui))[0]).toBe("could not go to api: the session has no pid");
  });

  test("what an action said outlasts astir going unreachable, and goes at a good reading", async ($, on) => {
    // Only a good reading says the answer is behind the person; astir not
    // answering says nothing of it.
    const w = world(on);
    astir(w, [API], { focus: () => exited("no tmux pane holds this session\n", 1) });
    await start($, w);
    const ui = await pane($, "terminal");
    await ui.press({ key: "go:s-api" });
    w.answer(() => exited("", 1));
    await w.clock.advance(10_000);
    expect(await lines(ui)).toEqual([
      "astir unreachable",
      "could not go to api: no tmux pane holds this session",
    ]);
    astir(w, [API]);
    await w.clock.advance(5_000);
    expect(await lines(ui)).toEqual(["api blocked for 3m"]);
  });

  test("a reading begun before a dismiss and landing after it is not drawn over it", async ($, on) => {
    // Ticks are not serialised: a poll in flight as `d` is pressed answers for
    // the moment before the dismiss. Drawn last, it would put the row back as
    // blocked, offer g and d on it again, and take astir's answer away.
    const w = world(on);
    let dismissed = false;
    let slow = false;
    w.answer(async (argv) => {
      if (argv[1] === "dismiss") {
        dismissed = true;
        return exited("dismissed 1 waiting agent\n");
      }
      // astir answers for the moment it is asked, however late that lands.
      const rows = [dismissed ? { ...API, state: "waiting", acknowledged: true } : API];
      if (slow) await w.clock.sleep(1_000);
      return exited(printed({ line: null, blocked: dismissed ? 0 : 1, rows }));
    });
    await start($, w);
    const ui = await pane($, "terminal");
    slow = true;
    await w.clock.advance(5_000);
    slow = false;
    await ui.press({ key: "d" });
    const after = ["dismissed 1 waiting agent", "api waiting for 3m dismissed"];
    expect(await lines(ui)).toEqual(after);
    expect(await keys(ui)).toEqual(["close", "go:s-api"]);
    // The older poll lands.
    await w.clock.advance(1_000);
    expect(await lines(ui)).toEqual(after);
    expect(await keys(ui)).toEqual(["close", "go:s-api"]);
    expect(await footer($)).toBe("focus & astir 0");
  });

  test("an action is given five seconds: more than a poll's three, and still bounded", async ($, on) => {
    const w = world(on);
    astir(w, [API, WEB]);
    await start($, w);
    const ui = await pane($, "terminal");
    await ui.press({ key: "d" });
    await ui.press({ key: "go:s-api" });
    const given = (verb: string) => w.timeouts[w.runs.findIndex((argv) => argv[1] === verb)];
    expect(given("dismiss")).toBe(5_000);
    expect(given("focus")).toBe(5_000);
  });

  test("a dismiss astir cannot answer says so, naming whose it was", async ($, on) => {
    const w = world(on);
    astir(w, [API, WEB], {
      dismiss: () => {
        throw new Error("timed out after 5000 ms");
      },
    });
    await start($, w);
    const ui = await pane($, "terminal");
    await ui.press({ key: "d" });
    expect((await lines(ui))[0]).toBe("could not dismiss web: astir did not answer");
  });

  const silent: [string, number, string][] = [
    ["succeeds", 0, "dismissed"],
    ["fails", 1, "could not dismiss web: astir dismiss exited 1"],
  ];
  for (const [what, code, said] of silent) {
    test(`a dismiss that ${what} and writes nothing is still answered: ${said}`, async ($, on) => {
      const w = world(on);
      astir(w, [API, WEB], { dismiss: () => ({ ...exited(" \n\n", code), stderr: "\n" }) });
      await start($, w);
      const ui = await pane($, "terminal");
      await ui.press({ key: "d" });
      expect((await lines(ui))[0]).toBe(said);
    });
  }

  test("a Go that fails and writes nothing says how it ended", async ($, on) => {
    const w = world(on);
    astir(w, [API], { focus: () => exited("", 3) });
    await start($, w);
    const ui = await pane($, "terminal");
    await ui.press({ key: "go:s-api" });
    expect(w.closes).toEqual([]);
    expect((await lines(ui))[0]).toBe("could not go to api: astir focus exited 3");
  });

  test("a Go that fails says astir's own answer, not what else was written beside it", async ($, on) => {
    // `astir focus` writes the daemon's reason on stdout; node writes its own
    // warnings on stderr.
    const w = world(on);
    astir(w, [API], {
      focus: () => ({
        ...exited("no tmux pane holds this session\n", 1),
        stderr: "(node:4242) ExperimentalWarning: something experimental\n",
      }),
    });
    await start($, w);
    const ui = await pane($, "terminal");
    await ui.press({ key: "go:s-api" });
    expect((await lines(ui))[0]).toBe("could not go to api: no tmux pane holds this session");
  });

  test("a line of nothing but control characters is not taken for astir's answer", async ($, on) => {
    const w = world(on);
    astir(w, [API], { focus: () => exited("\u0007\u001b\nno tmux pane holds this session\n", 1) });
    await start($, w);
    const ui = await pane($, "terminal");
    await ui.press({ key: "go:s-api" });
    expect((await lines(ui))[0]).toBe("could not go to api: no tmux pane holds this session");
  });

  test("an action's answer is drawn without its control characters, on one line", async ($, on) => {
    const w = world(on);
    astir(w, [API], { focus: () => exited("\u001b[31mno\u0007 pane\r\nsecond line\n", 1) });
    await start($, w);
    const ui = await pane($, "terminal");
    await ui.press({ key: "go:s-api" });
    expect((await lines(ui))[0]).toBe("could not go to api: [31mno pane");
  });

  test("astir unreachable after a good reading: no rows, no Go, no g or d, only Close", async ($, on) => {
    // A press on a row astir no longer vouches for could act on a session
    // that is gone. Never the last good rows.
    const w = world(on);
    astir(w, [API, WEB]);
    await start($, w);
    const ui = await pane($, "terminal");
    expect(await keys(ui)).toEqual(["g", "d", "close", "go:s-api"]);
    w.answer(() => exited("", 1));
    await w.clock.advance(5_000);
    expect(await lines(ui)).toEqual(["astir unreachable"]);
    expect(await keys(ui)).toEqual(["close"]);
  });

  test("a good answer that carries no rows draws none, and the line and footer still read it", async ($, on) => {
    const w = world(on);
    astir(w, [API]);
    await start($, w);
    w.answer(() =>
      exited(
        JSON.stringify({
          v: { major: 1, minor: 0 },
          line: "2 waiting on you · oldest 3m",
          blocked: 2,
          announced: 2,
          warnings: [],
        }),
      ),
    );
    await w.clock.advance(5_000);
    const ui = await pane($, "terminal");
    expect(await lines(ui)).toEqual(["astir unreachable"]);
    expect(await keys(ui)).toEqual(["close"]);
    expect(w.statuses.at(-1)).toBe("2 waiting on you · oldest 3m");
    expect(await footer($)).toBe("focus & astir 2");
  });

  test("a row of the wrong shape is dropped, not drawn", async ($, on) => {
    const w = world(on);
    astir(w, [
      API,
      { ...WEB, waitingMs: "5m" },
      { ...LOOSE, focusable: "yes" },
      { ...CLI, label: null },
      { ...API, sessionId: 7 },
      { ...API, sessionId: "" },
      // An id astir's own argument parser would read as a flag.
      { ...API, sessionId: "--port", label: "flag" },
      { ...API, sessionId: "s 1", label: "spaced" },
      // Longer than the daemon takes an id (src/contract/event.ts).
      { ...API, sessionId: "x".repeat(4097), label: "huge" },
      { ...API, waitingMs: -1 },
      // A control character in an id, whitespace or not, is not handed back.
      { ...API, sessionId: "s-\u0007bell", label: "bell" },
      { ...API, sessionId: "s-\u009bcsi", label: "csi" },
      { ...WEB, host: 7 },
      { ...API, state: 7 },
      { ...API, acknowledged: "no" },
      { ...API, announced: "yes" },
      null,
      "docs",
      DOCS,
    ]);
    await start($, w);
    const ui = await pane($, "terminal");
    expect(await lines(ui)).toEqual(["api blocked for 3m", "docs idle"]);
  });

  test("an id as long as the daemon takes is kept, and Go hands it back whole", async ($, on) => {
    const w = world(on);
    const id = "x".repeat(4096);
    astir(w, [{ ...API, sessionId: id }]);
    await start($, w);
    const ui = await pane($, "terminal");
    await ui.press({ key: `go:${id}` });
    expect(acts(w)).toEqual([["astir", "focus", id]]);
  });

  test("a row from another machine is never offered Go, whatever it says", async ($, on) => {
    // Remote rows are never focusable in astir's serialiser; one that claims
    // otherwise is not taken at its word.
    const w = world(on);
    astir(w, [{ ...WEB, focusable: true }]);
    await start($, w);
    const ui = await pane($, "terminal");
    expect(await keys(ui)).toEqual(["d", "close"]);
  });

  test("control characters in a label, host or state are not drawn", async ($, on) => {
    // A remote row's label and host come from another machine.
    const w = world(on);
    astir(w, [{ ...WEB, label: "\u001b[2Jweb\u0007", host: "mac\u009bbook\r", state: "blo\bcked\u007f" }]);
    await start($, w);
    const ui = await pane($, "terminal");
    expect(await lines(ui)).toEqual(["[2Jweb · macbook blocked for 5m"]);
    const drawn = [...(await lines(ui)), ...(await buttons(ui)).map((b) => String(b.label))];
    expect(drawn.some((text) => /\p{Cc}/u.test(text))).toBe(false);
    expect((await buttons(ui)).find((b) => b.key === "d")?.label).toBe("dismiss [2Jweb · macbook (5m)");
  });

  test("a row is cut to the pane's width, never wrapped: the label gives way, its state and wait stay", async ($, on) => {
    const w = world(on);
    const long = "a-repository-name-far-too-long-for-the-pane-it-is-drawn-in";
    astir(w, [
      { ...API, label: long },
      { ...WEB, label: long },
    ]);
    await start($, w);
    const ui = await pane($, "terminal", { bodyColumns: 50 });
    const rows = (await ui.findAll({ type: "Text" })).map((t) => t.text);
    expect(rows).toHaveLength(2);
    for (const text of rows) {
      // Go's `[ Go ]` and a space take seven of the fifty.
      expect([...text].length).toBeLessThanOrEqual(43);
      expect(text).toContain("…");
    }
    // The host is kept whole: it is what says the row is another machine's.
    expect(rows[0]).toMatch(/^a-repo.*… +blocked +for 3m *$/);
    expect(rows[1]).toMatch(/^a-repo.*… · macbook +blocked +for 5m *$/);
    for (const b of await buttons(ui)) {
      // A plain hotkey Button draws `g: ` before its label.
      expect([...String(b.label)].length + 3).toBeLessThanOrEqual(50);
    }
  });

  test("a label or host that was nothing but control characters is drawn as ?", async ($, on) => {
    const w = world(on);
    astir(w, [
      { ...API, label: "\u0007" },
      { ...WEB, label: "\u001b", host: "\u009b\r" },
    ]);
    await start($, w);
    const ui = await pane($, "terminal");
    expect(await lines(ui)).toEqual(["? blocked for 3m", "? · ? blocked for 5m"]);
    const drawn = await buttons(ui);
    expect(drawn.find((b) => b.key === "g")?.label).toBe("go to ? (3m)");
    expect(drawn.find((b) => b.key === "d")?.label).toBe("dismiss ? · ? (5m)");
  });

  test("a state astir cannot say is drawn as unknown", async ($, on) => {
    const w = world(on);
    astir(w, [{ ...DOCS, state: null }]);
    await start($, w);
    const ui = await pane($, "terminal");
    expect(await lines(ui)).toEqual(["docs unknown"]);
  });

  test("a wait is drawn in its largest unit alone, to the nearest second, as astir's line says it", async ($, on) => {
    const w = world(on);
    const blocked = (id: string, waitingMs: number) => row(id, { label: id, state: "blocked", waitingMs });
    astir(w, [
      blocked("a", 12_000),
      blocked("b", 59_600),
      blocked("c", 2 * 60 * MIN + 59 * MIN),
      blocked("d", 3 * 24 * 60 * MIN + 23 * 60 * MIN),
    ]);
    await start($, w);
    const ui = await pane($, "terminal");
    expect(await lines(ui)).toEqual([
      "a blocked for 12s",
      "b blocked for 1m",
      "c blocked for 2h",
      "d blocked for 3d",
    ]);
  });

  test("g and d pass over a row astir does not call blocked, however long its wait", async ($, on) => {
    // A remote row whose only undismissed doorbell has gone stale takes its
    // machine's state (idle, say) and keeps its wait (src/status/line.ts).
    const w = world(on);
    astir(w, [API, { ...WEB, state: "idle", waitingMs: 9 * MIN }, { ...DOCS, waitingMs: 9 * MIN }]);
    await start($, w);
    const ui = await pane($, "terminal");
    const drawn = await buttons(ui);
    expect(drawn.find((b) => b.key === "g")?.label).toBe("go to api (3m)");
    expect(drawn.find((b) => b.key === "d")?.label).toBe("dismiss api (3m)");
  });

  test("g and d pass over a row already dismissed, even one astir still calls blocked", async ($, on) => {
    const w = world(on);
    const old = { ...API, sessionId: "s-old", label: "old", waitingMs: 20 * MIN, acknowledged: true };
    astir(w, [old, API, WEB]);
    await start($, w);
    const ui = await pane($, "terminal");
    const drawn = await buttons(ui);
    expect(drawn.find((b) => b.key === "g")?.label).toBe("go to api (3m)");
    expect(drawn.find((b) => b.key === "d")?.label).toBe("dismiss web · macbook (5m)");
  });

  test("between rows that have waited as long, g and d take the first in astir's order", async ($, on) => {
    const w = world(on);
    astir(w, [API, { ...API, sessionId: "s-app", label: "app" }, { ...WEB, waitingMs: 3 * MIN }]);
    await start($, w);
    const ui = await pane($, "terminal");
    const drawn = await buttons(ui);
    expect(drawn.find((b) => b.key === "g")?.label).toBe("go to api (3m)");
    expect(drawn.find((b) => b.key === "d")?.label).toBe("dismiss api (3m)");
    await ui.press({ key: "d" });
    expect(acts(w)).toEqual([["astir", "dismiss", "s-api"]]);
  });

  test("g and d name a long session in at most 24 characters, however wide the pane", async ($, on) => {
    // So the two of them and Close share one row wherever they can.
    const w = world(on);
    const long = "a-repository-name-far-too-long-for-a-key";
    astir(w, [{ ...API, label: long }]);
    await start($, w);
    const ui = await pane($, "terminal", { bodyColumns: 200 });
    const drawn = await buttons(ui);
    expect(drawn.find((b) => b.key === "g")?.label).toBe(`go to ${long.slice(0, 23)}… (3m)`);
    expect(drawn.find((b) => b.key === "d")?.label).toBe(`dismiss ${long.slice(0, 23)}… (3m)`);
  });

  test("g, d and Close stand in one row where they fit, and stack where they do not", async ($, on) => {
    const w = world(on);
    astir(w, [API, WEB]);
    await start($, w);
    const wide = await pane($, "terminal", { bodyColumns: 80 });
    expect((await wide.find({ key: "actions" }))?.props.flexDirection).toBe("row");
    await wide.unmount();
    const narrow = await pane($, "terminal", { bodyColumns: 30 });
    expect((await narrow.find({ key: "actions" }))?.props.flexDirection).toBe("column");
  });

  test("the Go Buttons stand in one column: every row is drawn as wide as the rest", async ($, on) => {
    const w = world(on);
    astir(w, [API, { ...DOCS, label: "documentation" }, WEB]);
    await start($, w);
    const ui = await pane($, "terminal");
    const rows = (await ui.findAll({ type: "Text" })).map((t) => [...t.text].length);
    // Eighty, less Go's `[ Go ]` and the space before it.
    expect(rows).toEqual([73, 73, 73]);
  });

  test("a state word from another machine, however long, does not squeeze every name out", async ($, on) => {
    // A remote row's state is whatever its machine's roster said.
    const w = world(on);
    const said = "waiting-for-the-person-to-approve-a-permission-request-somewhere";
    astir(w, [API, { ...WEB, state: said }, DOCS]);
    await start($, w);
    const ui = await pane($, "terminal");
    expect(await lines(ui)).toEqual(["api blocked for 3m", "web · macbook waiting-for… for 5m", "docs idle"]);
  });

  test("at a narrow width no line is wider than the pane: each is cut, never wrapped", async ($, on) => {
    const w = world(on);
    w.answer((argv) =>
      argv[1] === "focus"
        ? exited("no tmux pane holds this session\n", 1)
        : exited(printed({ ...SAID.notifierHung, rows: [API] })),
    );
    await start($, w);
    const ui = await pane($, "terminal", { bodyColumns: 24, isFocused: false });
    await ui.press({ key: "go:s-api" });
    const texts = (await ui.findAll({ type: "Text" })).map((t) => t.text);
    // What astir cannot see, Go's answer, how to give the pane the keys, the row.
    expect(texts).toHaveLength(4);
    expect([texts[0], texts[1], texts[2]].map((t) => t?.slice(0, 9))).toEqual([
      "astir can",
      "could not",
      "ctrl+x ta",
    ]);
    for (const text of texts) {
      expect([...text].length).toBeLessThanOrEqual(24);
    }
    for (const text of [texts[0], texts[1], texts[2]]) {
      expect(text).toMatch(/…$/);
    }
  });

  test("not holding the keys, it says how to give them to it", async ($, on) => {
    const w = world(on);
    astir(w, [API]);
    await start($, w);
    const unfocused = await pane($, "terminal", { isFocused: false });
    expect((await lines(unfocused)).some((text) => /ctrl\+x tab/.test(text))).toBe(true);
    await unfocused.unmount();
    const focused = await pane($, "terminal");
    expect((await lines(focused)).some((text) => /ctrl\+x tab/.test(text))).toBe(false);
  });

  test("with no sessions it says so", async ($, on) => {
    const w = world(on);
    astir(w, []);
    await start($, w);
    const ui = await pane($, "terminal");
    expect(await lines(ui)).toEqual(["astir knows of no sessions"]);
    expect(await keys(ui)).toEqual(["close"]);
  });

  test("when astir says it cannot see every session, the pane does not draw calm", async ($, on) => {
    // `astir 0` beside "daemon not running" is the calm a broken state must
    // never wear; nor is an empty pane.
    const w = world(on);
    w.answer(() => exited(printed(SAID.daemonDown)));
    await start($, w);
    const ui = await pane($, "terminal");
    expect(await lines(ui)).toEqual(["astir cannot see every session: the line below the prompt says why"]);
  });

  test("before astir has answered, it says it is asking", async ($, on) => {
    world(on);
    const ui = await pane($, "terminal");
    expect(await lines(ui)).toEqual(["asking astir…"]);
    expect(await keys(ui)).toEqual(["close"]);
  });

  test("nothing it offers runs anything but focus and dismiss: never `view`", async ($, on) => {
    // DMN-01: on a headless host `astir view` falls back to printing its
    // `#<token>` URL. Every Button the pane draws is pressed, on each surface.
    const w = world(on);
    astir(w, [API, WEB, LOOSE, CLI, DOCS]);
    await start($, w);
    await run($);
    for (const surface of SURFACES) {
      for (const focused of [true, false]) {
        const ui = await pane($, surface, { isFocused: focused });
        for (const key of await keys(ui)) {
          await ui.press({ key: key ?? "" });
        }
        const drawn = [...(await lines(ui)), ...(await buttons(ui)).map((b) => String(b.label))];
        expect(drawn.some((text) => /view/i.test(text))).toBe(false);
        await ui.unmount();
      }
    }
    expect([...new Set(w.runs.map((argv) => argv[1]))].sort()).toEqual(["dismiss", "focus", "status"]);
    expect(JSON.stringify(w.runs)).not.toMatch(/view/);
    expect(JSON.stringify(w.registered)).not.toMatch(/view/);
  });
});
