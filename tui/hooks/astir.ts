/**
 * astir-tui: astir inside Claude Code's own terminal (#80).
 *
 * Two things are drawn, and nothing else is done:
 *
 *   - the status line under the prompt, which is `astir status --line`'s one
 *     line: a warning when no one would be told (daemon down, an impostor on
 *     the port, no live delivery path, this session unheard), then the
 *     announced blocks. Empty when there is nothing to say.
 *   - a footer label, `astir <n>`: the raw count of agents blocked on you,
 *     ungated (PSH-16: the ambient badge is not gated on announcement), or
 *     `astir ?` when astir could not be read or says its count is not whole
 *     (no daemon, another machine's on the port, a daemon or notifier it
 *     could not read). astir's JSON has no "unknown" count: it writes 0 and a
 *     warning, and `astir 0` beside "daemon not running" would be calm drawn
 *     on a broken state.
 *
 * The deciding is all astir's (src/status/line.ts); this module runs it every
 * five seconds and draws what it says. It is display only (NG4): it hooks no
 * tool or prompt, appends nothing to the session, asks no model, writes no
 * file, keeps nothing past the session, and draws no tool, path or
 * description text (SEC-01) — only the line astir composed, which carries
 * counts and fixed words.
 *
 * Never a stale value: a run that fails, times out, exits non-zero or prints
 * what this does not read draws `astir unreachable` and `astir ?`, never the
 * last good answer. A quiet terminal must mean "nothing waits", not "astir
 * stopped answering a while ago".
 */
// The state this keeps (`astir-tui.blocked`, `astir-tui.worked`) is declared
// in the manifest's types contract, types/index.d.ts.
import type { EngineInterface, PluginOptions, Register } from "claude-code";

const BLOCKED = { plugin: "astir-tui", key: "blocked" } as const;
const WORKED = { plugin: "astir-tui", key: "worked" } as const;

const PERIOD_MS = 5_000;
/** Inside the period, so one run is over before the next is due. */
const RUN_TIMEOUT_MS = 3_000;
/** The `status --line --json` major version this reads (VER-01: a minor is additive). */
const LINE_MAJOR = 1;
const UNREACHABLE: Reading = { line: "astir unreachable", blocked: null };
/**
 * A released astir (0.2.0 and before) ignores `--line` and answers `status
 * --json` with its /state document. Said apart from a version skew, which
 * would send the person to update the wrong thing.
 */
const PREDATES: Reading = { line: "astir predates status --line — update astir", blocked: null };
/**
 * The warnings after which astir's count is still the whole count: the
 * daemon answered and every machine was heard, it is only that no one can be
 * told, or that this session is not heard. Every other kind — the daemon or
 * the notifier unread, no daemon, an impostor — leaves `blocked` a 0 or a
 * part, and so does a kind this does not know: a later minor may add one, and
 * guessing it harmless would draw a number this cannot vouch for.
 */
const COUNT_STANDS: ReadonlySet<unknown> = new Set(["no-delivery", "silent"]);

/** What a tick draws: the status line (undefined clears it) and the footer's count. */
interface Reading {
  line: string | undefined;
  blocked: number | null;
}

/** How astir is run, from the person's settings: `entry` undefined means "find it". */
interface Command {
  node: string;
  entry: string | undefined;
}

// One environment per load: a reload drops this with the timer it holds.
let timer: { cancel: () => void } | undefined;

export const register: Register = (on, options) => {
  const how: Command = { node: setting(options, "node") ?? "node", entry: setting(options, "entry") };

  on("session.start", ($, e, next) => {
    timer?.cancel();
    timer = $.clock.every(PERIOD_MS, () => {
      void tick($, how);
    });
    // Not awaited: the first session.start holds the first prompt, and a run
    // may take its whole timeout.
    void tick($, how);
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    await $.session
      .id()
      .then((sid) => $.state.set(WORKED, sid))
      .catch(() => undefined);
    return next(e);
  });

  on("ui.render", { component: "SessionMode" }, async ($, e, next) => {
    const { value: blocked } = await $.state.get(BLOCKED);
    const label = `astir ${typeof blocked === "number" ? blocked : "?"}`;
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } });
  });
};

/**
 * One poll, drawn. Ticks are not serialised: a run is bounded well inside the
 * period, and a guard that a stuck call could hold would freeze the last
 * answer on screen, which is the one thing this must never do.
 */
async function tick($: EngineInterface, how: Command): Promise<void> {
  try {
    const reading = await poll($, how).catch(() => UNREACHABLE);
    $.ui.status(reading.line);
    await $.state.set(BLOCKED, reading.blocked);
  } catch {
    // Only the module or the session going away while a tick was in flight;
    // there is nothing left to draw on.
  }
}

