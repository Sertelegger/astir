/**
 * #80 — `astir status --line`: one line, in the terminal you are typing in.
 *
 * On a box reached over SSH and tmux, a blocked agent reached you through
 * exactly one path — another machine's notifier — and nothing where you were
 * looking said anything. This is the surface that sits there: a tmux
 * `status-right` segment (`#(astir status --line)`) and the `astir-tui` mod both
 * print what this returns, and neither decides anything for itself.
 *
 * It is the second serialiser `menu.ts` anticipated, NOT a parse of MenuJson,
 * whose meaning lives in SF Symbol names. `statusLine` decides; `runStatusLine`
 * fetches and serialises. The deciding half is pure so every case below is a
 * test with no network and no processes.
 *
 * ## What it may say
 *
 * One line, or nothing. Warnings first, and only the first that applies — a
 * tmux segment has room for one thing, and the first is the one that makes the
 * rest meaningless:
 *
 *   1. no daemon — nothing is watching, so no one will be told;
 *   2. another machine's daemon on the port — everything else would be ITS state;
 *   3. a daemon older than this astir — it cannot say which blocks it announced;
 *   4. no delivery path is live (#78) — astir sees the block and cannot say so;
 *   5. contact lost with a machine where an agent was waiting (DMN-09);
 *   6. this session is in `silent[]` — astir cannot hear the very session asking.
 *
 * (`/state` that cannot be read, and a notifier that does not answer, are
 * `unreachable` — see `statusLine` for where each sits.)
 *
 * Then the blocks, as counts. Never a session name (PSH-11: a surface that
 * names a session must be able to raise it, and a status line cannot), and
 * never tool, path, description or reason text (SEC-01).
 *
 * Only blocks the notify loop has ANNOUNCED are counted in the line. PSH-16
 * leaves the ambient badge ungated because it costs no attention; a warning
 * under the prompt does, so a block the provider answers itself in under a
 * second must not flash it. `blocked` in the JSON is the ungated count, for a
 * dim footer label that IS the ambient badge. No dwell is applied here — that
 * is a per-provider capability the loop owns (CAP-02), and `announcedAt` is its
 * verdict.
 */

import { hostname } from "node:os";
import { DEFAULT_PORT } from "../config/paths.js";
import { sameHost, shortHost } from "../notify/envelope.js";
import { mergeRemoteSessions } from "../notify/roster.js";
import { humanDuration } from "./agents.js";
import {
  fetchHealth,
  fetchRemote,
  fetchStatus,
  foreignHost,
  type RemoteAgentView,
  UNNAMED_HOST,
} from "./fetch.js";
import { ancestry, defaultProbeDeps, type FocusDeps, type ProbeDeps } from "./focus.js";
import { overview } from "./overview.js";
import type { HealthBody, RemoteSession, StatusBody, StatusResult } from "./types.js";

/** VER-01 — bumped on minor for an added field, major for a changed one. */
export const LINE_JSON_VERSION = { major: 1, minor: 1 } as const;

/**
 * VER-01 — the first `/state` that carries `announcedAt`. Below it the line
 * cannot tell an announced block from one the dwell is still holding.
 */
const STATE_ANNOUNCES = { major: 2, minor: 2 } as const;

/**
 * How long the whole fetch may take. A tmux segment re-runs every few seconds
 * and the TUI mod kills a run at 3s; a line that arrives late is a line that
 * describes the past.
 */
export const DEFAULT_LINE_BUDGET_MS = 1_500;

/** The exact words, exported so a host's tests can assert against them. */
export const LINE_TEXT = {
  daemonDown: "astir: daemon not running — no one will be told",
  impostor: (port: number, host: string): string =>
    `astir: port ${port} is ${host}'s daemon, not this machine's`,
  noDelivery: "astir: nothing can notify you — no notifier is reachable",
  silent: "astir: hears nothing from this session",
  unreachable: "astir unreachable",
  notifierHung: "astir: notifier not answering",
  oldDaemon: "astir: the daemon is older than this astir — restart it",
  contactLost: (machines: number): string =>
    `astir: lost contact with ${machines} machine${machines === 1 ? "" : "s"} where an agent was waiting`,
} as const;

