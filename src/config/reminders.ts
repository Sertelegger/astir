/**
 * PSH-02 (#98) — which reminder schedule a blocked agent gets, and where that
 * choice came from.
 *
 * The setting is `notify.reminders` in `~/.astir/config.json`, a nested key:
 *
 *     { "notify": { "reminders": "off" | "calm" | "insistent" } }
 *
 * `ASTIR_REMINDERS` overrides the file, for tests and for a daemon started by
 * hand. An unknown value runs `calm`, and says which value it refused so that
 * `astir doctor` can name it.
 *
 * Deliberately small and read-only. The file is shared: the ADE plan's
 * `src/config/astir-config.ts` will read it whole (`v`, `hub`, `spaces`) and
 * absorb this key, so this module reads one key, ignores every other, never
 * writes, and never throws on any shape of file.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { DEFAULT_REMINDERS, isReminderSchedule, type ReminderSchedule } from "../notify/policy.js";
import { configPath } from "./paths.js";

export const REMINDERS_ENV = "ASTIR_REMINDERS";

/** Where the schedule in force came from. */
export type ReminderSource = "default" | "config" | "env";

export interface RemindersSetting {
  schedule: ReminderSchedule;
  source: ReminderSource;
  /** The value that was not a schedule, as written, when `schedule` is the fallback for it. */
  rejected?: string;
  /** Why the config file could not be read, when it exists and could not be. */
  problem?: string;
}

/**
 * What the daemon says on `/healthz`: names only, like `delivery`, since that
 * route answers without a token. Not the refused value itself, which is
 * whatever someone typed; doctor reads that from its own copy of the file.
 */
export interface RemindersReport {
  schedule: ReminderSchedule;
  source: ReminderSource;
  /** The configured value was not a schedule, so this is `calm` in its place. */
  fellBack?: true;
}

export function reportReminders(setting: RemindersSetting): RemindersReport {
  return {
    schedule: setting.schedule,
    source: setting.source,
    ...(setting.rejected !== undefined ? { fellBack: true as const } : {}),
  };
}

type FileRead =
  | { state: "absent" }
  | { state: "unreadable"; reason: string }
  | { state: "ok"; json: unknown };

function readConfigFile(path: string): FileRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return { state: "absent" };
    return { state: "unreadable", reason: `${path} cannot be read (${code ?? "unknown error"})` };
  }
  try {
    return { state: "ok", json: JSON.parse(text) };
  } catch {
    return { state: "unreadable", reason: `${path} is not valid JSON` };
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** As written, for doctor: a string as itself, anything else as its JSON. */
const asWritten = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

function resolve(envValue: string | undefined, file: FileRead): RemindersSetting {
  // Empty is unset, as `ASTIR_REMINDERS=` in a shell means. An unknown value
  // is refused for `calm`, not for whatever the file says: the variable was
  // meant to win, and a typo in it must not quietly hand the choice back.
  if (envValue !== undefined && envValue !== "") {
    return isReminderSchedule(envValue)
      ? { schedule: envValue, source: "env" }
      : { schedule: DEFAULT_REMINDERS, source: "env", rejected: envValue };
  }
  if (file.state === "unreadable")
    return { schedule: DEFAULT_REMINDERS, source: "default", problem: file.reason };
  const notify = file.state === "ok" && isObject(file.json) ? file.json.notify : undefined;
  const value = isObject(notify) ? notify.reminders : undefined;
  if (value === undefined) return { schedule: DEFAULT_REMINDERS, source: "default" };
  return isReminderSchedule(value)
    ? { schedule: value, source: "config" }
    : { schedule: DEFAULT_REMINDERS, source: "config", rejected: asWritten(value) };
}

export interface RemindersOpts {
  home?: string;
  env?: Record<string, string | undefined>;
}

/** The schedule in force now, read once. */
export function readReminders(opts: RemindersOpts = {}): RemindersSetting {
  const env = opts.env ?? process.env;
  return resolve(env[REMINDERS_ENV], readConfigFile(configPath(opts.home ?? homedir())));
}

/** What identifies one version of the file: absent, or its mtime and size. */
function fileStamp(path: string): string {
  try {
    const st = statSync(path);
    // Size too: a read that landed between a truncate and the write after it
    // may share the finished file's mtime on a coarse clock, never its size.
    return `${st.mtimeMs}:${st.size}`;
  } catch (error) {
    return `none:${(error as { code?: string }).code ?? "?"}`;
  }
}

/**
 * The schedule in force, kept current for a running daemon: a getter that
 * stats the file at most every `everyMs` (5 s) and re-reads it when its mtime
 * changes, so an edit applies without a restart. The first call reads.
 */
export function remindersSource(
  opts: RemindersOpts & { now?: () => number; everyMs?: number } = {},
): () => RemindersSetting {
  const env = opts.env ?? process.env;
  const path = configPath(opts.home ?? homedir());
  const now = opts.now ?? (() => Date.now());
  const everyMs = opts.everyMs ?? 5_000;
  let checkedAt: number | null = null;
  let stamp: string | null = null;
  let file: FileRead = { state: "absent" };
  let current: RemindersSetting | null = null;

  return () => {
    const t = now();
    if (current !== null && checkedAt !== null && t - checkedAt < everyMs) return current;
    checkedAt = t;
    const next = fileStamp(path);
    if (next !== stamp) {
      stamp = next;
      file = readConfigFile(path);
    }
    current = resolve(env[REMINDERS_ENV], file);
    return current;
  };
}
