/**
 * astir-tui: astir inside Claude Code's own terminal (#80, #81).
 *
 * Three things are drawn:
 *
 *   - the status line under the prompt, which is `astir status --line`'s one
 *     line: a warning when no one would be told (daemon down, an impostor on
 *     the port, no live delivery path, this session unheard), then the
 *     announced blocks. Empty when there is nothing to say.
 *   - a footer label, `astir <n>`: the raw count of agents blocked on you,
 *     ungated (PSH-16: the ambient badge is not gated on announcement), or
 *     `astir ?` when astir could not be read or says its count is not whole
 *     (no daemon, another machine's on the port, a daemon or notifier it
 *     could not read, a machine it lost contact with, a daemon older than
 *     it). astir's JSON has no "unknown" count: it writes 0 and a
 *     warning, and `astir 0` beside "daemon not running" would be calm drawn
 *     on a broken state.
 *   - `/astir`, a pane: the sessions astir knows of, in astir's own order
 *     (blocked first, VIEW-09), each with its state word and how long it has
 *     waited (VIEW-12). Go on each row astir says it can raise (PSH-11), `g`
 *     to go to the longest-waiting blocked one, `d` to dismiss the
 *     longest-waiting blocked one wherever it is (PSH-10), and Close.
 *
 * Two things are done, each only on the person's press in that pane: `astir
 * focus <id>` and `astir dismiss <id>`. Nothing else is ever run but `status`:
 * never `view`, whose fallback on a headless host prints its token URL
 * (DMN-01).
 *
 * The deciding is all astir's (src/status/line.ts); this module runs it every
 * five seconds and draws what it says. Apart from those two presses it is
 * display only (NG4): it hooks no tool or prompt, appends nothing to the
 * session, asks no model, writes no file, keeps nothing past the session, and
 * `/astir` hands the model nothing. It draws no tool, path or description
 * text (SEC-01): only the line astir composed, which carries counts and fixed
 * words, and the pane's repo labels, host names and state words, with their
 * control characters taken out.
 *
 * Never a stale value: a run that fails, times out, exits non-zero or prints
 * what this does not read draws `astir unreachable` and `astir ?`, never the
 * last good answer, and the pane draws no rows and nothing to press but
 * Close. A quiet terminal must mean "nothing waits", not "astir stopped
 * answering a while ago".
 */
// The state this keeps (`astir-tui.blocked`, `.worked`, `.rows`, `.detail`) is
// declared in the manifest's types contract, types/index.d.ts.
import type { EngineInterface, PluginOptions, ProcessRunResult, Register } from "claude-code";

import type { PaneRow } from "../types";

const BLOCKED = { plugin: "astir-tui", key: "blocked" } as const;
const WORKED = { plugin: "astir-tui", key: "worked" } as const;
const ROWS = { plugin: "astir-tui", key: "rows" } as const;
const DETAIL = { plugin: "astir-tui", key: "detail" } as const;

const PERIOD_MS = 5_000;
/** Inside the period, so one run is over before the next is due. */
const RUN_TIMEOUT_MS = 3_000;
/** The `status --line --json` major version this reads (VER-01: a minor is additive). */
const LINE_MAJOR = 1;
const UNREACHABLE: Reading = { line: "astir unreachable", blocked: null, rows: null };
/**
 * A released astir (0.2.0 and before) ignores `--line` and answers `status
 * --json` with its /state document. Said apart from a version skew, which
 * would send the person to update the wrong thing.
 */
const PREDATES: Reading = { line: "astir predates status --line — update astir", blocked: null, rows: null };
/**
 * The warnings after which astir's count is still the whole count: the
 * daemon answered and every machine was heard, it is only that no one can be
 * told, or that this session is not heard. Every other kind — the daemon or
 * the notifier unread, no daemon, an impostor — leaves `blocked` a 0 or a
 * part, and so does a kind this does not know: a later minor may add one, and
 * guessing it harmless would draw a number this cannot vouch for.
 *
 * Two of line v1.1's are left out on purpose, not by lag: `contact-lost` (a
 * machine where an agent was waiting went quiet, so that agent is in no count)
 * and `old-daemon` (a daemon older than the CLI reading it, a skew whose count
 * this does not vouch for until it is restarted).
 */
const COUNT_STANDS: ReadonlySet<unknown> = new Set(["no-delivery", "silent"]);

