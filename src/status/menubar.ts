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

import type { StatusAgent, StatusBody, StatusResult, StatusSession } from "./types.js";

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
}

export interface MenubarOpts {
  /**
   * Absolute path to the `clide` executable. Menu items run through SwiftBar's
   * `bash=`, which does not inherit the user's interactive PATH, so a bare
   * `clide` silently does nothing when clicked — the exact failure this option
   * exists to prevent.
   */
  exe: string;
  /**
   * PSH-12 — agents blocked on other machines, from the local notifier. `null`
   * means no notifier is running, which is different from "no remote agents" and
   * must not be rendered as calm.
   */
  remote?: { agents: RemoteEntry[] } | null;
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
 * What the human calls this session. `name` is Claude Code's own session slug
 * from `claude agents --json` (e.g. "clide-ac") — it reads like a branch name but
 * is not one. Falling back to the directory basename keeps the label meaningful
 * for a session discovery has not yet enriched.
 */
function label(session: StatusSession): string {
  if (session.name) return session.name;
  const base = session.cwd.split("/").filter(Boolean).pop();
  return base ?? session.sessionId.slice(0, 8);
}

/** SwiftBar treats `|` as the start of parameters, so it cannot appear in text. */
function safe(text: string): string {
  return text.replace(/\|/g, "¦").replace(/\n/g, " ");
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
  if (WORKING.has(agent.state)) {
    return `active ${humanDuration(agent.activeMs + agent.inStateMs)}`;
  }
  return `${humanDuration(agent.inStateMs)}`;
}

export function renderMenubar(result: StatusResult, opts: MenubarOpts): string {
  const lines: string[] = [];
  /** SwiftBar renders consecutive separators as a visible double rule. */
  const separator = (): void => {
    if (lines.at(-1) !== "---") lines.push("---");
  };
  const exe = opts.exe;
  const now = opts.now ?? Date.now();
  const remote = opts.remote?.agents ?? [];
  const remoteBlocked = remote.filter((r) => !r.acknowledged).length;

  if (!result.ok) {
    // Deliberately distinct from "idle": the daemon being unreachable is
    // information, and rendering it as calm would be a lie.
    lines.push("clide ⚠ | sfimage=exclamationmark.triangle color=#888888");
    lines.push("---");
    lines.push(`${safe(result.reason)} | color=#888888`);
    lines.push(`Start the daemon | bash=${exe} param1=daemon terminal=true`);
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
    lines.push(`${blocked} | sfimage=bell.badge.fill color=#ff9500 font=Menlo`);
  } else if (working > 0) {
    lines.push(`${working} | sfimage=circle.fill color=#34c759 font=Menlo`);
  } else if (body.sessions.length > 0 || remote.length > 0) {
    lines.push("| sfimage=circle color=#888888");
  } else {
    lines.push("| sfimage=circle.dotted color=#666666");
  }

  lines.push("---");

  if (blocked > 0) {
    lines.push(
      `${blocked} agent${blocked === 1 ? "" : "s"} waiting on you | color=#ff9500 sfimage=bell.badge.fill`,
    );
    lines.push(`Dismiss all | bash=${exe} param1=dismiss terminal=false refresh=true`);
    lines.push("---");
  }

  if (body.sessions.length === 0 && remote.length === 0) {
    lines.push("No live sessions | color=#888888");
  }

  for (const session of body.sessions) {
    const blockedHere = session.agents.filter((a) => a.state === "blocked" && !a.acknowledged).length;
    const marker = blockedHere > 0 ? " ⏳" : "";

    // Clicking the session goes to where the work is. `terminal=false` because
    // `clide focus` drives the window manager itself and must not open a shell.
    lines.push(
      `${safe(label(session))}${marker} | color=${blockedHere > 0 ? "#ff9500" : "#ffffff"}` +
        ` bash=${exe} param1=focus param2=${session.sessionId} terminal=false refresh=true`,
    );
    lines.push(`-- ${safe(session.cwd)} | color=#888888`);

    for (const agent of session.agents) {
      const who = agent.agentType ?? "main";
      const dismissed = agent.state === "blocked" && agent.acknowledged;
      // Dismissed agents stay listed but stop shouting: still blocked, already seen.
      const colour = dismissed ? "#888888" : agent.state === "blocked" ? "#ff9500" : "#cccccc";
      const suffix = dismissed ? "  (dismissed)" : "";
      lines.push(
        `-- ${agent.state.padEnd(12)} ${safe(who)}  ·  ${timeText(agent)}${suffix} | color=${colour} font=Menlo`,
      );
    }

    if (blockedHere > 0) {
      lines.push(
        `-- Dismiss this session | bash=${exe} param1=dismiss param2=${session.sessionId} terminal=false refresh=true`,
      );
    }
    lines.push(
      `-- Forget this session | bash=${exe} param1=forget param2=${session.sessionId} terminal=false refresh=true color=#888888`,
    );
  }

  if (remote.length > 0) {
    separator();
    lines.push("Other machines | color=#888888");
    for (const entry of remote) {
      const marker = entry.acknowledged ? "" : " ⏳";
      const colour = entry.acknowledged ? "#888888" : "#ff9500";
      lines.push(`${safe(entry.host)} · ${safe(entry.repo)}${marker} | color=${colour}`);
      const suffix = entry.acknowledged ? "  (dismissed)" : "";
      lines.push(
        `-- ${safe(entry.reason)}  ·  waiting ${humanDuration(Math.max(0, now - entry.since))}${suffix}` +
          " | color=#cccccc font=Menlo",
      );
      // No focus action: there is no window on this machine to raise.
      lines.push(
        `-- Dismiss | bash=${exe} param1=dismiss param2=${entry.sessionId} terminal=false refresh=true`,
      );
    }
  }

  separator();
  lines.push("Refresh | refresh=true");
  return `${lines.join("\n")}\n`;
}