async function poll($: EngineInterface, how: Command): Promise<Reading> {
  const sid = await $.session.id();
  // A session that has had no prompt is in astir's silent[] legitimately: its
  // hooks have not fired yet (measured live on 2.1.291). So this session is
  // asked about only once it has done work, and a /clear's new session has
  // not, whatever the one before it did.
  const { value: worked } = await $.state.get(WORKED);
  const argv = [
    ...(await command($, how)),
    "status",
    "--line",
    "--json",
    ...(worked === sid ? ["--session", sid] : []),
  ];
  const ran = await $.process.run(argv, { timeoutMs: RUN_TIMEOUT_MS });
  return ran.exitCode === 0 ? read(ran.stdout) : UNREACHABLE;
}

/**
 * How astir is run: the entry the person set; else the build of the checkout
 * this plugin was installed in place from (its folder is `<repo>/tui`, so the
 * build is `<repo>/dist/cli/main.js`); else `astir` on PATH.
 */
async function command($: EngineInterface, how: Command): Promise<string[]> {
  if (how.entry !== undefined) return [how.node, how.entry];
  const build = await checkoutBuild($).catch(() => undefined);
  return build === undefined ? ["astir"] : [how.node, build];
}

/**
 * The build of the astir checkout this plugin sits in, or undefined.
 *
 * Proven rather than assumed from where the folder is: a plugin folder copied
 * or loaded from anywhere (`--plugin-dir /tmp/astir-tui`) has some folder
 * above it, and a `dist/cli/main.js` there would otherwise be run as the
 * person every five seconds by whoever could write it. So the folder above
 * must be a checkout whose marketplace names this very folder as astir-tui's
 * source, and the build must be a file. Anything less is PATH's `astir`.
 */
async function checkoutBuild($: EngineInterface): Promise<string | undefined> {
  // The parent and the folder's own name by spelling: there is no path module here.
  const at = /^(.*?)[\\/]+([^\\/]+)[\\/]*$/.exec($.plugin.root);
  if (at === null) return undefined;
  const [, checkout, folder] = at;
  const market = JSON.parse(await $.fs.read(`${checkout}/.claude-plugin/marketplace.json`)) as {
    plugins?: unknown;
  } | null;
  const listed = market?.plugins;
  const plugins: unknown[] = Array.isArray(listed) ? listed : [];
  const vouched = plugins.some((p) => {
    const { name, source } = (p ?? {}) as { name?: unknown; source?: unknown };
    return (
      name === "astir-tui" && typeof source === "string" && source.replace(/^\.[\\/]|[\\/]+$/g, "") === folder
    );
  });
  if (!vouched) return undefined;
  const build = `${checkout}/dist/cli/main.js`;
  const found = await $.fs.stat(build);
  return found.kind === "file" ? build : undefined;
}

/** A `userConfig` string, or undefined when it is unset or blank. */
function setting(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** `astir status --line --json`'s output, or unreachable when it is not that. */
function read(stdout: string): Reading {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return UNREACHABLE;
  }
  if (typeof json !== "object" || json === null) return UNREACHABLE;
  // Before the version: an older astir's /state document carries a `v` of its
  // own (2.x), which is not this command's.
  if (!("line" in json) && "blockedCount" in json) return PREDATES;
  const { v, line, blocked, warnings } = json as {
    v?: { major?: unknown };
    line?: unknown;
    blocked?: unknown;
    warnings?: unknown;
  };
  const major = v?.major;
  if (typeof major !== "number") return UNREACHABLE;
  if (major !== LINE_MAJOR) {
    // Refused rather than drawn from a misreading, and said, so it is not
    // taken for a daemon that is down.
    return {
      line: `astir speaks status --line v${major}; astir-tui reads v${LINE_MAJOR} — update one of them`,
      blocked: null,
    };
  }
  // Each a field v1 always writes: one missing is a broken contract, and a
  // lost `line` beside a good count would clear the line and draw calm.
  if (!(typeof line === "string" || line === null)) return UNREACHABLE;
  if (typeof blocked !== "number" || !Number.isInteger(blocked) || blocked < 0) return UNREACHABLE;
  if (!Array.isArray(warnings)) return UNREACHABLE;
  const whole = warnings.every((w: unknown) => COUNT_STANDS.has((w as { kind?: unknown } | null)?.kind));
  // The impostor warning names another daemon's host, which that daemon
  // reports about itself: nothing it says reaches the terminal as an escape.
  // The engine already leads the line with `⚠ astir-tui:`. astir's own
  // `astir:` is for a tmux segment, where nothing else says whose line it is;
  // here it would read `astir-tui: astir: …`.
  const shown = line?.replace(/\p{Cc}/gu, "").replace(/^astir:\s*/, "");
  return { line: shown === "" ? undefined : shown, blocked: whole ? blocked : null };
}