export interface LineOpts {
  /** The session asking (`--session`). Only then can `silent[]` be checked. */
  session: string | null;
  json: boolean;
  port?: number;
  notifyPort?: number;
  /** The total budget for every fetch together. */
  timeoutMs?: number;
  /**
   * #79 — a notifier is expected on this machine (a supervised one, a paired
   * host), so its silence is a fault, not the single-machine norm. The CLI
   * decides, from the same facts it hands `remoteForMenu`; omitted, a notifier
   * that is simply not there says nothing. See `LineInput.notifierExpected`.
   */
  notifierExpected?: boolean;
}

/** Additive since 1.0: `old-daemon` and `contact-lost` arrived in 1.1. A host must fail closed on a kind it does not know. */
export type LineWarningKind =
  | "daemon-down"
  | "impostor"
  | "old-daemon"
  | "no-delivery"
  | "contact-lost"
  | "silent"
  | "unreachable";

export interface LineWarning {
  kind: LineWarningKind;
  text: string;
}

/** One session, for a host that lists them. Labels and states only — see SEC-01 above. */
export interface LineRow {
  sessionId: string;
  /** The machine, when it is not this one. */
  host: string | null;
  /** The disambiguated repo label `overview()` gives it. */
  label: string;
  state: string | null;
  /** How long its longest current block has lasted; null when nothing is blocked. */
  waitingMs: number | null;
  /** Every block in it has been dismissed. */
  acknowledged: boolean;
  /**
   * Some block in it has been announced to a human. Always false for a local
   * row under `old-daemon`, which cannot say — the warning is what tells a host.
   */
  announced: boolean;
  /** PSH-11 — `focusSession` could act on it from here. */
  focusable: boolean;
}

export interface LineResult {
  v: { major: number; minor: number };
  /** What to print, or null for nothing at all. */
  line: string | null;
  /** UNGATED — every block, announced or not, for the ambient label. */
  blocked: number;
  /**
   * Announced, undismissed blocks — what the line counts. Against an older
   * daemon (`old-daemon`) that is every undismissed block, announced or not,
   * because the daemon cannot say which it announced.
   *
   * Both counts are only whole when every warning is `no-delivery` or `silent`:
   * the daemon answered and every machine was heard, it is only that no one can
   * be told. Under `daemon-down`, `impostor` or `unreachable` (the daemon, or
   * the notifier, could not be read) they are 0 or a part, never a guess; under
   * `contact-lost` a machine's agents are left out because their state is
   * unknown; under `old-daemon` the line's count is ungated. A host must draw
   * all of those as unknown, as astir-tui does.
   */
  announced: number;
  /** Every warning that applies, most important first. The line shows the first. */
  warnings: LineWarning[];
  /** Worst first, through `overview()` (VIEW-09). */
  rows: LineRow[];
}

/** What the notifier said, as `fetchRemote` returns it; null when it said nothing. */
export type RemoteState = { agents: RemoteAgentView[]; sessions: RemoteSession[] } | null;

