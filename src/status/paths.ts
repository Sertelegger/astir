/**
 * VIEW-05 — turning a tile back into something a human can act on.
 *
 * The spec's first clause is "clicking a file MUST request the host open it",
 * which belongs to a host that owns an editor — the VSCode webview. `astir
 * view` opens an ordinary browser tab, so the clause that applies here is the
 * second one: copy the path and confirm.
 *
 * Absolute, not repo-relative. The map shows relative paths because that is
 * what makes it readable, but a relative path pasted into a terminal or an
 * editor's open dialog resolves against whatever directory that happens to be
 * in — which is the one thing it must not do when the whole point is to reach a
 * file in a repo the user may not be sitting in.
 */

/**
 * Join a session's `cwd` to a repo-relative path.
 *
 * Node's `join` is deliberately not used: this runs in the browser, and the
 * separator that matters belongs to the machine the SESSION is on, not the one
 * rendering the page. A macOS daemon viewed from a Windows browser must still
 * produce a POSIX path, so the separator is read off `cwd` rather than assumed.
 */
export function absolutePathOf(cwd: string, relative: string): string {
  if (cwd === "") return relative;
  // A drive letter or a UNC prefix is the only reliable signal, since a Windows
  // cwd may legitimately contain forward slashes while a POSIX one can never
  // contain a backslash as a separator.
  const windows = /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\");
  const sep = windows ? "\\" : "/";
  const base = cwd.endsWith("/") || cwd.endsWith("\\") ? cwd.slice(0, -1) : cwd;
  const tail = windows ? relative.replace(/\//g, "\\") : relative;
  return `${base}${sep}${tail}`;
}
