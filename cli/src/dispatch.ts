export const COMMANDS = new Set(["tui", "aggregate", "install", "watch", "doctor"]);
export interface ParsedArgv { command: string; args: string[]; flags: Record<string, string | boolean>; }

export function parseArgv(argv: string[]): ParsedArgv {
  const [cmd, ...rest] = argv;
  if (!cmd || !COMMANDS.has(cmd)) return { command: "help", args: [], flags: {} };
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    if (tok.startsWith("--")) {
      const name = tok.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags[name] = next; i++; }
      else flags[name] = true;
    } else args.push(tok);
  }
  return { command: cmd, args, flags };
}