export interface LineInput {
  session: string | null;
  /** For naming the port in the impostor warning. */
  port: number;
  /** The DAEMON did not answer within the budget. Overrides everything else. */
  timedOut?: boolean;
  /**
   * The notifier accepted the connection and did not answer within the budget
   * (`remote` is then null). Not the same as no notifier: see `runStatusLine`.
   */
  remoteTimedOut?: boolean;
  /**
   * #79 — a notifier should be answering here, so `remote: null` is a fault.
   *
   * `fetchRemote` says null for every failure — nothing listening, no token, a
   * refusal — so null alone cannot tell a notifier that went away from one that
   * was never here. On a single machine that never paired anything it was never
   * here, and a warning drawn permanently over an idle install teaches people
   * to ignore the line. So null is calm unless the caller says one is expected,
   * exactly as `remoteForMenu` decides for the menu bar; then it is the same
   * warning as a hung one, because other machines' blocks are just as unknown.
   * A hang needs no such flag: something accepted the connection, so something
   * was meant to be there.
   */
  notifierExpected?: boolean;
  /** `/healthz`, or null when nothing usable answered. */
  health: HealthBody | null;
  status: StatusResult;
  remote: RemoteState;
  now: number;
  /** This machine's name, for the impostor check and for dropping our own doorbells. */
  selfHost: string;
  /** PSH-11 — whether a local pid could be focused. Omitted: none can. */
  focusable?: (pid: number) => boolean;
}

/** `3m 12s` → `3m`: a status line has room for the unit that matters, not the remainder. */
const coarse = (ms: number): string => humanDuration(ms).split(" ")[0] ?? "";

const unreachable = (): LineResult => ({
  v: { ...LINE_JSON_VERSION },
  line: LINE_TEXT.unreachable,
  // Zero rather than a guess. A host must read the `unreachable` warning as
  // "unknown"; carrying the last good count forward would be the stale value
  // this exists to never show.
  blocked: 0,
  announced: 0,
  warnings: [{ kind: "unreachable", text: LINE_TEXT.unreachable }],
  rows: [],
});

/**
 * VER-01 — a `/state` older than the first that says what it announced.
 *
 * A missing or malformed `v` counts as older: every astir daemon has sent one,
 * so a body without it is not one whose `announcedAt` can be read. A newer
 * major is not older.
 */
function announcesNothing(v: unknown): boolean {
  const { major, minor } = (typeof v === "object" && v !== null ? v : {}) as {
    major?: unknown;
    minor?: unknown;
  };
  if (typeof major !== "number" || typeof minor !== "number") return true;
  return major < STATE_ANNOUNCES.major || (major === STATE_ANNOUNCES.major && minor < STATE_ANNOUNCES.minor);
}

