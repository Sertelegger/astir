/**
 * Which astir plugin is actually installed — and there is rarely just one.
 *
 * The daemon runs from wherever `astir` was built; the HOOKS run from a cached
 * copy of the plugin, and the two move independently. Bumping
 * `marketplace.json` tells Claude Code a newer version exists, it does not
 * install it — so a release can be cut, tagged and published while every
 * session on the machine still posts through the previous one's hooks.
 *
 * Measured on the author's own machine while writing this, after a release and
 * a plugin update that looked like it had worked:
 *
 *   ~/.claude-nv  user     0.2.0
 *   ~/.claude-nv  project  0.1.0
 *   ~/.claude     user     0.1.0
 *
 * **One of three.** So this deliberately returns every entry rather than "the"
 * installed version: a function answering with one of those would be wrong two
 * thirds of the time, and confidently.
 *
 * Nothing here throws. A missing file means the plugin was installed some other
 * way, which is allowed — `astir install --no-plugin` exists — and a diagnosis
 * that crashes on an unusual setup is worse than one that says less.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { candidateConfigDirs } from "../discovery/profiles.js";

export interface InstalledPlugin {
  /** The config directory it was found in, e.g. `/home/dev/.claude-nv`. */
  profile: string;
  /** `user` or `project` — they are separate installs and drift separately. */
  scope: string;
  version: string | null;
  /** Null when the entry names no path, which an older writer may not have. */
  installPath: string | null;
  /** The entry points at a cache directory that is no longer there. */
  dangling: boolean;
}

interface Entry {
  scope?: unknown;
  version?: unknown;
  installPath?: unknown;
}

/**
 * Every astir plugin install this machine knows about, in profile order.
 *
 * Matched on the plugin NAME rather than the full `astir@astir-marketplace`
 * key, so a marketplace added under a different name — a fork, a local
 * checkout, a rename — is still recognised as astir rather than silently
 * reported as "not installed".
 */
export function installedPlugins(
  dirs: string[] = candidateConfigDirs(),
  exists: (p: string) => boolean = existsSync,
): InstalledPlugin[] {
  const found: InstalledPlugin[] = [];

  for (const dir of dirs) {
    const file = join(dir, "plugins", "installed_plugins.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // Absent, unreadable or not JSON. All three mean the same thing here —
      // nothing to report for this profile — and none is astir's business.
      continue;
    }

    const plugins = (parsed as { plugins?: unknown })?.plugins;
    if (typeof plugins !== "object" || plugins === null) continue;

    for (const [key, value] of Object.entries(plugins as Record<string, unknown>)) {
      if (key !== "astir" && !key.startsWith("astir@")) continue;
      // One key holds an array: the same plugin installed at several scopes.
      for (const entry of Array.isArray(value) ? value : [value]) {
        const e = (entry ?? {}) as Entry;
        const installPath = typeof e.installPath === "string" ? e.installPath : null;
        found.push({
          profile: dir,
          scope: typeof e.scope === "string" ? e.scope : "unknown",
          version: typeof e.version === "string" ? e.version : null,
          installPath,
          // Reported rather than skipped: an entry pointing at a directory that
          // has been cleaned away still counts as an install Claude Code will
          // try to load, and the failure is more confusing than a stale one.
          dangling: installPath !== null && !exists(installPath),
        });
      }
    }
  }
  return found;
}

/**
 * How an installed version compares to the one running.
 *
 * String equality, not semver ordering. The question is "are these the same
 * build", and the answer to anything else is "they differ, look at it" — which
 * ordering would not improve. It also cannot be fooled by a prerelease suffix
 * or a version this comparison has never seen.
 */
export function pluginDrift(
  installed: InstalledPlugin[],
  running: string,
): { stale: InstalledPlugin[]; matching: InstalledPlugin[] } {
  const stale: InstalledPlugin[] = [];
  const matching: InstalledPlugin[] = [];
  for (const p of installed) {
    if (p.version === running && !p.dangling) matching.push(p);
    else stale.push(p);
  }
  return { stale, matching };
}

/**
 * The `plugin` rows of `astir doctor`, as lines.
 *
 * A pure function for the same reason `renderMenubar` is one: `runDoctor` talks
 * to the filesystem, the network and a daemon, so anything left inline in it is
 * effectively untestable — and this is the part with judgement in it. Which
 * install counts as current, and what a user is told to do about the rest, are
 * decisions worth pinning.
 *
 * Padding is computed rather than spelled in spaces: every row after the first
 * is a continuation, and hand-counted alignment is how the first version of
 * this landed a column left of every other line in the report.
 */
