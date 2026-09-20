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

import { hooksLookUnwired } from "../config/plugin.js";
import { reasonText } from "../notify/envelope.js";
import { mergeRemoteSessions } from "../notify/roster.js";
import { agentDetail, ellipsise, humanDuration, visibleAgents as visible } from "./agents.js";
import { isSeparator, type Menu, MenuBuilder, type MenuItem, toSwiftBar } from "./menu.js";
import { background, dominantState, repoName, sessionLabels } from "./overview.js";
import type { RemoteSession, StatusAgent, StatusBody, StatusResult } from "./types.js";

/**
 * Split the collected nodes into a status item and a dropdown.
 *
 * astir always emits exactly one bar line and then a rule, so the first node is
 * the badge by construction. Asserting that here rather than trusting position
 * at every call site keeps the invariant in one place.
 */
function finish(menu: MenuBuilder): Menu {
  const [first, ...rest] = menu.build();
  const badge: MenuItem = first === undefined || isSeparator(first) ? { text: "", depth: 0 } : first;
  // Drop the rule that followed the badge: `toSwiftBar` writes that separator
  // itself, as part of the format rather than as content.
  const items = rest.length > 0 && rest[0] !== undefined && isSeparator(rest[0]) ? rest.slice(1) : rest;
  return { badge, items };
}

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
   * How to run astir, as `[interpreter, script]` — NOT the script alone.
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

/**
 * Titles for a list of sessions, numbered only where the repo alone is
 * ambiguous. Numbering unconditionally would put "(1)" beside every solitary
 * session, which is noise; leaving collisions unnumbered would leave two
 * identical rows and no way to tell which is which.
 */
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
/**
 * VIEW-12 for a machine that is not this one.
 *
 * A remote session carries the provider's word for the whole SESSION, not an
 * agent state, so it does not key into `BADGE` — `busy` is not an agent state
 * and `tool-running` is never a session status.
 *
 * The point is that a row which is working must not look like a row that is
 * idle. Both were dim, so "everything over there is quiet" and "everything over
 * there is busy" rendered identically, and the only honest reading left was
 * that nothing was getting through.
 *
 * Icon AND word, like `BADGE` and for the same reasons: colour alone fails for
 * the ~8% of men with a colour vision deficiency and disappears in a screenshot
 * or a monochrome menu bar (VIEW-07).
 *
 * An unrecognised status deliberately gets NO badge rather than a default one.
 * Guessing here would eventually assert calm about a machine whose state this
 * one does not understand, which is the single error this surface must not make.
 */
const REMOTE_BADGE: Record<string, { sfimage: string; colour: string; label: string }> = {
  busy: { sfimage: "hammer.fill", colour: COLOUR.busy, label: "working" },
  thinking: { sfimage: "circle.fill", colour: COLOUR.busy, label: "thinking" },
  "tool-running": { sfimage: "hammer.fill", colour: COLOUR.busy, label: "running" },
  waiting: { sfimage: "pause.circle.fill", colour: COLOUR.dim, label: "waiting" },
  idle: { sfimage: "circle", colour: COLOUR.dim, label: "idle" },
  done: { sfimage: "checkmark.circle", colour: COLOUR.dim, label: "done" },
};

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
/**
 * How much of an agent's task fits in the dropdown.
 *
 * A menu grows to its widest row, so an unbounded description would drag the
 * whole menu across the screen and push every elapsed time out of alignment.
 */
const DETAIL_CHARS = 40;

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

/**
 * DMN-09/DMN-10 — everything running elsewhere.
 *
 * Extracted so it can be rendered when the LOCAL daemon is unreachable too.
 * It used to live inline after an early return that fired in exactly that case,
 * which meant the one situation pairing exists for — work moved to another
 * machine, local daemon stopped — was the situation where the menu bar threw
 * away the remote sessions it already had and showed only a warning triangle.
 */