/** Everything the line says, decided with no I/O. */
export function statusLine(input: LineInput): LineResult {
  const { status, health, selfHost, now } = input;

  // A timeout is not "no daemon". Something accepted the connection, or the
  // budget ran out first; either way nothing is known, and saying anything
  // more specific would be a guess.
  if (input.timedOut === true || (!status.ok && status.kind === "timeout")) return unreachable();

  // Whose daemon is this? `/healthz` answers without a token, so it can tell
  // even when `/state` cannot be read — and a box with no token yet is the
  // likeliest place for a forwarded port to be what answers.
  const impostor =
    !status.ok && status.kind === "foreign"
      ? (status.host ?? foreignHost(health?.host, selfHost) ?? UNNAMED_HOST)
      : foreignHost(health?.host, selfHost);

  // Did anything that is a daemon answer at all? A 401 or a 500 is a daemon
  // answering; "no token" with nothing on `/healthz` is one that is not there.
  const answered =
    status.ok ||
    health !== null ||
    status.kind === "rejected" ||
    status.kind === "http" ||
    status.kind === "foreign";

  // An impostor's sessions are another machine's, and counting them here is
  // precisely the lie the host check exists to stop.
  const mine = answered && impostor === null;
  const local: StatusBody | null = status.ok && mine ? status.body : null;
  // Against a daemon too old to say what it announced, every undismissed block
  // is counted, ungated: it IS announcing them, with its own dwell, and a line
  // that showed nothing while agents waited would be the worse lie.
  const older = local !== null && announcesNothing(local.v);

  // What this machine sent comes back through a notifier reached over `ssh -R`;
  // `fetchRemote` drops it, and so does this, so a hand-fed input cannot
  // count a local block twice.
  const doorbells = (input.remote?.agents ?? []).filter((d) => !sameHost(d.host, selfHost));
  // Dismissed or contact-lost doorbells are not counted, exactly as the menu
  // bar's badge does not count them.
  const ringing = (d: RemoteAgentView): boolean => !d.acknowledged && d.stale !== true;
  // DMN-09 — but a contact-lost one is not nothing. The menu bar draws it red
  // ("unreachable"), dismissed or not, because the agent may still be waiting
  // and we stopped being told; leaving it out of the count WITHOUT a warning
  // would look exactly like a block that was answered. Machines, not agents:
  // what was lost is the contact.
  const lost = new Set(doorbells.filter((d) => d.stale === true).map((d) => shortHost(d.host).toLowerCase()));

  // Pushed in precedence order; the line shows the first.
  const warnings: LineWarning[] = [];
  if (!answered) {
    warnings.push({ kind: "daemon-down", text: LINE_TEXT.daemonDown });
  } else if (impostor !== null) {
    warnings.push({ kind: "impostor", text: LINE_TEXT.impostor(input.port, impostor) });
  }
  if (older) warnings.push({ kind: "old-daemon", text: LINE_TEXT.oldDaemon });
  if (mine) {
    // Absent is "an older daemon, cannot tell" — not "nothing is live".
    const live = health?.delivery?.live;
    if (Array.isArray(live) && live.length === 0) {
      warnings.push({ kind: "no-delivery", text: LINE_TEXT.noDelivery });
    }
    if (!status.ok) {
      // The daemon is there and `/state` could not be read: no token, a stale
      // one, a 500. None of the other warnings fit, and printing nothing would
      // read as "all quiet" — so it says why, and a host reads it as unknown.
      warnings.push({ kind: "unreachable", text: `astir: ${status.reason}` });
    }
  }
  // Listed even when the daemon is down: the notifier is a separate process,
  // and what it says survives the daemon dying.
  if (lost.size > 0) warnings.push({ kind: "contact-lost", text: LINE_TEXT.contactLost(lost.size) });
  if (
    local !== null &&
    input.session !== null &&
    (local.silent ?? []).some((s) => s.sessionId === input.session)
  ) {
    warnings.push({ kind: "silent", text: LINE_TEXT.silent });
  }

  // Last, and so shown only when nothing above applies: other machines'
  // blocks are unknown, which is not the same as there being none. It never
  // meets `contact-lost`: stale doorbells come only from a notifier that
  // answered, and this is one that did not.
  const notifierSilent = input.remote === null && input.notifierExpected === true;
  if (input.remoteTimedOut === true || notifierSilent) {
    warnings.push({ kind: "unreachable", text: LINE_TEXT.notifierHung });
  }

  const waits: number[] = [];
  for (const s of local?.sessions ?? []) {
    for (const a of s.agents ?? []) {
      // From a current daemon, `announcedAt` null (or absent) is not announced:
      // the line would rather say nothing about a block than flash one the
      // loop's dwell has not cleared.
      if (a.state === "blocked" && !a.acknowledged && (older || a.announcedAt != null))
        waits.push(a.inStateMs);
    }
  }
  // A doorbell IS an announcement: the remote loop rang it after its own dwell.
  for (const d of doorbells) if (ringing(d)) waits.push(Math.max(0, now - d.since));

  const summary =
    waits.length === 0 ? null : `${waits.length} waiting on you · oldest ${coarse(Math.max(...waits))}`;
  const parts = [warnings[0]?.text, summary].filter((p): p is string => p !== undefined && p !== null);

  return {
    v: { ...LINE_JSON_VERSION },
    line: parts.length === 0 ? null : parts.join(" · "),
    blocked: (local?.blockedCount ?? 0) + doorbells.filter(ringing).length,
    announced: waits.length,
    warnings,
    rows: rowsFor(local, input.remote, doorbells, now, input.focusable),
  };
}

