/**
 * PSH-14 — find the notifier without being told where it is.
 *
 * The old setup asked the user to pass `--notify-url` on the *remote* machine,
 * pointing at a port forwarded from the machine they are sitting at. That is
 * backwards: the flag has to be typed on the box you are least likely to be
 * looking at, it is identical every time, and getting it wrong fails silently.
 *
 * Since an `ssh -R` tunnel presents the notifier on loopback at a known port, the
 * daemon can simply look. Probing is cheap, and repeating it matters more than
 * doing it once: a tunnel appears when you connect and disappears when you close
 * the laptop, so a daemon that probed only at startup would be wrong for most of
 * its life.
 */

export interface DetectResult {
  found: boolean;
  url: string;
  reason?: string;
}

/**
 * Is there a astir notifier on this port? Checked by role rather than by mere
 * reachability — something else on 47001 answering 200 must not be mistaken for
 * a place to send notifications.
 */
export async function detectNotifier(port: number, timeoutMs = 1_500): Promise<DetectResult> {
  const url = `http://127.0.0.1:${port}/notify`;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { found: false, url, reason: `HTTP ${res.status}` };
    const body = (await res.json()) as { role?: string };
    if (body.role !== "notifier") {
      return { found: false, url, reason: "something else is listening on this port" };
    }
    return { found: true, url };
  } catch {
    return { found: false, url, reason: "no tunnel" };
  }
}