/** The pane's id: what `$.ui.open` and `$.ui.close` name, and its `ui.render`'s `requestId`. */
const PANE = "astir";
/** What `/astir` says of itself in the typeahead and `/help`. */
const DESCRIPTION = "Sessions astir knows of, blocked first: go to one, or dismiss what waits";
/**
 * Said while the pane does not hold the keys, or its hotkeys could not be
 * found. Not "Esc": while a turn runs, Esc at the prompt interrupts Claude (G6).
 */
const KEYS_HINT = "ctrl+x tab gives this pane the keys";
/** `focus` asks the daemon, which may raise a tmux pane: more than a poll's time, still bounded. */
const ACT_TIMEOUT_MS = 5_000;
/** The most of an action's answer the pane draws. */
const DETAIL_MAX = 120;
/** What a row's `[ Go ]` takes, with the space before it. */
const GO_CELLS = 7;
/** The most of a row's name the `g` and `d` Buttons draw. */
const NAMED_MAX = 24;
/**
 * The most of a state word a row draws: astir's own longest is
 * `tool-running`. A remote row's is whatever its machine's roster said, and
 * one long word must not squeeze every row's name to nothing.
 */
const STATE_MAX = 12;
/**
 * A session id the pane hands back to astir as one argument: not empty, no
 * whitespace or control character, no longer than the daemon takes one
 * (4096, src/contract/event.ts), and not led by `-`, so astir's argument
 * parser can never read it as a flag.
 */
const SESSION_ID = /^[^\s\p{Cc}-][^\s\p{Cc}]{0,4095}$/u;

/** What a tick draws: the status line (undefined clears it), the footer's count and the pane's rows. */
interface Reading {
  line: string | undefined;
  blocked: number | null;
  /** null when this reading is not one to draw rows from. */
  rows: PaneRow[] | null;
}

/** How astir is run, from the person's settings: `entry` undefined means `astir` on PATH. */
interface Command {
  /** What runs `entry`; PATH's `astir` brings its own. */
  node: string;
  entry: string | undefined;
}

/**
 * What one load keeps between its ticks and its presses. None of it is drawn,
 * so none of it is `$.state`.
 */
interface Pace {
  /** The number the tick that started last was given. */
  started: number;
  /** The number of the newest tick whose reading is drawn. */
  drawn: number;
  /**
   * The first tick whose good reading clears the action's answer: none
   * (Infinity) while the answer must still stand.
   */
  clearsFrom: number;
  /** The wait after which the answer standing may go. */
  ripening: { cancel: () => void } | undefined;
}

// One environment per load: a reload drops this with the timer it holds.
let timer: { cancel: () => void } | undefined;