/**
 * Every session, worst first, through `overview()` — the one ordering every
 * surface shares, so this cannot drift from the menu bar and the web view.
 *
 * `overview()` sees only the roster, where a remote session is never blocked:
 * the doorbells that say otherwise are a separate list. So each remote row takes
 * its doorbells, a doorbell with no roster entry gets a row of its own (an
 * older remote daemon sends no roster), and the rows are re-sorted — stably —
 * on the same first key `overview()` uses. VIEW-09's rule that whatever waits on
 * a human comes first then holds across machines, and every other tie keeps
 * `overview()`'s order.
 */
function rowsFor(
  local: StatusBody | null,
  remote: RemoteState,
  doorbells: RemoteAgentView[],
  now: number,
  focusable: ((pid: number) => boolean) | undefined,
): LineRow[] {
  const roster = mergeRemoteSessions(remote?.sessions ?? [], local?.remote ?? []);
  const known = new Set(roster.map((s) => s.sessionId));
  const bells = new Map<string, RemoteAgentView[]>();
  for (const d of doorbells) bells.set(d.sessionId, [...(bells.get(d.sessionId) ?? []), d]);

  const orphans: RemoteSession[] = [];
  for (const [sessionId, list] of bells) {
    if (known.has(sessionId)) continue;
    const d = list[0] as RemoteAgentView;
    // `repo` is already a basename (the envelope never carries a path), which
    // is exactly what `overview()` derives a label from.
    orphans.push({
      host: d.host,
      sessionId,
      cwd: d.repo,
      name: null,
      status: null,
      source: "push",
      lastSeen: d.lastSeen,
      ...(list.every((x) => x.stale === true) ? { stale: true } : {}),
    });
  }

  const pids = new Map<string, number | null>();
  for (const s of local?.sessions ?? []) pids.set(s.sessionId, s.pid);
  for (const s of local?.silent ?? []) pids.set(s.sessionId, s.pid ?? null);

  const view = overview({
    ...(local ?? { blockedCount: 0, sessions: [] }),
    remote: [...roster, ...orphans],
  });

  return view
    .map((row) => {
      if (row.host === null) {
        const blocked = row.agents.filter((a) => a.state === "blocked");
        const pid = pids.get(row.sessionId) ?? null;
        return {
          urgency: row.blocked,
          row: {
            sessionId: row.sessionId,
            host: null,
            label: row.project,
            state: row.state,
            waitingMs: blocked.length === 0 ? null : Math.max(...blocked.map((a) => a.inStateMs)),
            acknowledged: blocked.length > 0 && blocked.every((a) => a.acknowledged),
            announced: blocked.some((a) => a.announcedAt != null),
            focusable: pid !== null && focusable?.(pid) === true,
          },
        };
      }
      const mine = bells.get(row.sessionId) ?? [];
      const live = mine.filter((d) => !d.acknowledged && d.stale !== true);
      return {
        urgency: live.length,
        row: {
          sessionId: row.sessionId,
          host: row.host,
          label: row.project,
          state: live.length > 0 ? "blocked" : row.state,
          waitingMs: mine.length === 0 ? null : Math.max(...mine.map((d) => Math.max(0, now - d.since))),
          acknowledged: mine.length > 0 && mine.every((d) => d.acknowledged),
          announced: mine.length > 0,
          // There is no window on this machine to raise.
          focusable: false,
        },
      };
    })
    .sort((a, b) => b.urgency - a.urgency)
    .map((x) => x.row);
}

/** What a probe that did not finish, or found nothing, decides: nothing can be raised from here. */
const NOWHERE = (): boolean => false;

/**
 * PSH-11 — could `focusSession` act on this pid? Decided here, not by a host.
 *
 * The same test `focusSession` applies, without doing it: the pid must be
 * running; on macOS that is enough, because the terminal's ancestry always ends
 * at an app bundle to raise; anywhere else the only route is a tmux pane above
 * it, so the pid must sit under one.
 *
 * Asked once per run, before any pid is known, so the answer is ready when the
 * rows are built. The pane list and the process table are each read ONCE —
 * the TUI mod runs this every five seconds, and `ancestry()` asks `ps` once per
 * hop — and `ancestry()` then walks the table: the same walk, with no spawns.
 *
 * Every command runs under `signal`, the line's own budget, and is killed when
 * it fires (#80). Whatever has not answered by then is unknown, and unknown is
 * not focusable: a wedged tmux costs `focusable`, never the line. So there is
 * no hop-by-hop fallback when the table cannot be read — that is one spawn per
 * hop per session, unbounded, for an answer that can be false instead.
 */