function remoteSection(
  menu: MenuBuilder,
  remote: RemoteEntry[],
  elsewhere: RemoteSession[],
  now: number,
  exe: string[],
  separator: () => void,
): void {
  // DMN-09/DMN-10 — everything running elsewhere, from whichever route knows
  // about it. A machine that both pushes a roster and answers an SSH poll
  // reports each session twice, so they are merged before anything is drawn.
  // A session with a blocked agent is already rendered below with its reason and
  // its dismiss action; listing it again as an ordinary session would be the
  // duplicate-row problem in a new place.
  const blockedIds = new Set(remote.map((r) => r.sessionId));
  const quietElsewhere = elsewhere.filter((s) => !blockedIds.has(s.sessionId) && !background(s));

  if (remote.length > 0 || quietElsewhere.length > 0) {
    separator();
    menu.push({ text: `Other machines`, depth: 0, colour: COLOUR.dim });
    for (const entry of remote) {
      if (entry.stale === true) {
        // Losing the tunnel does not mean the agent stopped waiting — it means we
        // stopped being told. Saying so is the whole point; quietly dropping the
        // row would look identical to "everything is fine".
        const lastHeard =
          entry.lastSeen === undefined
            ? ""
            : `  ·  last heard ${humanDuration(Math.max(0, now - entry.lastSeen))} ago`;
        menu.push({ text: `${safe(entry.host)}  ⚠ unreachable`, depth: 0, colour: COLOUR.danger });
        menu.push({ text: `${safe(entry.repo)}${lastHeard}`, depth: 1, colour: COLOUR.dim, monospace: true });
        menu.push({
          text: `Reconnect:  ssh -R 47001:127.0.0.1:47001 ${safe(entry.host)}`,
          depth: 1,
          colour: COLOUR.dim,
        });
        menu.push({
          text: `Forget`,
          depth: 1,
          colour: COLOUR.dim,
          action: { argv: [...exe, ...["forget", entry.sessionId]] },
        });
        continue;
      }

      const marker = entry.acknowledged ? "" : " ⏳";
      const colour = entry.acknowledged ? COLOUR.dim : COLOUR.alert;
      menu.push({ text: `${safe(entry.host)} · ${safe(entry.repo)}${marker}`, depth: 0, colour: colour });
      const suffix = entry.acknowledged ? "  (dismissed)" : "";
      menu.push({
        text: `${safe(reasonText(entry.reason))}  ·  waiting ${humanDuration(Math.max(0, now - entry.since))}${suffix}`,
        depth: 1,
        colour: COLOUR.detail,
        monospace: true,
      });
      // No focus action: there is no window on this machine to raise.
      menu.push({ text: `Dismiss`, depth: 1, action: { argv: [...exe, ...["dismiss", entry.sessionId]] } });
    }

    const quietTitlesRemote = sessionLabels(quietElsewhere);
    for (const [i, s] of quietElsewhere.entries()) {
      // Nothing is waiting on you here, so this is information, not an alert —
      // and there is no window on this machine to raise, so no click either.
      const label = `${safe(quietTitlesRemote[i] ?? "")}  ·  ${safe(s.host)}`;
      if (s.stale === true) {
        menu.push({ text: `${label}  ⚠ unreachable`, depth: 0, colour: COLOUR.danger });
        menu.push({ text: `${safe(s.cwd)}`, depth: 1, colour: COLOUR.dim, monospace: true });
        menu.push({ text: `Contact lost — it is probably still running`, depth: 1, colour: COLOUR.dim });
        continue;
      }
      // The row text stays dim: nothing here is waiting on you, and there is no
      // window on this machine to raise. What changes is that the STATE is now
      // on the row rather than only in the line beneath it, so "working" and
      // "idle" are distinguishable at a glance instead of both reading as grey.
      const badge = s.status === null ? undefined : REMOTE_BADGE[s.status];
      const shown = badge === undefined ? "" : `  ·  ${badge.label}`;
      menu.push({
        text: `${label}${shown}`,
        depth: 0,
        colour: COLOUR.dim,
        ...(badge === undefined ? {} : { symbol: badge.sfimage, symbolColour: badge.colour }),
      });
      const via = s.source === "push" ? "reported by its daemon" : "seen over ssh";
      const slug = s.name == null ? "" : `  ·  ${safe(s.name)}`;
      menu.push({ text: `${safe(s.cwd)}${slug}`, depth: 1, colour: COLOUR.dim, monospace: true });
      // The status is repeated here ONLY when the row could not show it — an
      // unrecognised word still belongs on screen, just not as a badge.
      const detail = badge === undefined ? `${safe(s.status ?? "running")}  ·  ${via}` : via;
      menu.push({ text: `${detail}`, depth: 1, colour: COLOUR.detail, monospace: true });
    }
  }
}

