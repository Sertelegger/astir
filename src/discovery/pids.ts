/**
 * DMN-05 for a provider that cannot list its sessions.
 *
 * Claude Code answers "what is running?" with `claude agents --json`; Codex has
 * no equivalent. Without an answer, nothing ever reaps a Codex session that dies
 * without `SessionEnd` — and a blocked one, which by definition sends nothing,
 * would be reminded about forever. A crashed terminal is not an exotic case.
 *
 * What Codex can do is say which process a session lives in: its hook relay
 * finds the Codex pid and sends it. This turns that into discovery's answer, so
 * the registry's ordinary machinery — pruning, the undiscovered sweep, DMN-06's
 * restore confirmation — applies unchanged.
 *
 * **A pid alone is not an identity.** Pids are recycled, quickly on a busy
 * machine, so a session is vouched for only while its pid belongs to a process
 * that started at the same moment as the one that reported in. The start time
 * comes from the same process table, so the check costs one `ps` per tick for
 * every such session together.
 */

import { execFile } from "node:child_process";
import type { PidCandidate } from "../model/registry.js";
import { isAttended } from "./attended.js";
import type { DiscoveredSession } from "./sessions.js";

export interface ProcessInfo {
  /** Epoch ms, to the second — `ps` reports no finer, and the same process always reports the same. */
  startedAt: number;
  tty: string;
}

/** Null when the table could not be read: "could not tell", never "nothing runs". */
export type ProcessTable = () => Promise<Map<number, ProcessInfo> | null>;

/** `pid tty lstart`, where `lstart` is five fields: `Wed Sep 30 22:00:00 2026`. */
export function parseProcessTable(stdout: string): Map<number, ProcessInfo> {
  const out = new Map<number, ProcessInfo>();
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s*$/.exec(line);
    if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) continue;
    const startedAt = Date.parse(m[3]);
    if (Number.isNaN(startedAt)) continue;
    out.set(Number.parseInt(m[1], 10), { startedAt, tty: m[2] });
  }
  return out;
}

export function createProcessTable(timeoutMs = 3_000): ProcessTable {
  return () =>
    new Promise((resolve) => {
      execFile(
        "ps",
        ["-A", "-o", "pid=,tty=,lstart="],
        // `lstart` is printed in the locale's words, and only the C locale's
        // are ones `Date.parse` reads.
        { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
        (err, stdout) => {
          if (err) return resolve(null);
          const table = parseProcessTable(stdout);
          // A table without even this process in it was not read correctly.
          resolve(table.has(process.pid) ? table : null);
        },
      );
    });
}

export function createPidLister(
  candidates: () => PidCandidate[],
  table: ProcessTable,
): () => Promise<{ complete: boolean; sessions: DiscoveredSession[] } | null> {
  return async () => {
    const wanted = candidates();
    if (wanted.length === 0) return { complete: true, sessions: [] };
    const procs = await table();
    if (procs === null) return null;
    const ttys = new Map([...procs].map(([pid, p]) => [pid, p.tty]));

    const sessions: DiscoveredSession[] = [];
    for (const c of wanted) {
      const p = procs.get(c.pid);
      if (p === undefined) continue; // gone
      // A start time already on record that differs means the pid now
      // belongs to something else. None on record yet means this is the
      // first look, and the process that is there IS the one that reported.
      if (c.startedAt !== null && c.startedAt !== p.startedAt) continue;
      const attended = isAttended(c.pid, ttys);
      sessions.push({
        sessionId: c.sessionId,
        cwd: c.cwd,
        pid: c.pid,
        status: null,
        name: null,
        startedAt: p.startedAt,
        ...(attended === undefined ? {} : { attended }),
      });
    }
    return { complete: true, sessions };
  };
}