export async function focusProbe(deps: ProbeDeps, signal: AbortSignal): Promise<(pid: number) => boolean> {
  try {
    if (deps.platform === "darwin") return (pid) => deps.pidAlive(pid);
    if (signal.aborted) return NOWHERE;
    const panes = new Set<number>();
    for (const line of (
      (await deps.run("tmux", ["list-panes", "-a", "-F", "#{pane_pid}"], signal)) ?? ""
    ).split("\n")) {
      const pid = Number.parseInt(line.trim(), 10);
      if (Number.isFinite(pid)) panes.add(pid);
    }
    if (panes.size === 0 || signal.aborted) return NOWHERE;

    const parent = new Map<number, number>();
    for (const line of ((await deps.run("ps", ["-e", "-o", "pid=,ppid="], signal)) ?? "").split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (Number.isFinite(pid) && Number.isFinite(ppid)) parent.set(pid as number, ppid as number);
    }
    if (parent.size === 0) return NOWHERE;

    // `ancestry()`, answered from the table: exactly the query it makes, and
    // nothing else, because nothing else may spawn here.
    const walker: FocusDeps = {
      platform: deps.platform,
      pidAlive: deps.pidAlive,
      selfPid: 0,
      home: "",
      run: (file, args) => {
        if (file !== "ps" || args.length !== 4 || args[1] !== "ppid=") return null;
        const ppid = parent.get(Number(args[3]));
        return ppid === undefined ? null : `${ppid}\n`;
      },
    };
    return (pid) => deps.pidAlive(pid) && ancestry(pid, walker).some((p) => panes.has(p));
  } catch {
    return NOWHERE;
  }
}

export interface LineDeps {
  fetchHealth: (port: number, timeoutMs: number, signal: AbortSignal) => Promise<HealthBody | null>;
  fetchStatus: (port: number, timeoutMs: number, signal: AbortSignal) => Promise<StatusResult>;
  fetchRemote: (port: number, timeoutMs: number, signal: AbortSignal) => Promise<RemoteState>;
  now: () => number;
  selfHost: string;
  /** Decides `focusable` outright, in place of the probe — for a test that is not about it. */
  focusable: (pid: number) => boolean;
  /** PSH-11 — what `focusProbe` asks. Every command runs under the line's budget. */
  probe: ProbeDeps;
}

/**
 * Fetch, decide, serialise. Returns the text to print; "" means print nothing.
 *
 * The three fetches start at once under ONE budget and one timer. When it runs
 * out, every fetch is aborted through the signal each is handed — so no socket
 * is left holding the process open after the line is printed — and the timer
 * is cleared when they answer first, for the same reason: a tmux segment runs
 * this every few seconds, and astir-tui kills a run at 3s.
 *
 * Each fetch also has its own timeout, set LONGER than the budget so the
 * budget is always what fires first. The one this matters for is the
 * notifier: `fetchRemote` timing out on its own says null, and null is "no
 * notifier here" — calm. A hung notifier must instead be seen as hung, which
 * only the budget, racing it, can see.
 *
 * What the budget running out MEANS depends on who did not answer:
 *
 * - **The daemon** — nothing is known, so `astir unreachable`. Never "", which a
 *   tmux segment shows as calm, and never a stale value.
 * - **Only the notifier** — other machines' blocks are unknown, and nothing
 *   else is. This is the ordinary state of a box reached over `ssh -R` whose
 *   other end has gone to sleep: sshd still holds the forwarded port, accepts
 *   the connection, and never answers. Measured on the very machine #80 was
 *   filed for: 47000 answered in half a millisecond while 47001 hung for the
 *   full timeout. Printing `astir unreachable` there would hide this machine's
 *   own blocks, and hide #78's "nothing can notify you" — the true story, once
 *   the daemon's own probe drops the dead tunnel — behind a claim that astir
 *   itself cannot be reached. So the line is built from the daemon, remote
 *   counts are left out rather than guessed, and a warning says why.
 * - **Only the focus probe** (`--json`) — the rows say `focusable: false`, and
 *   nothing else changes. It starts with the fetches, under the same signal,
 *   so a notifier that spends the whole budget does not starve it, and the
 *   budget firing kills whatever it is still running.
 */
