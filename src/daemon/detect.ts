/**
 * Is the thing on this port THIS machine's daemon?
 *
 * The mirror of `detectNotifier`, and it exists for the same reason arrived at
 * the hard way: a port answering 200 is not proof of what is behind it. The
 * notifier has refused anything not reporting its role since it was written.
 * The daemon had no such check, so nothing could tell this machine's daemon
 * from another machine's reached through a forwarded port — and because `astir
 * pair` copies one token to both machines, that impostor authenticates cleanly
 * and its sessions render as local.
 *
 * The common way to end up there is not exotic. VS Code Remote-SSH forwards the
 * ports it sees listening on the remote host, and astir's audience is people
 * developing on remote hosts.
 */

import { hostname } from "node:os";
import { sameHost, shortHost } from "../notify/envelope.js";

export type DaemonProbe =
  /** This machine's daemon, as expected. */
  | { kind: "mine"; host: string }
  /** A astir daemon, but somewhere else — almost always a forwarded port. */
  | { kind: "foreign"; host: string }
  /**
   * Something answered and is not an astir daemon.
   *
   * Also what an older daemon looks like, since it sends no role. Reported as
   * `unknown` rather than assumed hostile: "I cannot tell" is the honest
   * reading, and it is the one a surface can act on without lying.
   */
  | { kind: "unknown"; detail: string }
  /** Nothing there. The ordinary case when the daemon is simply not running. */
  | { kind: "absent"; detail: string };

export async function probeDaemon(port: number, timeoutMs = 1_500): Promise<DaemonProbe> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { kind: "unknown", detail: `HTTP ${res.status}` };
    const body = (await res.json()) as { role?: unknown; host?: unknown };
    if (body.role !== "daemon") {
      return { kind: "unknown", detail: "not an astir daemon, or one too old to say" };
    }
    if (typeof body.host !== "string") {
      return { kind: "unknown", detail: "a daemon that does not say which machine it is" };
    }
    return sameHost(body.host, hostname())
      ? { kind: "mine", host: shortHost(body.host) }
      : { kind: "foreign", host: shortHost(body.host) };
  } catch {
    return { kind: "absent", detail: "nothing is listening" };
  }
}
