/**
 * PSH-03/PSH-08/PSH-10 — render the ambient menu-bar view.
 *
 * Emits SwiftBar/xbar plugin format: the lines before `---` are what shows in the
 * menu bar itself, everything after is the dropdown. `--` prefixes a nested item.
 *
 * This is a pure function on purpose. The menu bar is the surface most likely to
 * be replaced — SwiftBar is a single-maintainer dependency, and a tray app or a
 * shell prompt might take over — so the formatting logic is kept testable and
 * free of any I/O, and the host is a three-line wrapper.
 */

import { reasonText } from "../notify/envelope.js";
import { mergeRemoteSessions } from "../notify/roster.js";
import type { RemoteSession, StatusAgent, StatusBody, StatusResult, StatusSession } from "./types.js";

/** States that mean work is actively happening. */
const WORKING = new Set(["thinking", "tool-running"]);

/** A blocked agent on another machine, as the local notifier knows it. */
export interface RemoteEntry {
  host: string;
  repo: string;
  sessionId: string;
  reason: string;
  since: number;
  acknowledged: boolean;
  /** Contact with this machine has been lost; the agent is probably still blocked. */
  stale?: boolean;
  /** When we last heard anything about it — what "unreachable since" reports. */
  lastSeen?: number;
}

export interface MenubarOpts {
  /**
   * How to run clide, as `[interpreter, script]` — NOT the script alone.
   *
   * SwiftBar launches `bash=` from launchd, whose PATH is roughly
   * `/usr/bin:/bin:/usr/sbin:/sbin`. Handing it `main.js` makes the click depend
   * on the `#!/usr/bin/env node` shebang resolving `node` from *that* PATH, and
   * every version manager (mise, nvm, volta, asdf) puts node somewhere it has
   * never heard of. The exec then fails with 127 and SwiftBar reports nothing,
   * so the menu item looks inert. Passing the interpreter explicitly is the same
   * fix already applied to notification clicks in `notify/dispatch.ts`.
   */
  invocation: string[];
  /**
   * PSH-12 — agents blocked on other machines, from the local notifier. `null`
   * means no notifier is running, which is different from "no remote agents" and
   * must not be rendered as calm.
   */
  remote?: { agents: RemoteEntry[]; sessions?: RemoteSession[] } | null;
  /** For rendering elapsed time on remote entries. Injectable for tests. */
  now?: number;
}

function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The repo, which is how people actually identify a session.
 *
 * `name` is Claude Code's own session slug (e.g. "clide-56", "seenthat-bd").
 * It reads like a branch name but is not one, and its suffix is generated — so
 * as a *primary* label it is close to useless: two sessions in the same project
 * get unrelated-looking names, and a name tells you nothing about which repo it
 * belongs to. The directory basename is the thing you were thinking in.
 */
function repoName(cwd: string, fallback: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? fallback;
}

/**
 * Titles for a list of sessions, numbered only where the repo alone is
 * ambiguous. Numbering unconditionally would put "(1)" beside every solitary
 * session, which is noise; leaving collisions unnumbered would leave two
 * identical rows and no way to tell which is which.
 */
