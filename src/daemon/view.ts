/**
 * VIEW-03 — serving the view itself, from the daemon that has the data.
 *
 * A separate static server would be a second process to start, supervise and
 * explain, for files that only make sense next to the daemon's own routes. It
 * also means the view is reachable exactly when there is something to view.
 *
 * ## Why these files are NOT token-gated
 *
 * A browser cannot attach an `Authorization` header to a top-level navigation,
 * so a token-gated page could never be opened by typing its address — the whole
 * point of a local view. What is served here is an empty shell: markup, script
 * and stylesheet, containing no session data whatsoever. Every route that
 * carries data stays gated.
 *
 * The token reaches the page through the URL *fragment* (`/view#<token>`), which
 * browsers do not transmit to the server: it never appears in a request line, an
 * access log or a proxy trace. The script reads it from `location.hash` and
 * attaches it to the `fetch` that opens the stream.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `dist/view`, resolved relative to the compiled daemon rather than to the
 * process's cwd — the daemon is started by launchd, by a hook and by hand, and
 * those have three different working directories.
 */
export function viewRootFor(moduleUrl: string): string {
  return join(dirname(fileURLToPath(moduleUrl)), "..", "view");
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot === -1 ? undefined : TYPES[path.slice(dot)]) ?? "application/octet-stream";
}

/**
 * Resolve a request path to a file inside `root`, or `null`.
 *
 * Pure and exported so the traversal guard is tested directly rather than
 * inferred from a 404. Containment is checked on the RESOLVED path, because
 * `..` segments survive every amount of decoding and string inspection but
 * cannot survive resolution.
 */
export function resolveAsset(root: string, requestPath: string): string | null {
  const rel = requestPath.replace(/^\/view\/?/, "");
  const wanted = rel === "" ? "index.html" : rel;
  // A NUL truncates a path in some syscalls; reject rather than normalise.
  if (wanted.includes("\0")) return null;

  const full = resolve(root, normalize(wanted));
  const base = resolve(root);
  if (full !== base && !full.startsWith(base + sep)) return null;
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  return full;
}

/**
 * Send a view asset, or return false so the caller can 404 in its own voice.
 *
 * The CSP is deliberately tight. The token lives in this page's `location.hash`
 * while it runs, so the realistic risk is not someone reading these static files
 * but a bug in them turning into an exfiltration route. `connect-src 'self'`
 * means the only place the page can send anything is back to the daemon.
 */
export function serveAsset(root: string, requestPath: string, res: ServerResponse): boolean {
  const file = resolveAsset(root, requestPath);
  if (file === null) return false;

  res.writeHead(200, {
    "content-type": contentType(file),
    "x-content-type-options": "nosniff",
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    // The view is rebuilt with a new hash per release and served from loopback;
    // caching it only makes a stale shell survive an upgrade.
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(res);
  return true;
}
