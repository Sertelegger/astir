/**
 * The CLI's argument parsing, on its own so a test can import it without
 * starting the CLI (main.ts runs `main()` when it is loaded).
 */

export interface Args {
  command: string;
  flags: Map<string, string | boolean>;
  /** Non-flag arguments, in order — e.g. the session id for `focus`/`dismiss`. */
  positional: string[];
}

export function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === undefined) continue;
    // `--` ends the options: what follows is positional however it is
    // spelled, so a caller can pass an id it did not write without it ever
    // being read as a flag. (astir-tui does not rely on it: it must also work
    // with an astir built before this, so it refuses an id that begins with
    // `-` instead.)
    if (tok === "--") {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (!tok.startsWith("--")) {
      positional.push(tok);
      continue;
    }
    const name = tok.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }
  return { command, flags, positional };
}