export function describePlugins(installed: InstalledPlugin[], running: string): string[] {
  const pad = (first: boolean) => `  ${(first ? "plugin" : "").padEnd(16)}`;

  // Not a fault. `astir install --no-plugin` is supported and so is wiring the
  // hooks by hand, so this states the situation without grading it.
  if (installed.length === 0) {
    return [`${pad(true)}not installed as a plugin — hooks must be wired another way`];
  }

  const lines = installed.map((p, i) => {
    const where = `${p.scope}, ${basename(p.profile)}`;
    if (p.dangling) {
      return `${pad(i === 0)}${p.version ?? "?"} (${where}) — MISSING from disk: ${p.installPath}`;
    }
    if (p.version === running) return `${pad(i === 0)}${p.version} (${where}) — current`;
    return `${pad(i === 0)}${p.version ?? "unknown"} (${where}) — this CLI is ${running}`;
  });

  // Named individually above rather than summarised, because they are separate
  // installs that drift separately: updating one and believing it done is the
  // failure that produced this check, and a lone "out of date" line would look
  // satisfied by exactly that.
  if (pluginDrift(installed, running).stale.length > 0) {
    lines.push(`${pad(false)}\`claude plugin update astir@astir-marketplace\` — per profile`);
  }
  return lines;
}

/**
 * Is the daemon answering on this port running the build that is on disk?
 *
 * Pure, and separate from the probe that fetches it, for the reason
 * `describePlugins` is: the judgement is worth pinning and `runDoctor` cannot
 * be tested. Returns null when there is nothing worth saying, so doctor's
 * output does not grow a line that is always there and never interesting.
 *
 * The failure this catches is specific and was expensive: a daemon of the SAME
 * version, on the right host, holding the port since before the last build —
 * so every identity check passes and every measurement is against stale code.
 */
export function describeDaemonBuild(
  daemon: { startedAt: number | null; build: string | null },
  onDisk: string,
): string | null {
  const pad = `  ${"".padEnd(16)}`;
  if (daemon.build === null) {
    // Older than the field. Worth one line, because "I cannot tell" is the
    // honest answer and this is the daemon most likely to be the stale one.
    return `${pad}its build is unknown — too old to say, so restart it before trusting what it reports`;
  }
  if (daemon.build === onDisk) return null;

  const age =
    daemon.startedAt === null
      ? ""
      : ` — running since ${new Date(daemon.startedAt).toISOString().replace("T", " ").slice(0, 16)}`;
  return `${pad}STALE: built ${daemon.build.replace("T", " ").slice(0, 16)}, on disk ${onDisk
    .replace("T", " ")
    .slice(0, 16)}${age}. A restart that failed to bind leaves the old one serving.`;
}

/**
 * The notifier's half of the report, as lines.
 *
 * `doctor` said nothing about the notifier at all — the only mention inside
 * `runDoctor` was the `--notify` test, which SENDS a notification rather than
 * reporting whether anything is there to receive one. So a machine whose entire
 * cross-machine path was dead produced six lines, all of them healthy, none of
 * them about the thing that was broken.
 *
 * Pure for the reason `describePlugins` is: `runDoctor` does I/O and cannot be
 * tested, and what counts as a healthy notifier is a judgement worth pinning.
 */
export function describeNotifier(
  probe: { found: boolean; reason?: string | undefined },
  supervised: boolean,
  rosters: number | null,
): string[] {
  const pad = `  ${"".padEnd(16)}`;
  const lines: string[] = [];

  if (!probe.found) {
    // The failure that cost hours: `detect.ts` refuses a peer that does not
    // report `role: "notifier"`, correctly, and then nobody says so. "No
    // tunnel" and "something else is on that port" need different fixes and
    // must not read the same.
    lines.push(`  ${"notifier".padEnd(16)}none — remote machines cannot reach you`);
    if (probe.reason !== undefined) lines.push(`${pad}${probe.reason}`);
    lines.push(`${pad}\`astir notifier\` starts one; \`astir pair <host>\` connects a machine to it`);
    return lines;
  }

  lines.push(`  ${"notifier".padEnd(16)}running`);
  // Running and never contacted is a DIFFERENT failure from not running, and
  // the two need different fixes — one is a process, the other is a tunnel.
  if (rosters === 0) {
    lines.push(`${pad}no machine has pushed a roster yet — is the tunnel up?`);
  } else if (rosters !== null) {
    lines.push(`${pad}${rosters} roster(s) received`);
  }
  if (!supervised) {
    // #69 — nothing restarts it, so this comes back at every reboot.
    lines.push(`${pad}not supervised — it will not survive a reboot; \`astir autostart\` fixes that`);
  }
  return lines;
}

/**
 * The watched hosts, and whether polling them achieves anything.
 *
 * `~/.astir/hosts` drives DMN-09's SSH poll and no surface mentioned it. A host
 * returning nothing for a week looked exactly like a host never added — which
 * matters because that poll is the FALLBACK for when a machine's daemon is
 * down, so its silence is the case it exists to cover.
 */
export function describeHosts(hosts: readonly string[], reporting: ReadonlySet<string>): string[] {
  if (hosts.length === 0) return [];
  const pad = `  ${"".padEnd(16)}`;
  const lines = [`  ${"watching".padEnd(16)}${hosts.length} host(s) polled over ssh`];
  for (const h of hosts) {
    lines.push(
      reporting.has(h)
        ? `${pad}${h} — reporting`
        : `${pad}${h} — nothing returned, which is not the same as nothing running`,
    );
  }
  return lines;
}