export async function runStatusLine(opts: LineOpts, deps: Partial<LineDeps> = {}): Promise<string> {
  const port = opts.port ?? Number(process.env.ASTIR_PORT ?? DEFAULT_PORT);
  const notifyPort = opts.notifyPort ?? Number(process.env.ASTIR_NOTIFY_PORT ?? port + 1);
  const budget = opts.timeoutMs ?? DEFAULT_LINE_BUDGET_MS;
  const selfHost = deps.selfHost ?? hostname();
  const getHealth = deps.fetchHealth ?? fetchHealth;
  const getStatus = deps.fetchStatus ?? ((p, t, s) => fetchStatus(p, t, selfHost, s));
  const getRemote = deps.fetchRemote ?? ((p, t, s) => fetchRemote(p, t, selfHost, s));

  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), budget);
  const expired = new Promise<null>((resolve) => {
    stop.signal.addEventListener("abort", () => resolve(null), { once: true });
  });
  const inner = budget * 2;

  let daemon: [HealthBody | null, StatusResult] | null = null;
  // `failed` rather than null: null is the notifier's own "nothing running".
  let remote: { value: RemoteState } | "failed" | null = null;
  let focusable = deps.focusable;
  try {
    // Every fetch is started before anything is awaited — one budget, not three.
    const health = getHealth(port, inner, stop.signal);
    const status = getStatus(port, inner, stop.signal);
    const notifier = getRemote(notifyPort, inner, stop.signal).then(
      (value) => ({ value }),
      () => "failed" as const,
    );
    // Rows are only in the JSON, so only the JSON pays for deciding focus.
    const focus =
      opts.json && focusable === undefined ? focusProbe(deps.probe ?? defaultProbeDeps(), stop.signal) : null;
    daemon = await Promise.race([Promise.all([health, status]), expired]);
    if (daemon !== null) remote = await Promise.race([notifier, expired]);
    // The probe first: one that already answered wins over a budget that has
    // just run out.
    if (daemon !== null && focus !== null) focusable = (await Promise.race([focus, expired])) ?? NOWHERE;
  } catch {
    // None of the real fetchers throw. If one does, nothing is known — which
    // is `unreachable`, not silence.
    daemon = null;
  } finally {
    clearTimeout(timer);
  }
  // Release whatever is still in flight; a no-op when everything answered.
  stop.abort();

  const now = (deps.now ?? Date.now)();
  let result: LineResult;
  try {
    result =
      daemon === null
        ? unreachable()
        : statusLine({
            session: opts.session,
            port,
            health: daemon[0],
            status: daemon[1],
            remote: remote !== null && remote !== "failed" ? remote.value : null,
            remoteTimedOut: remote === null || remote === "failed",
            ...(opts.notifierExpected === true ? { notifierExpected: true } : {}),
            now,
            selfHost,
            ...(opts.json ? { focusable: focusable ?? NOWHERE } : {}),
          });
  } catch {
    // What answered is read off sockets, one of them unauthenticated. A shape
    // the deciding cannot take must not take the command down: a run that
    // prints nothing is drawn as calm by a tmux segment. Nothing is known.
    result = unreachable();
  }

  return opts.json ? JSON.stringify(result) : (result.line ?? "");
}