export const register: Register = (on, options) => {
  const how: Command = { node: setting(options, "node") ?? "node", entry: setting(options, "entry") };
  const pace: Pace = { started: 0, drawn: 0, clearsFrom: 0, ripening: undefined };

  on("session.start", async ($, e, next) => {
    timer?.cancel();
    timer = $.clock.every(PERIOD_MS, () => {
      void tick($, how, pace);
    });
    // Not awaited: the first session.start holds the first prompt, and a run
    // may take its whole timeout.
    void tick($, how, pace);
    // `immediate`: typed mid-turn it opens at once, rather than when the turn
    // that keeps someone waiting has ended.
    await $.command.register({ name: "astir", description: DESCRIPTION, immediate: true });
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

  on("command.run", { command: "astir" }, async ($) => {
    // Read again as it opens. Not awaited: the pane is up at once, drawn from
    // the last reading, and drawn again when this one lands.
    void tick($, how, pace);
    const { value: rows } = await $.state.get(ROWS);
    const n = Array.isArray(rows) ? rows.length : 0;
    // `focus`, or Esc during a turn is the prompt's and interrupts Claude (G6).
    await $.ui.open({
      id: PANE,
      title: "astir",
      focus: true,
      closeOnEscape: true,
      rows: Math.min(12, Math.max(4, n + 3)),
    });
    // Never `{ text }`: that would be a transcript row the model reads (NG4).
    return {};
  }).catch(() => ({}));

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e);
    const { value: rows } = await $.state.get(ROWS);
    const { value: detail } = await $.state.get(DETAIL);
    const { value: blocked } = await $.state.get(BLOCKED);
    const columns = Math.max(1, e.props.bodyColumns);
    const list = Array.isArray(rows) ? rows : [];

    const hasGo = list.some((r) => r.focusable);
    const texts = rowTexts(list, Math.max(1, columns - (hasGo ? GO_CELLS : 0)), hasGo);
    // Exactly one `g` and one `d`, never a hotkey per row: when two Buttons
    // share one, the later gets it. Each says whose it is, so a press is never
    // a surprise; the row it acts on is the one it names.
    const goTo = longest(list.filter((r) => r.focusable));
    const dismissing = longest(list);
    const goLabel = goTo && named("go to ", goTo, columns);
    const dismissLabel = dismissing && named("dismiss ", dismissing, columns);
    // A plain Button with a hotkey draws `g: label`; Close draws `[ Close ]`.
    const actionCells = [goLabel, dismissLabel]
      .filter((label) => label !== undefined)
      .reduce((cells, label) => cells + 3 + width(label) + 2, 9);

    // The table's constructors, called as JSX would call them: typed by each
    // element's props, in a module biome lints (it reads `tui/**/*.ts`).
    return Box({
      flexDirection: "column",
      children: [
        rows === undefined && Text({ dimColor: true, children: "asking astir…" }),
        rows === null && Text({ children: "astir unreachable" }),
        Array.isArray(rows) &&
          typeof blocked !== "number" &&
          Text({
            dimColor: true,
            children: clip("astir cannot see every session: the line below the prompt says why", columns),
          }),
        Array.isArray(rows) &&
          typeof blocked === "number" &&
          rows.length === 0 &&
          Text({ children: "astir knows of no sessions" }),
        // The answer, the hint and the keys come before the sessions: the pane
        // asks for at most 12 rows, so with many sessions anything drawn after
        // them scrolls out of view — and `g`/`d` would act on a name the
        // person cannot see.
        typeof detail === "string" && Text({ children: clip(detail, columns) }),
        !e.props.isFocused && Text({ dimColor: true, children: clip(KEYS_HINT, columns) }),
        Box({
          key: "actions",
          flexDirection: actionCells <= columns ? "row" : "column",
          columnGap: 2,
          children: [
            goTo !== undefined &&
              goLabel !== undefined &&
              Button({
                key: "g",
                hotkey: "g",
                plain: true,
                label: goLabel,
                onPress: () => go($, pace, how, goTo),
              }),
            dismissing !== undefined &&
              dismissLabel !== undefined &&
              Button({
                key: "d",
                hotkey: "d",
                plain: true,
                label: dismissLabel,
                onPress: () => dismiss($, pace, how, dismissing),
              }),
            Button({ key: "close", role: "dismiss", label: "Close", onPress: () => close($) }),
          ],
        }),
        ...list.map((r, i) =>
          Box({
            key: `row:${i}`,
            flexDirection: "row",
            columnGap: 1,
            children: [
              Text({ wrap: "truncate-end", children: texts[i] }),
              r.focusable &&
                Button({ key: `go:${r.sessionId}`, label: "Go", onPress: () => go($, pace, how, r) }),
            ],
          }),
        ),
      ],
    });
  });
};

/**
 * One poll, drawn. Ticks are not serialised: a run is bounded well inside the
 * period, and a guard that a stuck call could hold would freeze the last
 * answer on screen, which is the one thing this must never do.
 *
 * So they may land out of order, and each is numbered as it starts. A reading
 * that lands after a newer one is drawn is older than what is on screen, and
 * is dropped: a poll in flight as `d` is pressed answers for the moment before
 * the dismiss, and drawn last it would put the row back as blocked.
 */
