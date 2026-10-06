/**
 * astir-tui under `claude plugin test tui`: the engine's own `$`, with the
 * world beneath the plugin (astir's CLI, the session id, the file system, the
 * status line, the footer) answered here.
 *
 * Every behaviour the module has is a promise made to someone looking at a
 * terminal, so each test reads what they would see: the status line's text
 * and the footer's label. Nothing here inspects the module's internals.
 */
import type { On, ProcessRunResult, RenderElement } from "claude-code";
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

/** What `astir status --line --json` prints, shaped as the serialiser's v1. */
function printed(fields: {
  line: string | null;
  blocked: number;
  warnings?: readonly Warning[];
  v?: { major: number; minor: number };
}): string {
  return JSON.stringify({
    v: fields.v ?? { major: 1, minor: 0 },
    line: fields.line,
    blocked: fields.blocked,
    announced: 0,
    warnings: fields.warnings ?? [],
    rows: [],
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
 * so nothing found there may decide what runs.
 */
function world(on: On, opts: { planted?: boolean } = {}): World {
  const clock = mock.clock(on, { now: 1_000_000 });
  const runs: (readonly string[])[] = [];
  const timeouts: (number | undefined)[] = [];
  const statuses: (string | undefined)[] = [];
  const stats: string[] = [];
  const reads: string[] = [];
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
