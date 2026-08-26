/**
 * INS-04 — put `ASTIR_TOKEN` where Claude Code will actually read it.
 *
 * The hooks are `type: "http"`: Claude Code POSTs to the daemon from its own
 * process, so no astir code runs at hook time and there is nothing to open
 * `~/.astir/token`. An http hook header can be filled from exactly one source —
 * an environment variable named in `allowedEnvVars` — so the token has to reach
 * Claude Code's environment or the hooks send `Bearer ` and every event is
 * rejected with a 401.
 *
 * INS-03 originally left that to the user as an `export` line for their shell
 * profile, on the principle that astir must not edit someone's dotfiles. That
 * principle stands and this module does not touch a dotfile. But the profile was
 * the wrong destination twice over:
 *
 *   - It is silent when skipped. `astir install` printed a line, nothing
 *     verified it, and the first symptom was a wall of hook errors with the
 *     cause several layers away.
 *   - It does not even work in general. A shell profile is sourced by
 *     interactive shells; Claude Code launched from the desktop app or an IDE
 *     extension never reads it, so the instruction silently does nothing for
 *     everyone not starting from a terminal.
 *
 * `settings.json` has neither problem, and is not a new intrusion: `astir
 * install` already rewrites that exact file through `claude plugin install`
 * (INS-02), which adds `enabledPlugins` and `extraKnownMarketplaces` to it.
 * Writing one more key into a file we already cause to be written is the same
 * category of change, minus the CLI verb to do it for us.
 *
 * The cost is that a 0600 secret comes to rest in a file that is conventionally
 * 0644, so `installToken` re-writes it 0600 (see `writeSecret`). That narrows
 * access to the owner, which is who Claude Code runs as anyway.
 */

import { chmodSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeSecret } from "../config/paths.js";

/**
 * Claude Code reads its settings from `$CLAUDE_CONFIG_DIR`, falling back to
 * `~/.claude` — the same resolution its own generated `statusLine` commands use
 * (`"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"`). Honouring it matters: writing to
 * `~/.claude` while Claude Code reads somewhere else would produce a token that
 * looks installed and is never loaded, which is the failure this replaces.
 */
export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  const dir = configured !== undefined && configured.length > 0 ? configured : join(home, ".claude");
  return join(dir, "settings.json");
}

export type Settings = Record<string, unknown>;

export type ParseResult = { ok: true; settings: Settings; existed: boolean } | { ok: false; reason: string };

/**
 * Parse, refusing anything we cannot safely round-trip.
 *
 * A malformed `settings.json` silently disables *every* setting in it, so the
 * one unacceptable outcome is overwriting a file the user is mid-edit on, or
 * one holding config we failed to understand. Absent is fine — that is a fresh
 * install. Unparseable is not, and is reported rather than replaced.
 */
export function parseSettings(raw: string | null): ParseResult {
  if (raw === null) return { ok: true, settings: {}, existed: false };
  if (raw.trim().length === 0) return { ok: true, settings: {}, existed: true };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `it is not valid JSON (${(err as Error).message})` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "its top level is not a JSON object" };
  }

  const env = (parsed as Settings).env;
  if (env !== undefined && (typeof env !== "object" || env === null || Array.isArray(env))) {
    return { ok: false, reason: 'its "env" key is not a JSON object' };
  }
  return { ok: true, settings: parsed as Settings, existed: true };
}

export type TokenState =
  | { kind: "current" }
  | { kind: "absent" }
  /** Present but not the token the daemon is using — usually a regenerated token file. */
  | { kind: "stale"; existing: string };

export function tokenState(settings: Settings, token: string): TokenState {
  const env = settings.env as Record<string, unknown> | undefined;
  const existing = env?.ASTIR_TOKEN;
  if (typeof existing !== "string" || existing.length === 0) return { kind: "absent" };
  return existing === token ? { kind: "current" } : { kind: "stale", existing };
}

/**
 * Merge, never replace. Spreading an existing key leaves it in place, so `env`
 * keeps its position and its other variables, and every unrelated setting —
 * `enabledPlugins`, `permissions`, whatever an admin put there — survives
 * untouched.
 */
export function withToken(settings: Settings, token: string): Settings {
  const env = (settings.env ?? {}) as Record<string, unknown>;
  return { ...settings, env: { ...env, ASTIR_TOKEN: token } };
}

/** Two-space JSON with a trailing newline — what Claude Code itself writes. */
export function serializeSettings(settings: Settings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * `httpHookAllowedEnvVars` intersects with each hook's own `allowedEnvVars`, so
 * a machine that sets it without naming `ASTIR_TOKEN` filters our header back to
 * empty no matter how correctly the variable is installed. Rare, but it fails
 * exactly like a missing token while looking perfectly configured — so it is
 * worth naming rather than leaving someone to find it.
 */
export function tokenIsFilteredOut(settings: Settings): boolean {
  const allowed = settings.httpHookAllowedEnvVars;
  if (!Array.isArray(allowed)) return false;
  return !allowed.includes("ASTIR_TOKEN");
}

export interface SettingsDeps {
  path: () => string;
  read: (path: string) => string | null;
  write: (path: string, contents: string) => void;
  /** Re-assert the mode without rewriting the contents. */
  harden: (path: string) => void;
}

export function defaultSettingsDeps(): SettingsDeps {
  return {
    path: () => claudeSettingsPath(),
    read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
    // 0600: this file now holds a bearer token. Same atomic temp-then-rename as
    // the token file, which also means a watcher never observes a partial write.
    write: (path, contents) => writeSecret(path, contents, { requireDir: true }),
    harden: (path) => chmodSync(path, 0o600),
  };
}

export interface InstallTokenResult {
  ok: boolean;
  outcome: "written" | "updated" | "already-current" | "refused";
  detail: string;
  path: string;
}

export function installToken(token: string, deps: SettingsDeps = defaultSettingsDeps()): InstallTokenResult {
  const path = deps.path();
  const parsed = parseSettings(deps.read(path));

  if (!parsed.ok) {
    return {
      ok: false,
      outcome: "refused",
      path,
      detail:
        `left ${path} alone because ${parsed.reason}.\n` +
        "    Fix or move that file and re-run `astir install` — overwriting it would\n" +
        "    silently discard every setting it contains.",
    };
  }

  const state = tokenState(parsed.settings, token);
  if (state.kind === "current") {
    // Same reasoning as DMN-07's chmod on an existing token file: the value
    // being right says nothing about the mode being right. A file written by an
    // earlier astir, by Claude Code itself, or restored from a backup holds the
    // token at whatever the umask gave it — 0644 on a normal machine. Nothing is
    // rewritten here, so re-asserting the mode is the only chance to fix it.
    deps.harden(path);
    return { ok: true, outcome: "already-current", path, detail: `already set in ${path}` };
  }

  deps.write(path, serializeSettings(withToken(parsed.settings, token)));

  return state.kind === "stale"
    ? { ok: true, outcome: "updated", path, detail: `updated in ${path} (it held an older token)` }
    : {
        ok: true,
        outcome: "written",
        path,
        detail: parsed.existed ? `added to ${path}` : `created ${path} with it`,
      };
}