async function tick($: EngineInterface, how: Command, pace: Pace): Promise<void> {
  const mine = ++pace.started;
  try {
    const reading = await poll($, how).catch(() => UNREACHABLE);
    if (mine < pace.drawn) return;
    pace.drawn = mine;
    // An action's answer stands until astir is read well by a tick begun once
    // it has stood a period (say): never by one begun before it was said.
    const clears = reading.rows !== null && mine >= pace.clearsFrom;
    // Every write asked for at once, so no later tick's or press's lands
    // between them.
    $.ui.status(reading.line);
    await Promise.all([
      $.state.set(BLOCKED, reading.blocked),
      $.state.set(ROWS, reading.rows),
      ...(clears ? [$.state.set(DETAIL, null)] : []),
    ]);
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
  const argv = [...command(how), "status", "--line", "--json", ...(worked === sid ? ["--session", sid] : [])];
  const ran = await $.process.run(argv, { timeoutMs: RUN_TIMEOUT_MS });
  return ran.exitCode === 0 ? read(ran.stdout) : UNREACHABLE;
}

/**
 * Go: `astir focus <id>`, which raises the session's tmux window and pane.
 * Once it has, the person has left the pane, so it closes; when it has not,
 * the pane stays and says why, in astir's own words.
 */
async function go($: EngineInterface, pace: Pace, how: Command, row: PaneRow): Promise<void> {
  let ran: ProcessRunResult;
  try {
    ran = await $.process.run(act(how, "focus", row.sessionId), { timeoutMs: ACT_TIMEOUT_MS });
  } catch {
    await say($, pace, `could not go to ${row.label}: astir did not answer`);
    return;
  }
  if (ran.exitCode === 0) {
    await $.ui.close({ id: PANE });
    return;
  }
  await say(
    $,
    pace,
    `could not go to ${row.label}: ${firstLine(ran) ?? `astir focus exited ${ran.exitCode}`}`,
  );
}

/**
 * Dismiss (PSH-10): `astir dismiss <id>`, which acknowledges the session's
 * blocks on this machine's daemon and the notifier's alike. astir is read
 * again so the row shows it, and then its one-line answer is drawn.
 */
async function dismiss($: EngineInterface, pace: Pace, how: Command, row: PaneRow): Promise<void> {
  let answer: string;
  try {
    const ran = await $.process.run(act(how, "dismiss", row.sessionId), { timeoutMs: ACT_TIMEOUT_MS });
    const said = firstLine(ran);
    answer =
      ran.exitCode === 0
        ? (said ?? "dismissed")
        : `could not dismiss ${row.label}: ${said ?? `astir dismiss exited ${ran.exitCode}`}`;
  } catch {
    answer = `could not dismiss ${row.label}: astir did not answer`;
  }
  await tick($, how, pace);
  await say($, pace, answer);
}

async function close($: EngineInterface): Promise<void> {
  await $.ui.close({ id: PANE });
}

/**
 * Sets the pane's one line of answer: one line, no control characters,
 * bounded. It stands a period at least, whenever in the period it was said:
 * no reading begun before it, or within the period after it, takes it away,
 * so a failed Go's reason is there to be read.
 */
async function say($: EngineInterface, pace: Pace, text: string): Promise<void> {
  pace.clearsFrom = Number.POSITIVE_INFINITY;
  pace.ripening?.cancel();
  pace.ripening = $.clock.after(PERIOD_MS, () => {
    pace.clearsFrom = pace.started + 1;
  });
  await $.state.set(DETAIL, clip(clean(text), DETAIL_MAX));
}

/** The first line a run wrote that says anything, stdout before stderr, less astir's `astir:` lead. */
function firstLine(ran: ProcessRunResult): string | undefined {
  for (const out of [ran.stdout, ran.stderr]) {
    const line = out
      .split(/\r?\n/)
      .map((l) =>
        clean(l)
          .replace(/^astir:\s*/, "")
          .trim(),
      )
      .find((l) => l !== "");
    if (line !== undefined) return line;
  }
  return undefined;
}

/**
 * An action's argv. The only two verbs this module ever runs besides
 * `status`; `view` is never one (DMN-01).
 */
function act(how: Command, verb: "focus" | "dismiss", sessionId: string): string[] {
  return [...command(how), verb, sessionId];
}

/**
 * How astir is run: the entry the person set, else `astir` on their PATH.
 *
 * Nothing found on disk is a third way. A build beside the plugin's folder
 * (`<checkout>/dist/cli/main.js` above `<checkout>/tui`) is the checkout's only
 * on the word of files in that same folder, and the folder above a plugin
 * loaded from a shared /tmp is anyone's to write: whoever put a vouch there
 * would have their build run as the person every five seconds, and `$.fs.stat`
 * has no owner to tell them apart. So only the person's own say decides.
 */
function command(how: Command): string[] {
  return how.entry === undefined ? ["astir"] : [how.node, how.entry];
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
  const { v, line, blocked, warnings, rows } = json as {
    v?: { major?: unknown };
    line?: unknown;
    blocked?: unknown;
    warnings?: unknown;
    rows?: unknown;
  };
  const major = v?.major;
  if (typeof major !== "number") return UNREACHABLE;
  if (major !== LINE_MAJOR) {
    // Refused rather than drawn from a misreading, and said, so it is not
    // taken for a daemon that is down.
    return {
      line: `astir speaks status --line v${major}; astir-tui reads v${LINE_MAJOR} — update one of them`,
      blocked: null,
      rows: null,
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
  // `rows` is v1's too, but only the pane reads it: one missing leaves the
  // line and the count as they are, and the pane with no rows to offer.
  return { line: shown === "" ? undefined : shown, blocked: whole ? blocked : null, rows: readRows(rows) };
}

/** astir's rows, each shape-checked; one that is not a row is dropped, not drawn. */
function readRows(value: unknown): PaneRow[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((r: unknown) => {
    const row = readRow(r);
    return row === undefined ? [] : [row];
  });
}

function readRow(value: unknown): PaneRow | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { sessionId, host, label, state, waitingMs, acknowledged, announced, focusable } = value as Record<
    string,
    unknown
  >;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return undefined;
  if (!(host === null || typeof host === "string")) return undefined;
  if (typeof label !== "string") return undefined;
  if (!(state === null || typeof state === "string")) return undefined;
  if (
    !(waitingMs === null || (typeof waitingMs === "number" && Number.isFinite(waitingMs) && waitingMs >= 0))
  ) {
    return undefined;
  }
  if (typeof acknowledged !== "boolean" || typeof announced !== "boolean" || typeof focusable !== "boolean") {
    return undefined;
  }
  // A remote row's label and host come from another machine: nothing in them
  // reaches the terminal as an escape.
  return {
    sessionId,
    host: host === null ? null : clean(host) || "?",
    label: clean(label) || "?",
    state: state === null ? null : clean(state),
    waitingMs,
    acknowledged,
    announced,
    // Another machine's session has no window here (PSH-11). astir never says
    // otherwise; a row that did would not be taken at its word.
    focusable: focusable && host === null,
  };
}

/**
 * Of the rows blocked and not dismissed, the one that has waited longest; on
 * a tie, the first in astir's order.
 */
function longest(rows: readonly PaneRow[]): PaneRow | undefined {
  let best: PaneRow | undefined;
  for (const r of rows) {
    if (r.state !== "blocked" || r.acknowledged || r.waitingMs === null) continue;
    if (best === undefined || r.waitingMs > (best.waitingMs ?? 0)) best = r;
  }
  return best;
}

/**
 * Each row as one line of at most `cells`: its name (label, and ` · host` for
 * another machine's), its state, its wait and whether it was dismissed, in
 * columns. The label gives way first, never the words after it, and a row is
 * never wrapped onto a second line. With `aligned`, each is padded to `cells`
 * so the Go Buttons stand in one column.
 */
function rowTexts(rows: readonly PaneRow[], cells: number, aligned: boolean): string[] {
  const states = rows.map((r) => clip(r.state ?? "unknown", STATE_MAX));
  const stateCells = Math.max(0, ...states.map(width));
  const tails = rows.map((r, i) => {
    // `for`, not `waiting`: the state word beside it may itself be `waiting`.
    const wait = r.waitingMs === null ? "" : `  for ${coarse(r.waitingMs)}`;
    return `  ${(states[i] ?? "").padEnd(stateCells)}${wait}${r.acknowledged ? "  dismissed" : ""}`.trimEnd();
  });
  const tailCells = Math.max(0, ...tails.map(width));
  const nameCells = Math.max(1, Math.min(Math.max(0, ...rows.map((r) => width(who(r)))), cells - tailCells));
  return rows.map((r, i) => {
    const text = clip(`${fitName(r, nameCells).padEnd(nameCells)}${tails[i] ?? ""}`, cells);
    return aligned ? text.padEnd(cells) : text;
  });
}

/** A row's name: its label, and the machine it is on when that is not this one. */
function who(row: PaneRow): string {
  return row.host === null ? row.label : `${row.label} · ${row.host}`;
}

/** A row's name in at most `cells`: the label cut before the host is. */
function fitName(row: PaneRow, cells: number): string {
  const name = who(row);
  if (width(name) <= cells || row.host === null) return clip(name, cells);
  const where = ` · ${row.host}`;
  return width(where) + 2 <= cells ? `${clip(row.label, cells - width(where))}${where}` : clip(name, cells);
}

/** A `g` or `d` Button's label: what it does, to whom, and how long they have waited. */
function named(verb: string, row: PaneRow, columns: number): string {
  const since = ` (${coarse(row.waitingMs ?? 0)})`;
  const room = Math.max(1, Math.min(NAMED_MAX, columns - 3 - width(verb) - width(since)));
  return `${verb}${fitName(row, room)}${since}`;
}

/**
 * A wait as the status line says it (`oldest 3m`): the largest unit alone,
 * as astir's `coarse` does (src/status/line.ts).
 */
function coarse(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** `text` in at most `cells` characters, its end given way to `…`. */
function clip(text: string, cells: number): string {
  const chars = [...text];
  if (chars.length <= cells) return text;
  return cells <= 0 ? "" : `${chars.slice(0, cells - 1).join("")}…`;
}

function width(text: string): number {
  return [...text].length;
}

function clean(text: string): string {
  return text.replace(/\p{Cc}/gu, "");
}