export function sessionLabels(sessions: Array<{ cwd: string; sessionId: string }>): string[] {
  const total = new Map<string, number>();
  for (const s of sessions) {
    const repo = repoName(s.cwd, s.sessionId.slice(0, 8));
    total.set(repo, (total.get(repo) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  return sessions.map((s) => {
    const repo = repoName(s.cwd, s.sessionId.slice(0, 8));
    if ((total.get(repo) ?? 0) < 2) return repo;
    const n = (seen.get(repo) ?? 0) + 1;
    seen.set(repo, n);
    return `${repo} (${n})`;
  });
}

/** SwiftBar treats `|` as the start of parameters, so it cannot appear in text. */
function safe(text: string): string {
  return text.replace(/\|/g, "¦").replace(/\n/g, " ");
}

/**
 * SwiftBar takes `color=<light>,<dark>` and picks by the current appearance. A
 * single value is used for *both*, which is how this menu became unreadable:
 * every colour here was chosen against a dark menu, so `#ffffff` titles and
 * `#cccccc` detail ended up as white-on-light-grey in light mode.
 *
 * Primary text now sets no colour at all. SwiftBar then uses the system label
 * colour, which is correct in both appearances and stays correct if the system
 * changes it — so only text that must *not* read as body text is coloured.
 *
 * The accents are Apple's accessible system-colour variants rather than the
 * standard ones: `#ff9500` on white is about 2:1 contrast, which is the same
 * legibility complaint one step quieter.
 */
const COLOUR = {
  /** Needs a human. */
  alert: "#c93400,#ffb340",
  /** Contact lost — worse than blocked, because we no longer know the state. */
  danger: "#d70015,#ff6961",
  /** Work is happening. */
  busy: "#248a3d,#30db5b",
  /** Agent state lines: secondary, but still meant to be read. */
  detail: "#3a3a3c,#c7c7cc",
  /** Paths, hints, dismissed items: present, deliberately quiet. */
  dim: "#6c6c70,#98989d",
} as const;

/**
 * A clickable menu item. `param1` is the script because `bash=` is the
 * interpreter — see `MenubarOpts.invocation`.
 */
function action(invocation: string[], args: string[]): string {
  const [command = "", ...rest] = invocation;
  const params = [...rest, ...args].map((value, i) => `param${i + 1}=${value}`);
  return `bash=${command} ${params.join(" ")} terminal=false refresh=true`;
}

/**
 * How long a finished agent stays listed.
 *
 * Dropping it the instant it completes loses the glance that says "that just
 * finished"; keeping it forever turns a live view into a log, and a session that
 * has run a few subagents accumulates a stack of `done` lines that push the one
 * live agent out of sight. A minute is long enough to notice and short enough
 * that an idle session settles down to just its name.
 *
 * `error` is deliberately exempt: an agent that failed is not clutter, it is the
 * thing you most need to still be there when you look up.
 */
const DONE_LINGER_MS = 60_000;

/**
 * How recently a token rejection must have happened to still be the diagnosis.
 * Hooks fire constantly in an active session, so an ongoing auth failure keeps
 * refreshing this; anything older describes a problem that has since been fixed.
 */
const RECENT_REJECTION_MS = 5 * 60_000;

/**
 * DMN-11 — a session nobody is sitting at.
 *
 * Unclassified counts as attended: `ps` is absent on Windows and a pid can exit
 * mid-poll, and quietly demoting a session someone is working in is the one
 * failure this must not have.
 */
function background(s: { attended?: boolean }): boolean {
  return s.attended === false;
}

/**
 * VIEW-12 — what a session is doing, on its own row.
 *
 * The state lived only in the submenu, so answering "is anything actually
 * working right now" meant opening each session in turn — which is exactly the
 * attention cost an ambient surface exists to remove.
 *
 * Icon AND word, not either. Colour alone fails for the ~8% of men with a
 * colour vision deficiency and disappears entirely in a screenshot or a
 * monochrome menu bar; a word alone is slower to scan than a shape. Together
 * each is a fallback for the other (VIEW-07).
 */
const BADGE: Record<string, { sfimage: string; colour: string; label: string }> = {
  blocked: { sfimage: "bell.badge.fill", colour: COLOUR.alert, label: "waiting on you" },
  error: { sfimage: "exclamationmark.triangle.fill", colour: COLOUR.danger, label: "error" },
  // A cog reads as settings, not as work in progress.
  "tool-running": { sfimage: "hammer.fill", colour: COLOUR.busy, label: "running" },
  thinking: { sfimage: "circle.fill", colour: COLOUR.busy, label: "thinking" },
  waiting: { sfimage: "pause.circle.fill", colour: COLOUR.dim, label: "waiting" },
  done: { sfimage: "checkmark.circle", colour: COLOUR.dim, label: "done" },
  idle: { sfimage: "circle", colour: COLOUR.dim, label: "idle" },
};

/**
 * The one state worth putting on the row.
 *
 * Ranked by what it asks of the reader, not by recency: an agent waiting on you
 * outranks five that are busy, because the busy ones need nothing. A session
 * whose subagents have finished while the main one still works should read as
 * working, so terminal states rank last.
 */
const STATE_RANK = ["blocked", "error", "tool-running", "thinking", "waiting", "done", "idle"];

export function dominantState(session: StatusSession): string | null {
  let best: string | null = null;
  let bestRank = STATE_RANK.length;
  // The same agents the submenu shows, so the row cannot claim "done" about an
  // agent that has already aged out of the list beneath it.
  for (const a of visibleAgents(session)) {
    // A dismissed agent is still blocked, but the human has already seen it and
    // chose to defer — surfacing it as an alert again would be nagging.
    const state = a.state === "blocked" && a.acknowledged ? "waiting" : a.state;
    const rank = STATE_RANK.indexOf(state);
    if (rank !== -1 && rank < bestRank) {
      bestRank = rank;
      best = state;
    }
  }
  return best;
}

function visibleAgents(session: StatusSession): StatusAgent[] {
  return session.agents.filter((a) => a.state !== "done" || a.inStateMs < DONE_LINGER_MS);
}

function countWorking(body: StatusBody): number {
  let n = 0;
  for (const s of body.sessions) for (const a of s.agents) if (WORKING.has(a.state)) n++;
  return n;
}

/**
 * How long the agent has been in its current state. `inStateMs` is live; the
 * banked totals are not, and rendering `blockedMs` for an agent that is still
 * blocked is how "waiting 0s" ends up frozen on screen forever.
 */
function timeText(agent: StatusAgent): string {
  if (agent.state === "blocked") return `waiting ${humanDuration(agent.inStateMs)}`;
  if (!WORKING.has(agent.state)) return humanDuration(agent.inStateMs);

  // Two different questions, and the old single number answered neither: it
  // showed `activeMs + inStateMs`, the whole SESSION's working total, which only
  // grows and tells you nothing about the request you just made.
  //
  //   how long in THIS state — what the agent is doing right now
  //   how long since you handed over — how long this turn has taken
  //
  // The turn total is wall clock ONLY when the agent never stopped to ask you
  // something: a permission prompt mid-turn is excluded from it, because time
  // spent waiting on a human is not time spent working (G4).
  const here = humanDuration(agent.inStateMs);
  const turn = (agent.turnMs ?? 0) + agent.inStateMs;
  // Below a second apart the two are the same number twice, which is noise.
  return turn - agent.inStateMs >= 1_000 ? `${here}  ·  ${humanDuration(turn)} this turn` : here;
}

export function renderMenubar(result: StatusResult, opts: MenubarOpts): string {
  const lines: string[] = [];
  /** SwiftBar renders consecutive separators as a visible double rule. */
  const separator = (): void => {
    if (lines.at(-1) !== "---") lines.push("---");
  };
  const exe = opts.invocation;
  const now = opts.now ?? Date.now();
  const remote = opts.remote?.agents ?? [];
  // An unreachable entry is not a live alert — we no longer know its state — but
  // it is not nothing either, so it stays listed and gets its own warning.
  const remoteBlocked = remote.filter((r) => !r.acknowledged && r.stale !== true).length;
  const remoteUnreachable = remote.filter((r) => r.stale === true).length;

  if (!result.ok) {
    // Deliberately distinct from "idle": the daemon being unreachable is
    // information, and rendering it as calm would be a lie.
    lines.push(`clide ⚠ | sfimage=exclamationmark.triangle color=${COLOUR.dim}`);
    lines.push("---");
    lines.push(`${safe(result.reason)} | color=${COLOUR.dim}`);
    // terminal=true here on purpose: starting the daemon should show its output.
    const [command = "", ...rest] = exe;
    const params = [...rest, "daemon"].map((value, i) => `param${i + 1}=${value}`);
    lines.push(`Start the daemon | bash=${command} ${params.join(" ")} terminal=true`);
    lines.push("Refresh | refresh=true");
    return `${lines.join("\n")}\n`;
  }

  const { body } = result;
  // A blocked agent is a blocked agent regardless of which machine it is on —
  // the badge would be lying if it only counted the ones you can already see.
  const blocked = body.blockedCount + remoteBlocked;
  const working = countWorking(body);

  // The menu bar line. Blocked always wins — it is the only state that needs a
  // human, and the whole surface exists for it.
  if (blocked > 0) {
    lines.push(`${blocked} | sfimage=bell.badge.fill color=${COLOUR.alert} font=Menlo`);
  } else if (working > 0) {
    lines.push(`${working} | sfimage=circle.fill color=${COLOUR.busy} font=Menlo`);
  } else if (remoteUnreachable > 0) {
    lines.push(`| sfimage=exclamationmark.triangle color=${COLOUR.danger}`);
  } else if (body.sessions.length > 0 || remote.length > 0) {
    lines.push(`| sfimage=circle color=${COLOUR.dim}`);
  } else {
    lines.push(`| sfimage=circle.dotted color=${COLOUR.dim}`);
  }

  lines.push("---");

  if (blocked > 0) {
    lines.push(
      `${blocked} agent${blocked === 1 ? "" : "s"} waiting on you | color=${COLOUR.alert} sfimage=bell.badge.fill`,
    );
    lines.push(`Dismiss all | ${action(exe, ["dismiss"])}`);
    lines.push("---");
  }

  const silent = body.silent ?? [];

  if (body.sessions.length === 0 && remote.length === 0 && silent.length === 0) {
    lines.push(`No live sessions | color=${COLOUR.dim}`);
  }

  const mine = body.sessions.filter((s) => !background(s));
  const titles = sessionLabels(mine);
  for (const [i, session] of mine.entries()) {
    const blockedHere = session.agents.filter((a) => a.state === "blocked" && !a.acknowledged).length;
    const marker = blockedHere > 0 ? " ⏳" : "";

    // Clicking the session goes to where the work is. `terminal=false` because
    // `clide focus` drives the window manager itself and must not open a shell.
    // No colour unless it is blocked: the session title is the primary text of
    // this menu and belongs in the system label colour.
    const state = dominantState(session);
    const badge = (state === null ? undefined : BADGE[state]) ?? null;
    const title = blockedHere > 0 ? ` color=${COLOUR.alert}` : "";
    const shown = badge === null ? "" : `  ·  ${badge.label}`;
    const icon = badge === null ? "" : ` sfimage=${badge.sfimage} sfcolor=${badge.colour}`;
    lines.push(
      `${safe(titles[i] ?? "")}${shown}${marker} |${title}${icon} ${action(exe, ["focus", session.sessionId])}`,
    );
    // Every line in a session's block goes to the same place. Clicking the path
    // or a state line and getting nothing reads as broken, not as "that one is
    // not a button" — there is no visual difference between them.
    const goThere = action(exe, ["focus", session.sessionId]);
    // The full path disambiguates two repos sharing a basename, and the session
    // slug is what `clide focus`/`dismiss` and the logs call it — both are worth
    // having, neither is worth the top line.
    const slug = session.name == null ? "" : `  ·  ${safe(session.name)}`;
    lines.push(`-- ${safe(session.cwd)}${slug} | color=${COLOUR.dim} ${goThere}`);

    for (const agent of visibleAgents(session)) {
      const who = agent.agentType ?? "main";
      const dismissed = agent.state === "blocked" && agent.acknowledged;
      // Dismissed agents stay listed but stop shouting: still blocked, already seen.
      const colour = dismissed ? COLOUR.dim : agent.state === "blocked" ? COLOUR.alert : COLOUR.detail;
      const suffix = dismissed ? "  (dismissed)" : "";
      lines.push(
        `-- ${agent.state.padEnd(12)} ${safe(who)}  ·  ${timeText(agent)}${suffix}` +
          ` | color=${colour} font=Menlo ${goThere}`,
      );
    }

    if (blockedHere > 0) {
      lines.push(`-- Dismiss this session | ${action(exe, ["dismiss", session.sessionId])}`);
    }
    lines.push(`-- Forget this session | ${action(exe, ["forget", session.sessionId])} color=${COLOUR.dim}`);
  }

  // Only a RECENT rejection is a diagnosis. `unauthorizedIngest` is a lifetime
  // total, so testing it for non-zero pinned "the token is rejected" on screen
  // permanently after one historical failure — sending the reader to fix
  // something already correct while the actual cause went unnamed.
  const rejecting = body.lastUnauthorizedAt != null && now - body.lastUnauthorizedAt < RECENT_REJECTION_MS;

  // DMN-07 — say which kind of quiet this is. These sit BELOW the sessions we
  // can hear, dimmed, rather than above them behind a summary banner: they are
  // still sessions, they are just ones we have nothing to report about, and
  // putting a warning block above the live view made the thing you actually
  // wanted to see the second thing on screen.
  const quietMine = silent.filter((s) => !background(s));
  const quietTitles = sessionLabels(quietMine);
  for (const [i, s] of quietMine.entries()) {
    const slug = s.name == null ? "" : `  ·  ${safe(s.name)}`;
    // Clickable for the same reason the live ones are — arguably more so. We
    // cannot say what this session is doing, so "take me to it" is the only
    // useful thing left, and a row that looks like the others but does nothing
    // reads as broken rather than as deliberately inert.
    const goThere = action(exe, ["focus", s.sessionId]);
    lines.push(`${safe(quietTitles[i] ?? "")}  ·  not connected | color=${COLOUR.dim} ${goThere}`);
    lines.push(`-- ${safe(s.cwd)}${slug} | color=${COLOUR.dim} font=Menlo ${goThere}`);

    // A session older than the daemon cannot have had its `SessionStart`
    // received — the daemon keeps state in memory and a restart forgets
    // everything. Its silence is therefore evidence of nothing, and saying
    // "hooks are not wired, restart it" would send someone to restart a session
    // that is working perfectly and will reappear the moment it does anything.
    const predatesDaemon =
      body.daemonStartedAt !== undefined && s.startedAt != null && s.startedAt < body.daemonStartedAt;

    if (predatesDaemon && s.sandboxBlocked !== true) {
      lines.push(`-- Started before clide was listening, so nothing has been | color=${COLOUR.dim}`);
      lines.push(`-- heard from it yet — it will appear as soon as it does | color=${COLOUR.dim}`);
      lines.push(`-- anything | color=${COLOUR.dim}`);
    } else if (s.sandboxBlocked === true) {
      // The one silent case clide can prove rather than guess.
      lines.push(`-- This project is sandboxed, so its hooks cannot reach the | color=${COLOUR.dim}`);
      lines.push(`-- daemon — the proxy refuses them before they arrive | color=${COLOUR.dim}`);
      lines.push(`-- Allow clide through this project's sandbox | ${action(exe, ["allow-sandbox", s.cwd])}`);
    } else if (rejecting) {
      lines.push(`-- Hooks are firing but the token is rejected | color=${COLOUR.dim}`);
      lines.push(`-- Run \`clide install\` to repair the token | color=${COLOUR.dim}`);
    } else {
      lines.push(`-- Hooks bind when a session starts, so one older than | color=${COLOUR.dim}`);
      lines.push(`-- the clide plugin never sends anything — restart it | color=${COLOUR.dim}`);
    }
  }

  // DMN-09/DMN-10 — everything running elsewhere, from whichever route knows
  // about it. A machine that both pushes a roster and answers an SSH poll
  // reports each session twice, so they are merged before anything is drawn.
  const elsewhere = mergeRemoteSessions(opts.remote?.sessions ?? [], body.remote ?? []);
  // A session with a blocked agent is already rendered below with its reason and
  // its dismiss action; listing it again as an ordinary session would be the
  // duplicate-row problem in a new place.
  const blockedIds = new Set(remote.map((r) => r.sessionId));
  const quietElsewhere = elsewhere.filter((s) => !blockedIds.has(s.sessionId) && !background(s));

  if (remote.length > 0 || quietElsewhere.length > 0) {
    separator();
    lines.push(`Other machines | color=${COLOUR.dim}`);
    for (const entry of remote) {
      if (entry.stale === true) {
        // Losing the tunnel does not mean the agent stopped waiting — it means we
        // stopped being told. Saying so is the whole point; quietly dropping the
        // row would look identical to "everything is fine".
        const lastHeard =
          entry.lastSeen === undefined
            ? ""
            : `  ·  last heard ${humanDuration(Math.max(0, now - entry.lastSeen))} ago`;
        lines.push(`${safe(entry.host)}  ⚠ unreachable | color=${COLOUR.danger}`);
        lines.push(`-- ${safe(entry.repo)}${lastHeard} | color=${COLOUR.dim} font=Menlo`);
        lines.push(`-- Reconnect:  ssh -R 47001:127.0.0.1:47001 ${safe(entry.host)} | color=${COLOUR.dim}`);
        lines.push(`-- Forget | ${action(exe, ["forget", entry.sessionId])} color=${COLOUR.dim}`);
        continue;
      }

      const marker = entry.acknowledged ? "" : " ⏳";
      const colour = entry.acknowledged ? COLOUR.dim : COLOUR.alert;
      lines.push(`${safe(entry.host)} · ${safe(entry.repo)}${marker} | color=${colour}`);
      const suffix = entry.acknowledged ? "  (dismissed)" : "";
      lines.push(
        `-- ${safe(reasonText(entry.reason))}  ·  waiting ${humanDuration(Math.max(0, now - entry.since))}${suffix}` +
          ` | color=${COLOUR.detail} font=Menlo`,
      );
      // No focus action: there is no window on this machine to raise.
      lines.push(`-- Dismiss | ${action(exe, ["dismiss", entry.sessionId])}`);
    }

    const quietTitlesRemote = sessionLabels(quietElsewhere);
    for (const [i, s] of quietElsewhere.entries()) {
      // Nothing is waiting on you here, so this is information, not an alert —
      // and there is no window on this machine to raise, so no click either.
      const label = `${safe(quietTitlesRemote[i] ?? "")}  ·  ${safe(s.host)}`;
      if (s.stale === true) {
        lines.push(`${label}  ⚠ unreachable | color=${COLOUR.danger}`);
        lines.push(`-- ${safe(s.cwd)} | color=${COLOUR.dim} font=Menlo`);
        lines.push(`-- Contact lost — it is probably still running | color=${COLOUR.dim}`);
        continue;
      }
      lines.push(`${label} | color=${COLOUR.dim}`);
      const via = s.source === "push" ? "reported by its daemon" : "seen over ssh";
      const slug = s.name == null ? "" : `  ·  ${safe(s.name)}`;
      lines.push(`-- ${safe(s.cwd)}${slug} | color=${COLOUR.dim} font=Menlo`);
      lines.push(`-- ${safe(s.status ?? "running")}  ·  ${via} | color=${COLOUR.detail} font=Menlo`);
    }
  }

  // DMN-11 — sessions a program launched, kept out of the way of the ones you
  // are working in. Listed rather than hidden: they are real work and a machine
  // quietly running six of them is worth knowing about — just not at the top of
  // a view whose question is "which of these needs me".
  const chores = [
    ...body.sessions.filter(background).map((x) => ({ ...x, where: null as string | null })),
    ...silent.filter(background).map((x) => ({ ...x, where: null as string | null })),
    ...elsewhere.filter(background).map((x) => ({ ...x, where: x.host })),
  ];
  if (chores.length > 0) {
    separator();
    const n = chores.length;
    lines.push(`${n} background session${n === 1 ? "" : "s"} | color=${COLOUR.dim}`);
    lines.push(`-- Launched by a plugin or script — nothing here waits on you | color=${COLOUR.dim}`);
    for (const c of chores) {
      const where = c.where === null ? "" : `  ·  ${safe(c.where)}`;
      lines.push(
        `-- ${safe(repoName(c.cwd, c.sessionId.slice(0, 8)))}${where} | color=${COLOUR.dim} font=Menlo`,
      );
    }
  }

  separator();
  lines.push("Refresh | refresh=true");
  return `${lines.join("\n")}\n`;
}
