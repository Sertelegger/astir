/**
 * OBS-02 — `ASTIR_DEBUG=1` enables verbose logging.
 *
 * A spec MUST that nothing implemented. Worth building rather than striking,
 * because it is the diagnosis path this project keeps needing: almost every bug
 * in recent memory — a roster reflected back through a tunnel, one process
 * listed as two sessions, a half-open stream, sidecars unreachable under a
 * second profile — was found by adding temporary instrumentation and taking it
 * out again. This makes that a supported action instead of a patch.
 *
 * ## SEC-01 is the interesting constraint
 *
 * *"Reasoning text and tool payloads MUST NOT be written to disk by Astir."*
 * Verbose logging is the obvious way to violate that by accident, so this file
 * takes only what astir's in-memory model already holds — counts, ids, kinds,
 * names — and offers no way to pass a payload. `fields` is
 * `Record<string, string | number | boolean | null>`: an object or an array
 * will not typecheck, which is a weaker guarantee than a reviewer and a
 * stronger one than a convention.
 *
 * ## stderr, not stdout
 *
 * `astir daemon` prints its bound address on stdout as its first line, and the
 * artifact test parses it. Debug output there would corrupt a contract.
 *
 * ## Read once
 *
 * The flag is sampled at import. A daemon runs for days; re-reading the
 * environment per call would spend a syscall on a value that cannot change
 * within a process.
 */

export type DebugValue = string | number | boolean | null;

const ENABLED = process.env.ASTIR_DEBUG === "1";

/** True when verbose logging is on. Exported so a caller can skip real work. */
export function debugEnabled(): boolean {
  return ENABLED;
}

/**
 * Log one line, if enabled.
 *
 * `scope` names the subsystem so output can be grepped by area — `ingest`,
 * `discovery`, `notify`, `stream`. Nothing here formats a payload: if a value
 * is not already a scalar in astir's model, it does not belong in a log line.
 */
export function debug(scope: string, message: string, fields: Record<string, DebugValue> = {}): void {
  if (!ENABLED) return;
  const pairs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? "null" : String(v)}`)
    .join(" ");
  // Millisecond timestamps, because the questions this answers are almost
  // always about ordering: which of two things happened first, and how long
  // the gap was.
  process.stderr.write(
    `[astir ${scope}] ${new Date().toISOString()} ${message}${pairs === "" ? "" : ` ${pairs}`}\n`,
  );
}
