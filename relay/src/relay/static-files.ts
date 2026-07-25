import { extname, join, normalize, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".map": "application/json; charset=utf-8",
  ".ico": "image/x-icon", ".png": "image/png", ".woff2": "font/woff2",
};

export function contentTypeFor(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Resolve a URL path to a file inside `rootDir`, or null if it escapes the root.
 * "/" maps to index.html. Query strings are stripped. Never throws.
 */
export function resolveStaticPath(rootDir: string, urlPath: string): string | null {
  let rel: string;
  try { rel = decodeURIComponent(urlPath.split("?")[0] ?? "/"); } catch { return null; } // malformed escape (e.g. %zz)
  const wanted = rel === "/" || rel === "" ? "index.html" : rel.replace(/^\/+/, "");
  const root = resolve(rootDir);
  const abs = resolve(join(root, normalize(wanted)));
  if (abs !== root && !abs.startsWith(root + sep)) return null; // traversal guard
  return abs;
}
