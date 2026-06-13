export const START = "# >>> clide (managed — do not edit) >>>";
export const END = "# <<< clide (managed) <<<";
const EVENTS = ["SessionStart", "PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Stop"];

function block(command: string): string {
  const tables = EVENTS.map((e) => `[[hooks.${e}]]\ntype = "command"\ncommand = "${command}"`).join("\n\n");
  return `${START}\n${tables}\n${END}`;
}

/**
 * Insert/replace Clide's managed hook block in a config.toml string. Only the sentinel-delimited
 * region is touched; ALL other (user) content is preserved verbatim (REQ-008). The hook command is a
 * fixed static string — no interpolation of session/path values.
 */
export function writeManagedBlock(existing: string, command: string): string {
  // Split on sentinels to isolate non-managed parts, then trim and rejoin — guarantees idempotency.
  const si = existing.indexOf(START);
  const ei = si === -1 ? -1 : existing.indexOf(END, si);

  // Collect non-managed text: everything before START (if present) + everything after END (if present)
  let userPart: string;
  if (si === -1) {
    userPart = existing;
  } else if (ei === -1) {
    // Malformed: START without END — treat everything before START as user content
    userPart = existing.slice(0, si);
  } else {
    // Content after END (skip the END line itself)
    const afterEnd = existing.slice(ei + END.length);
    userPart = existing.slice(0, si) + afterEnd;
  }

  const trimmed = userPart.trimEnd();
  const sep = trimmed.length > 0 ? "\n\n" : "";
  return `${trimmed}${sep}${block(command)}\n`;
}

export function removeManagedBlock(existing: string): string {
  const si = existing.indexOf(START);
  if (si === -1) return existing;
  const ei = existing.indexOf(END, si);
  if (ei === -1) {
    // Malformed: no END — strip from START onward
    return existing.slice(0, si).trimEnd() + "\n";
  }
  const before = existing.slice(0, si);
  const after = existing.slice(ei + END.length);
  return (before + after).trimEnd() + "\n";
}
