/**
 * PSH-03/PSH-08 — render the ambient menu-bar view.
 *
 * Emits SwiftBar/xbar plugin format: the lines before `---` are what shows in the
 * menu bar itself, everything after is the dropdown. `--` prefixes a nested item.
 *
 * This is a pure function on purpose. The menu bar is the surface most likely to
 * be replaced — SwiftBar is a single-maintainer dependency, and a tray app or a
 * shell prompt might take over — so the formatting logic is kept testable and
 * free of any I/O, and the host is a three-line wrapper.
 */

import type { StatusBody, StatusResult, StatusSession } from "./types.js";

/** States that mean work is actively happening. */
const WORKING = new Set(["thinking", "tool-running"]);

function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

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

export function renderMenubar(result: StatusResult): string {
  const lines: string[] = [];

  if (!result.ok) {
    // Deliberately distinct from "idle": the daemon being unreachable is
    // information, and rendering it as calm would be a lie.
    lines.push("clide ⚠ | sfimage=exclamationmark.triangle color=#888888");
    lines.push("---");
    lines.push(`${safe(result.reason)} | color=#888888`);
    lines.push("Start the daemon | bash=clide param1=daemon terminal=true");
    lines.push("Refresh | refresh=true");
    return `${lines.join("\n")}\n`;
  }

  const { body } = result;
  const blocked = body.blockedCount;
  const working = countWorking(body);

  // The menu bar line. Blocked always wins — it is the only state that needs a
  // human, and the whole surface exists for it.
  if (blocked > 0) {
    lines.push(`${blocked} | sfimage=bell.badge.fill color=#ff9500 font=Menlo`);
  } else if (working > 0) {
    lines.push(`${working} | sfimage=circle.fill color=#34c759 font=Menlo`);
  } else if (body.sessions.length > 0) {
    lines.push("| sfimage=circle color=#888888");
  } else {
    lines.push("| sfimage=circle.dotted color=#666666");
  }

  lines.push("---");

  if (blocked > 0) {
    lines.push(
      `${blocked} agent${blocked === 1 ? "" : "s"} waiting on you | color=#ff9500 sfimage=bell.badge.fill`,
    );
    lines.push("---");
  }

  if (body.sessions.length === 0) {
    lines.push("No live sessions | color=#888888");
  }

  for (const session of body.sessions) {
    const blockedHere = session.agents.filter((a) => a.state === "blocked").length;
    const marker = blockedHere > 0 ? " ⏳" : "";
    lines.push(`${safe(label(session))}${marker} | color=${blockedHere > 0 ? "#ff9500" : "#ffffff"}`);
    lines.push(`-- ${safe(session.cwd)} | color=#888888`);

    for (const agent of session.agents) {
      const who = agent.agentType ?? "main";
      const time =
        agent.state === "blocked"
          ? `waiting ${humanDuration(agent.blockedMs)}`
          : `active ${humanDuration(agent.activeMs)}`;
      const colour = agent.state === "blocked" ? "#ff9500" : "#cccccc";
      lines.push(`-- ${agent.state.padEnd(12)} ${safe(who)}  ·  ${time} | color=${colour} font=Menlo`);
    }
  }

  lines.push("---");
  lines.push("Refresh | refresh=true");
  return `${lines.join("\n")}\n`;
}
