/**
 * Which directories a session should watch for shell-driven writes.
 *
 * CAP-06's `FileChanged` hook is how work that never touches a file-writing
 * TOOL becomes visible at all. `classifyTool` reads paths from exactly three
 * keys of `tool_input` — `file_path`, `notebook_path`, `path` — and Bash's
 * input is `{command, description}`, so a `sed -i`, a formatter, a build step
 * or a `git checkout` contributes nothing to the map. Measured over every
 * transcript on this machine: 56,190 Bash calls against 1,217 path-bearing edit
 * calls, of which ~5,500 Bash calls carry a write-capable construct. Astir sees
 * roughly a fifth of plausibly file-mutating work.
 *
 * ## Why this function exists at all
 *
 * The watcher is built with **no `ignored` option**, so a directory handed to
 * it is followed recursively with nothing excluded. There is no filter to pass
 * and no pattern to set: the only control astir has is WHICH PATHS IT HANDS
 * OVER. Handing over the repo root is therefore not a simpler version of this —
 * it is a different and much worse feature. Astir's own checkout is 966
 * directories and 5,641 files, of which 141 are not `node_modules`, `.git` or
 * `dist`; one `npm install` under that arrangement would fire thousands of
 * hook POSTs at a daemon whose per-hook timeout is five seconds.
 *
 * So: the immediate children of the working directory, minus the ones that are
 * generated, vendored or version-control internals. A denylist rather than an
 * allowlist because the set of things that are NOT source is small, stable and
 * nameable across ecosystems, while the set of things that are varies per
 * project and per language.
 */

/**
 * Directories whose contents are never a person's work in progress.
 *
 * Deliberately conservative — every entry here is generated, vendored, or
 * version-control internals in every ecosystem that uses the name. A directory
 * wrongly excluded costs some map coverage; a directory wrongly INCLUDED costs
 * a hook storm, so the asymmetry favours leaving names off this list only when
 * they are genuinely ambiguous.
 */
const NEVER_WATCH = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".gradle",
  ".idea",
  ".vscode",
  ".astir",
]);

/**
 * How many directories a session may hand over.
 *
 * A monorepo with ninety packages would otherwise watch ninety trees, and the
 * cost is paid by the editor's process rather than astir's. Truncation is
 * silent to the hook but NOT silent in the log — see the caller — because a map
 * that is quietly partial is the failure this project exists downstream of.
 */
export const MAX_WATCH_PATHS = 24;

export interface WatchEntry {
  name: string;
  isDirectory: boolean;
}

/**
 * Absolute paths to hand to the watcher, and whether the list was truncated.
 *
 * Returns directories only. A top-level FILE is not watched: handing over a
 * single file costs a watcher for one path and the files that matter at a
 * repository root — `package.json`, a lockfile, a config — are edited through
 * tools, which astir already sees.
 */
export function watchPathsFor(
  cwd: string,
  entries: readonly WatchEntry[],
  join: (a: string, b: string) => string,
): { paths: string[]; truncated: number } {
  const wanted = entries
    .filter((e) => e.isDirectory && !NEVER_WATCH.has(e.name))
    // Dotfile directories beyond the named ones: tool state, caches and editor
    // scratch. `.github` is the notable exception and is worth watching — a
    // workflow edited by a script is real work — so it is named rather than
    // swept up by the dot rule.
    .filter((e) => !e.name.startsWith(".") || e.name === ".github")
    .map((e) => e.name)
    .sort();

  return {
    paths: wanted.slice(0, MAX_WATCH_PATHS).map((n) => join(cwd, n)),
    truncated: Math.max(0, wanted.length - MAX_WATCH_PATHS),
  };
}