/**
 * What the menu says. `renderMenubar` is this plus a serialiser.
 *
 * The first item emitted is the status item itself — astir always says exactly
 * one thing in the bar and then opens a dropdown — so it is lifted out here
 * rather than left for a host to guess at by position.
 */
export function buildMenu(result: StatusResult, opts: MenubarOpts): Menu {
  const menu = new MenuBuilder();
  const separator = (): void => menu.separator();
  const exe = opts.invocation;
  const now = opts.now ?? Date.now();
  const remote = opts.remote?.agents ?? [];
  // An unreachable entry is not a live alert — we no longer know its state — but
  // it is not nothing either, so it stays listed and gets its own warning.
  const remoteBlocked = remote.filter((r) => !r.acknowledged && r.stale !== true).length;
  const remoteUnreachable = remote.filter((r) => r.stale === true).length;

  if (!result.ok) {
    // The local daemon is unreachable — but that does NOT mean we know nothing.
    // A paired machine pushes its roster to the notifier, which is a separate
    // process on a separate port, so its data survives the daemon dying.
    //
    // Throwing it away here was the old behaviour, and it broke the one case
    // pairing exists for: move development to another machine, stop the daemon
    // on this one, and the menu bar went blind — a warning triangle sitting on
    // top of a notifier that knew about four live sessions.
    const strandedRemote = opts.remote?.agents ?? [];
    const strandedSessions = opts.remote?.sessions ?? [];
    const startDaemon = {
      text: "Start the daemon",
      depth: 0,
      action: { argv: [...exe, "daemon"], terminal: true },
    };

    if (strandedRemote.length === 0 && strandedSessions.length === 0) {
      // Nothing anywhere. Deliberately distinct from "idle": the daemon being
      // unreachable is information, and rendering it as calm would be a lie.
      menu.push({ text: `astir ⚠`, depth: 0, colour: COLOUR.dim, symbol: "exclamationmark.triangle" });
      menu.rule();
      menu.push({ text: `${safe(result.reason)}`, depth: 0, colour: COLOUR.dim });
      // terminal=true on purpose: starting the daemon should show its output.
      menu.push(startDaemon);
      menu.push({ text: "Refresh", depth: 0, refresh: true });
      return finish(menu);
    }

    // Degraded, and it says so. The badge still counts what is waiting on you,
    // because a blocked agent on another machine is blocked whether or not
    // anything is running here.
    const strandedBlocked = strandedRemote.filter((r) => !r.acknowledged && r.stale !== true).length;
    if (strandedBlocked > 0) {
      menu.push({
        text: `${strandedBlocked}`,
        depth: 0,
        colour: COLOUR.alert,
        symbol: "bell.badge.fill",
        monospace: true,
      });
    } else {
      menu.push({ text: "", depth: 0, colour: COLOUR.dim, symbol: "externaldrive.badge.questionmark" });
    }
    menu.rule();
    menu.push({ text: `No local daemon — showing other machines only`, depth: 0, colour: COLOUR.dim });
    menu.push({ text: `${safe(result.reason)}`, depth: 1, colour: COLOUR.dim });
    menu.push(startDaemon);
    remoteSection(menu, strandedRemote, strandedSessions, now, exe, separator);
    separator();
    menu.push({ text: "Refresh", depth: 0, refresh: true });
    return finish(menu);
  }

  const { body } = result;
  // A blocked agent is a blocked agent regardless of which machine it is on —
  // the badge would be lying if it only counted the ones you can already see.
  const blocked = body.blockedCount + remoteBlocked;
  const working = countWorking(body);

  // The menu bar line. Blocked always wins — it is the only state that needs a
  // human, and the whole surface exists for it.
  if (blocked > 0) {
    menu.push({
      text: `${blocked}`,
      depth: 0,
      colour: COLOUR.alert,
      symbol: "bell.badge.fill",
      monospace: true,
    });
  } else if (working > 0) {
    menu.push({ text: `${working}`, depth: 0, colour: COLOUR.busy, symbol: "circle.fill", monospace: true });
  } else if (remoteUnreachable > 0) {
    menu.push({ text: "", depth: 0, colour: COLOUR.danger, symbol: "exclamationmark.triangle" });
  } else if (body.sessions.length > 0 || remote.length > 0) {
    menu.push({ text: "", depth: 0, colour: COLOUR.dim, symbol: "circle" });
  } else {
    menu.push({ text: "", depth: 0, colour: COLOUR.dim, symbol: "circle.dotted" });
  }

  menu.rule();

  if (blocked > 0) {
    menu.push({
      text: `${blocked} agent${blocked === 1 ? "" : "s"} waiting on you`,
      depth: 0,
      colour: COLOUR.alert,
      symbol: "bell.badge.fill",
    });
    menu.push({ text: `Dismiss all`, depth: 0, action: { argv: [...exe, ...["dismiss"]] } });
    menu.rule();
  }

  const silent = body.silent ?? [];

  if (body.sessions.length === 0 && remote.length === 0 && silent.length === 0) {
    menu.push({ text: `No live sessions`, depth: 0, colour: COLOUR.dim });
  }

  const mine = body.sessions.filter((s) => !background(s));
  const titles = sessionLabels(mine);
  for (const [i, session] of mine.entries()) {
    const blockedHere = session.agents.filter((a) => a.state === "blocked" && !a.acknowledged).length;
    const marker = blockedHere > 0 ? " ⏳" : "";

    // Clicking the session goes to where the work is. `terminal=false` because
    // `astir focus` drives the window manager itself and must not open a shell.
    // No colour unless it is blocked: the session title is the primary text of
    // this menu and belongs in the system label colour.
    const state = dominantState(session);
    const badge = (state === null ? undefined : BADGE[state]) ?? null;
    const shown = badge === null ? "" : `  ·  ${badge.label}`;
    menu.push({
      text: `${safe(titles[i] ?? "")}${shown}${marker}`,
      depth: 0,
      ...(blockedHere > 0 ? { colour: COLOUR.alert } : {}),
      ...(badge === null ? {} : { symbol: badge.sfimage, symbolColour: badge.colour }),
      action: { argv: [...exe, "focus", session.sessionId] },
    });
    // Every line in a session's block goes to the same place. Clicking the path
    // or a state line and getting nothing reads as broken, not as "that one is
    // not a button" — there is no visual difference between them.
    const goThere = { argv: [...exe, "focus", session.sessionId] };
    if (session.restored === true) {
      // DMN-06 — agent state off the crash-recovery snapshot, unconfirmed
      // since. The rows below this one say things like "blocked 14m", which
      // read as observations; here they are a memory. Discovery confirmed the
      // SESSION is alive, not that its state is current — an agent blocked when
      // the daemon died may have unblocked while it was down, and astir cannot
      // know until the session next acts.
      menu.push({
        text: `Recovered after a daemon restart — the times below`,
        depth: 1,
        colour: COLOUR.dim,
        action: goThere,
      });
      menu.push({
        text: `predate it and correct themselves on its next action`,
        depth: 1,
        colour: COLOUR.dim,
        action: goThere,
      });
    }
    // The full path disambiguates two repos sharing a basename, and the session
    // slug is what `astir focus`/`dismiss` and the logs call it — both are worth
    // having, neither is worth the top line.
    const slug = session.name == null ? "" : `  ·  ${safe(session.name)}`;
    menu.push({ text: `${safe(session.cwd)}${slug}`, depth: 1, colour: COLOUR.dim, action: goThere });

    for (const agent of visible(session.agents)) {
      const who = agent.agentType ?? "main";
      const dismissed = agent.state === "blocked" && agent.acknowledged;
      // Dismissed agents stay listed but stop shouting: still blocked, already seen.
      const colour = dismissed ? COLOUR.dim : agent.state === "blocked" ? COLOUR.alert : COLOUR.detail;
      const suffix = dismissed ? "  (dismissed)" : "";
      // What it is doing, when there is anything to say. Bounded because a menu
      // is a fixed-width surface and a long task description would push the
      // elapsed time off the right edge — losing the number this row exists for.
      const detail = agentDetail(agent);
      const doing = detail === null ? "" : `  ·  ${safe(ellipsise(detail, DETAIL_CHARS))}`;
      menu.push({
        text: `${agent.state.padEnd(12)} ${safe(who)}${doing}  ·  ${timeText(agent)}${suffix}`,
        depth: 1,
        colour,
        monospace: true,
        action: goThere,
      });
    }

    // VIEW-03 — straight to THIS session's map, not the overview. `astir view`
    // takes a session id, so the menu can deep-link rather than making someone
    // arrive at a list and find the row they just clicked.
    menu.push({ text: `Open the map`, depth: 1, action: { argv: [...exe, ...["view", session.sessionId]] } });

    if (blockedHere > 0) {
      menu.push({
        text: `Dismiss this session`,
        depth: 1,
        action: { argv: [...exe, ...["dismiss", session.sessionId]] },
      });
    }
    menu.push({
      text: `Forget this session`,
      depth: 1,
      colour: COLOUR.dim,
      action: { argv: [...exe, ...["forget", session.sessionId]] },
    });
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
    const goThere = { argv: [...exe, "focus", s.sessionId] };
    // What the PROVIDER says it is doing, which is a different question from
    // whether astir has heard from it — and one we have an answer to. Saying
    // only "not connected" reported astir's reach as though it were the
    // session's state, so a working session and a finished one looked the same.
    // The same badge the remote rows use, for the same reason and by the same
    // rule: an unrecognised status gets none rather than a guessed one.
    const badge = s.status == null ? undefined : REMOTE_BADGE[s.status];
    const doing = badge === undefined ? "" : `  ·  ${badge.label}`;
    menu.push({
      text: `${safe(quietTitles[i] ?? "")}${doing}  ·  not connected`,
      depth: 0,
      colour: COLOUR.dim,
      ...(badge === undefined ? {} : { symbol: badge.sfimage, symbolColour: badge.colour }),
      action: goThere,
    });
    menu.push({
      text: `${safe(s.cwd)}${slug}`,
      depth: 1,
      colour: COLOUR.dim,
      monospace: true,
      action: goThere,
    });

    // A session older than the daemon cannot have had its `SessionStart`
    // received — the daemon keeps state in memory and a restart forgets
    // everything. Its silence is therefore evidence of nothing, and saying
    // "hooks are not wired, restart it" would send someone to restart a session
    // that is working perfectly and will reappear the moment it does anything.
    const predatesDaemon =
      body.daemonStartedAt !== undefined && s.startedAt != null && s.startedAt < body.daemonStartedAt;

    if (predatesDaemon && s.sandboxBlocked !== true) {
      menu.push({
        text: `Started before astir was listening, so nothing has been`,
        depth: 1,
        colour: COLOUR.dim,
      });
      menu.push({
        text: `heard from it yet — it will appear as soon as it does`,
        depth: 1,
        colour: COLOUR.dim,
      });
      menu.push({ text: `anything`, depth: 1, colour: COLOUR.dim });
    } else if (s.sandboxBlocked === true) {
      // The one silent case astir can prove rather than guess.
      menu.push({
        text: `This project is sandboxed, so its hooks cannot reach the`,
        depth: 1,
        colour: COLOUR.dim,
      });
      menu.push({ text: `daemon — the proxy refuses them before they arrive`, depth: 1, colour: COLOUR.dim });
      menu.push({
        text: `Allow astir through this project's sandbox`,
        depth: 1,
        action: { argv: [...exe, ...["allow-sandbox", s.cwd]] },
      });
    } else if (rejecting) {
      menu.push({ text: `Hooks are firing but the token is rejected`, depth: 1, colour: COLOUR.dim });
      menu.push({ text: "Run `astir install` to repair the token", depth: 1, colour: COLOUR.dim });
    } else if (hooksLookUnwired(body, now)) {
      // OBS-01's inverse, fixed: this was computed on every `/state` and read
      // by nothing. It answers a question none of the branches above can —
      // not "this session is quiet" but "NOTHING has ever arrived, from
      // anything", which means the hooks were never wired rather than that this
      // particular session is old. It is the first-install case, and the one
      // where every other explanation here is wrong.
      //
      // Placed last among the specific causes because it is the least likely on
      // a working machine and the most likely on a broken one, and the generic
      // "restart it" below would otherwise claim it.
      menu.push({
        text: `No event has EVER reached astir, so the hooks are not`,
        depth: 1,
        colour: COLOUR.dim,
      });
      menu.push({ text: "wired at all — `astir install` registers them", depth: 1, colour: COLOUR.dim });
    } else {
      menu.push({
        text: `Hooks bind when a session starts, so one older than`,
        depth: 1,
        colour: COLOUR.dim,
      });
      menu.push({ text: `the astir plugin never sends anything — restart it`, depth: 1, colour: COLOUR.dim });
    }
  }

  const elsewhere = mergeRemoteSessions(opts.remote?.sessions ?? [], body.remote ?? []);
  remoteSection(menu, remote, elsewhere, now, exe, separator);

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
    menu.push({ text: `${n} background session${n === 1 ? "" : "s"}`, depth: 0, colour: COLOUR.dim });
    menu.push({
      text: `Launched by a plugin or script — nothing here waits on you`,
      depth: 1,
      colour: COLOUR.dim,
    });
    for (const c of chores) {
      const where = c.where === null ? "" : `  ·  ${safe(c.where)}`;
      menu.push({
        text: `${safe(repoName(c.cwd, c.sessionId.slice(0, 8)))}${where}`,
        depth: 1,
        colour: COLOUR.dim,
        monospace: true,
      });
    }
  }

  separator();
  // Offered only on this path, deliberately: the view is served BY the local
  // daemon, so when that is unreachable the item would open a browser tab at a
  // refused connection. The degraded path leaves it out rather than handing
  // someone an action that cannot work.
  menu.push({ text: `Open the web view`, depth: 0, action: { argv: [...exe, ...["view"]] } });
  menu.push({ text: "Refresh", depth: 0, refresh: true });
  return finish(menu);
}

/**
 * The SwiftBar/xbar plugin text.
 *
 * Kept as the composition it now is, so every existing caller — the plugin
 * script, `astir menubar`, 75 tests — is untouched by the split.
 */
export function renderMenubar(result: StatusResult, opts: MenubarOpts): string {
  return `${toSwiftBar(buildMenu(result, opts))}\n`;
}
