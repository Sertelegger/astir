/**
 * DMN-09 (option 2) — see sessions on machines you are only SSH'd into.
 *
 * A Claude Code session opened through VS Code Remote-SSH, or in a terminal on
 * another box, runs its process THERE. `claude agents --json` on this machine
 * therefore cannot see it, and the menu bar showed nothing at all — not even
 * "there is something over there I cannot reach", which is the honesty rule this
 * project is built on.
 *
 * So ask the other machine, over the SSH access the user already has. Nothing is
 * installed remotely and no daemon need be running there; this works with a
 * plain `claude` on the far side.
 *
 * Two properties matter more than completeness:
 *
 * 1. **It never blocks a render.** Polling happens on a timer in the daemon and
 *    the menu bar reads a cache. An SSH round trip is hundreds of milliseconds
 *    on a good link and unbounded on a bad one; doing it per render would make
 *    the surface hang on the slowest host the user owns.
 * 2. **A host that stops answering goes stale, not absent.** Dropping it would
 *    render an unreachable machine identically to one with nothing running.
 */

import { execFile } from "node:child_process";
import type { RemoteSession } from "../status/types.js";
import { type DiscoveredSession, parseAgentsJson } from "./sessions.js";

/** Long enough for a slow link, short enough not to stack up behind the poll. */
const SSH_TIMEOUT_MS = 8_000;
/** After this long without an answer, a host's sessions are marked stale. */
export const STALE_AFTER_MS = 90_000;
/** After this long, we stop claiming to know anything about it at all. */
export const FORGET_AFTER_MS = 15 * 60_000;

export type RemoteLister = (host: string) => Promise<DiscoveredSession[] | null>;

/**
 * `BatchMode=yes` so a host needing a passphrase fails fast instead of hanging
 * on a prompt nobody can answer — the daemon has no terminal.
 *
 * The command runs through a LOGIN shell, which is not a detail. `ssh host cmd`
 * runs a non-interactive, non-login shell that sources no profile, so a `claude`
 * installed by a version manager or into ~/.local/bin is simply not on PATH and
 * the probe returns "command not found" — indistinguishable here from a host
 * with nothing running. Verified against a real host: bare `claude agents
 * --json` fails, `$SHELL -lc` succeeds. Same failure this project already hit
 * with SwiftBar's launchd PATH.
 */
export function sshArgs(host: string, timeoutMs = SSH_TIMEOUT_MS): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${Math.max(1, Math.round(timeoutMs / 1000))}`,
    host,
    // Follows the remote user's own shell rather than assuming bash exists.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell expansion evaluated on the remote host, not here
    '${SHELL:-/bin/sh} -lc "claude agents --json"',
  ];
}

export function createSshLister(timeoutMs = SSH_TIMEOUT_MS): RemoteLister {
  return (host) =>
    new Promise((resolve) => {
      execFile(
        "ssh",
        sshArgs(host, timeoutMs),
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return resolve(null);
          resolve(parseAgentsJson(stdout));
        },
      );
    });
}

interface HostState {
  sessions: RemoteSession[];
  lastSeen: number;
}

export interface RemoteDiscoveryOpts {
  hosts: () => string[];
  list: RemoteLister;
  now?: () => number;
}

export class RemoteDiscovery {
  private readonly state = new Map<string, HostState>();
  private readonly now: () => number;
  private polling = false;

  constructor(private readonly opts: RemoteDiscoveryOpts) {
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Ask every paired host at once.
   *
   * Concurrent rather than sequential because the cost of one unreachable host
   * would otherwise be paid by every host after it, and re-entrant polls are
   * skipped so a slow round trip cannot stack up behind the timer.
   */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const hosts = this.opts.hosts();
      await Promise.all(
        hosts.map(async (host) => {
          const found = await this.opts.list(host).catch(() => null);
          // null is "could not ask", which must not be read as "nothing runs
          // there" — that is the distinction the whole staleness model rests on.
          if (found === null) return;
          const now = this.now();
          this.state.set(host, {
            lastSeen: now,
            sessions: found.map((d) => ({
              host,
              sessionId: d.sessionId,
              cwd: d.cwd,
              name: d.name,
              status: d.status,
              source: "ssh" as const,
              lastSeen: now,
            })),
          });
        }),
      );

      // A host that has fallen out of the paired list is not stale, it is gone.
      const paired = new Set(this.opts.hosts());
      for (const host of [...this.state.keys()]) {
        if (!paired.has(host)) this.state.delete(host);
      }
    } finally {
      this.polling = false;
    }
  }

  list(): RemoteSession[] {
    const now = this.now();
    const out: RemoteSession[] = [];
    for (const [host, s] of [...this.state]) {
      const age = now - s.lastSeen;
      if (age >= FORGET_AFTER_MS) {
        this.state.delete(host);
        continue;
      }
      const stale = age >= STALE_AFTER_MS;
      for (const session of s.sessions) out.push(stale ? { ...session, stale: true } : session);
    }
    return out;
  }
}
