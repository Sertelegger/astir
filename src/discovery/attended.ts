/**
 * DMN-11 — is a human actually sitting at this session?
 *
 * Plugins and scripts launch Claude Code too. claude-mem runs observer sessions,
 * CI runs headless ones, and a `--input-format stream-json --permission-prompt-tool`
 * session is driven entirely by another program. They are real sessions, but
 * they are not *yours*: nothing there will ever wait on you, and listing them
 * beside the two repos you are actually working in is noise in the one view
 * whose whole job is "which of these needs me".
 *
 * The discriminator is the controlling terminal. A session a human can type at
 * has one; a session launched by a program has none. Verified across a live
 * machine: two interactive sessions on `ttys002`/`ttys010`, a claude-mem
 * observer on `??`.
 *
 * Deliberately NOT any of the tempting alternatives:
 *
 *   - the cwd (`.claude-mem/...`) — hardcodes one plugin's layout and silently
 *     fails to classify the next tool that does the same thing;
 *   - the `kind` field from `claude agents --json` — measured, and it reports
 *     `"interactive"` for the observer sessions too, so it does not separate
 *     them at all;
 *   - the command line (`--output-format stream-json` and friends) — provider
 *     specific, and a flag list to chase as the CLI changes.
 *
 * A terminal is a property of the process, not of Claude Code, so this keeps
 * working for Codex (G5) and for whatever launches a session next.
 */

import { execFile } from "node:child_process";

export type TtyReader = () => Promise<Map<number, string>>;

/** `??` on macOS, `?` on Linux — both mean "no controlling terminal". */
function attachedTty(value: string): boolean {
  const tty = value.trim();
  return tty.length > 0 && tty !== "??" && tty !== "?" && tty !== "-";
}

/**
 * Every process's controlling terminal, in ONE call.
 *
 * Per-pid would mean a `ps` spawn per session on every discovery poll; one
 * listing costs the same regardless of how many sessions are running.
 */
export function createTtyReader(timeoutMs = 3_000): TtyReader {
  return () =>
    new Promise((resolve) => {
      execFile(
        "ps",
        ["-eo", "pid=,tty="],
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return resolve(new Map());
          resolve(parseTtyTable(stdout));
        },
      );
    });
}

export function parseTtyTable(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\S*)\s*$/.exec(line);
    if (m?.[1] === undefined) continue;
    out.set(Number.parseInt(m[1], 10), m[2] ?? "");
  }
  return out;
}

/**
 * `undefined` when we cannot tell, which is NOT the same as unattended.
 *
 * `ps` is absent on native Windows (PLT-02), and a pid may exit between the
 * listing and the lookup. Guessing "background" there would quietly hide a
 * session the user is sitting at — the one failure this must never have — so
 * anything unknown is left unclassified and treated as attended downstream.
 */
export function isAttended(pid: number | null, ttys: Map<number, string>): boolean | undefined {
  if (pid === null || ttys.size === 0) return undefined;
  const tty = ttys.get(pid);
  if (tty === undefined) return undefined;
  return attachedTty(tty);
}
