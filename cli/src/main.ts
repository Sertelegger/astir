/* c8 ignore start — CLI process glue; subcommand routing + live /healthz probe verified manually */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { parseArgv } from "./dispatch.js";
import { cleanStale } from "./doctor.js";

const SESSIONS = join(homedir(), ".clide", "sessions");
const LOGS = join(homedir(), ".clide", "logs");

/** Live iff GET /healthz on the recorded port returns 200 with a matching sessionId (REQ-018). */
async function probeLive(rec: { sessionId?: string; port?: number }): Promise<boolean> {
  if (typeof rec.port !== "number" || typeof rec.sessionId !== "string") return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300);
  try {
    const res = await fetch(`http://127.0.0.1:${rec.port}/healthz`, { signal: ctrl.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { sessionId?: string };
    return body.sessionId === rec.sessionId;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function usage(): void {
  process.stdout.write(
    "clide <command>\n" +
      "  tui                          live terminal view of the current session\n" +
      "  aggregate                    read-only overview of all live sessions\n" +
      "  install --provider <claude|codex> [--uninstall]   register capture hooks\n" +
      "  watch                        no-hooks tailer/bootstrap (Codex fallback)\n" +
      "  doctor --clean               remove stale discovery files + logs\n",
  );
}

function spawnBin(bin: string, args: string[]): void {
  const child = spawn(bin, args, { stdio: "inherit" });
  child.on("error", () => { process.stderr.write(`clide: '${bin}' not found on PATH\n`); process.exit(1); });
  child.on("exit", (code) => process.exit(code ?? 0));
}

/** REQ-094: probe each discovery file's relay; remove the stale ones + their logs. */
async function doctorClean(): Promise<void> {
  let recs: Array<{ rec: { sessionId?: string; port?: number } }> = [];
  try {
    recs = readdirSync(SESSIONS)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ rec: JSON.parse(readFileSync(join(SESSIONS, f), "utf8")) as { sessionId?: string; port?: number } }));
  } catch { /* no sessions dir */ }

  const liveIds = new Set<string>();
  for (const { rec } of recs) { if (rec.sessionId && (await probeLive(rec))) liveIds.add(rec.sessionId); }

  const removed = cleanStale(SESSIONS, (rec) => typeof rec.sessionId === "string" && liveIds.has(rec.sessionId));
  for (const p of removed) {
    const name = p.split("/").pop()?.replace(/\.json$/, "");
    if (name) { try { rmSync(join(LOGS, `${name}.log`), { force: true }); } catch { /* ignore */ } }
  }
  process.stdout.write(`clide doctor: removed ${removed.length} stale session file(s)\n`);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgv(process.argv.slice(2));
  switch (command) {
    case "tui": return spawnBin("clide-tui", []);
    case "aggregate": return spawnBin("clide-aggregate", []);
    case "doctor": {
      if (flags.clean) { await doctorClean(); return; }
      usage();
      return;
    }
    case "install":
      process.stdout.write(
        "clide install: register the provider's capture hooks.\n" +
          "  Claude Code — install the `clide` plugin (auto-registers via hooks.json).\n" +
          "  Codex       — writes a managed block to ~/.codex/config.toml. See adapters/codex/README.\n",
      );
      return;
    case "watch":
      process.stdout.write("clide watch: launches the no-hooks tailer/bootstrap (Codex fallback). See adapters/codex/README.\n");
      return;
    default:
      usage();
  }
}

void main();
/* c8 ignore stop */
