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

/**
 * #82 — why a probe that got no HTTP answer at all got none, as a value.
 *
 * - `refused`: nothing is listening. On a machine reached over `ssh -R`, that
 *   is no tunnel.
 * - `silent`: something accepted the connection and sent nothing back before
 *   the probe's timeout. Decided by time alone, so it says what was seen, not
 *   why: an `ssh -R` forward still held by a session that dropped (which
 *   accepts on the server and has no client to carry the connection to), a
 *   hung notifier, or one slower than the timeout. `doctor` names the likely
 *   one from what it knows about this machine.
 * - `closed`: something accepted the connection and hung up (or reset it)
 *   without answering — what `ssh -R` does when the tunnel is up and nothing
 *   listens at its far end.
 * - `other`: anything else before an answer, such as a peer that does not
 *   speak HTTP.
 *
 * Absent when something did answer (a non-notifier, a 500): `reason` says
 * what.
 */
export type ProbeFailure = "refused" | "silent" | "closed" | "other";

/** The reasons a surface may print or a test may assert, worded once. */
export const PROBE_REASON = {
  refused: "no tunnel",
  silent: "something holds the port but did not answer in time",
  closed: "something accepted the connection and closed it without answering",
  notNotifier: "something else is listening on this port",
} as const;

/** Where the notifier on this port is reached: the URL the probe attaches. */
export function notifierUrl(port: number): string {
  return `http://127.0.0.1:${port}/notify`;
}

/** 127.0.0.0/8, `localhost` and `::1` — as `URL` spells a hostname: lower case, 127.1 widened, IPv6 bracketed. */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

/**
 * #82 — whether `url` is the notifier `status --line` asks on this machine's
 * `port`, which it reaches as `notifierUrl(port)`: plain http to a loopback
 * address on that port. By address, never by spelling: a `--notify-url`
 * typed as `http://localhost:47001/notify` is the same notifier, and was
 * read as another one. Not a host that is not loopback on the same port
 * number, which is some other machine's port, not the one the line dials.
 * False for anything that is not a URL.
 */
export function isNotifierOn(url: string, port: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  // `URL` drops a port that is the scheme's default: 80, for http.
  const effective = parsed.port === "" ? 80 : Number(parsed.port);
  return effective === port && isLoopbackHost(parsed.hostname);
}

export interface DetectResult {
  found: boolean;
  url: string;
  reason?: string;
  /** #82 — set only when nothing answered; see `ProbeFailure`. */
  failure?: ProbeFailure;
  /**
   * #78 — what the notifier says about its own screen: false when it cannot
   * show a notification (a headless box), so a daemon never counts it as a
   * way to reach anyone. Absent from a notifier older than the field, which
   * is "did not say", not "cannot".
   */
  canShow?: boolean;
}

/** The `code` of a fetch failure's cause, where undici put one. */
function causeCode(err: unknown): string | undefined {
  // No AggregateError branch: happy eyeballs reports one only for a NAME that
  // resolves to several addresses, and the probe dials a literal 127.0.0.1.
  const code = ((err as { cause?: unknown } | null)?.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * #82 — what a failed `fetch` says about the far end, read off undici's error
 * shapes as measured against real sockets (Node 22):
 *
 * - a closed port: `TypeError("fetch failed")`, `cause.code` `ECONNREFUSED`;
 * - a socket that accepts and never writes: the request's own deadline, a
 *   `TimeoutError` DOMException with no cause;
 * - a socket that accepts and closes: `cause.code` `UND_ERR_SOCKET` ("other
 *   side closed"); one that resets: `ECONNRESET`;
 * - one that writes something not HTTP: an `HPE_*` code.
 *
 * Only for a failure BEFORE the response's headers: a deadline that passes
 * while the body is read is something that answered and stalled, and must not
 * read as silence. Only the request's own `TimeoutError` is silence: an
 * `AbortError` is a caller giving up, which says nothing about the far end.
 *
 * `EPIPE` is not listed with the hang-ups: it could not be provoked from a
 * request at all (a 4 MB POST to a socket that resets still says
 * `ECONNRESET`), and a GET probe writes far less. Should it ever come, it is
 * `other`, and still never "no tunnel".
 */
export function classifyProbeFailure(err: unknown): ProbeFailure {
  if ((err as { name?: unknown } | null)?.name === "TimeoutError") return "silent";
  const code = causeCode(err);
  if (code === "ECONNREFUSED") return "refused";
  if (code === "UND_ERR_SOCKET" || code === "ECONNRESET") return "closed";
  return "other";
}

/**
 * What the daemon's log and `doctor` print for a failure. Content-free: never
 * the error's own text, and a code only when it looks like the constant a code
 * is — the reason goes into a log and a terminal, and the error came off a
 * socket.
 */
export function probeReason(failure: ProbeFailure, err: unknown): string {
  if (failure !== "other") return PROBE_REASON[failure];
  const code = causeCode(err);
  return code !== undefined && /^[A-Z][A-Z0-9_]{0,39}$/.test(code)
    ? `probe failed (${code})`
    : "probe failed";
}

/**
 * Is there a astir notifier on this port? Checked by role rather than by mere
 * reachability — something else on 47001 answering 200 must not be mistaken for
 * a place to send notifications.
 *
 * #82 — and when nothing answers, says which nothing: a closed port (no
 * tunnel), one that accepts and does not answer (something holds it), and one
 * that hangs up need different fixes, and all of them used to read "no
 * tunnel".
 */
export async function detectNotifier(port: number, timeoutMs = 1_500): Promise<DetectResult> {
  const url = notifierUrl(port);
  let answered = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    answered = true;
    if (!res.ok) return { found: false, url, reason: `HTTP ${res.status}` };
    const body = (await res.json()) as { role?: string; canShow?: unknown };
    if (body.role !== "notifier") {
      return { found: false, url, reason: PROBE_REASON.notNotifier };
    }
    return typeof body.canShow === "boolean"
      ? { found: true, url, canShow: body.canShow }
      : { found: true, url };
  } catch (err) {
    // Something answered, then sent what no notifier sends (or stalled): it
    // is not one, and it is certainly not a missing tunnel.
    if (answered) return { found: false, url, reason: PROBE_REASON.notNotifier };
    const failure = classifyProbeFailure(err);
    return { found: false, url, failure, reason: probeReason(failure, err) };
  }
}
