import { describe, it, expect } from "vitest";
import { resolve, join, sep } from "node:path";
import { contentTypeFor, resolveStaticPath } from "../src/relay/static-files.js";

const ROOT = resolve("/tmp/clide-web-root");

describe("resolveStaticPath", () => {
  it("maps / and the empty path to index.html inside the root", () => {
    expect(resolveStaticPath(ROOT, "/")).toBe(join(ROOT, "index.html"));
    expect(resolveStaticPath(ROOT, "")).toBe(join(ROOT, "index.html"));
  });
  it("resolves a nested asset inside the root", () => {
    const p = resolveStaticPath(ROOT, "/assets/app.js");
    expect(p).toBe(join(ROOT, "assets", "app.js"));
    expect(p!.startsWith(ROOT + sep)).toBe(true);
  });
  it("strips a query string before resolving", () => {
    expect(resolveStaticPath(ROOT, "/?token=abc&session=s1")).toBe(join(ROOT, "index.html"));
    expect(resolveStaticPath(ROOT, "/assets/app.js?v=2")).toBe(join(ROOT, "assets", "app.js"));
  });
  it("rejects path traversal (plain and percent-encoded)", () => {
    expect(resolveStaticPath(ROOT, "/../secret")).toBeNull();
    expect(resolveStaticPath(ROOT, "/..%2Fsecret")).toBeNull();
    expect(resolveStaticPath(ROOT, "/assets/../../secret")).toBeNull();
    expect(resolveStaticPath(ROOT, "/../../../../etc/passwd")).toBeNull();
  });
  it("does not escape via a sibling directory with the root as a prefix", () => {
    expect(resolveStaticPath(ROOT, "/../clide-web-root-evil/x")).toBeNull();
  });
  it("returns null instead of throwing on a malformed percent escape", () => {
    expect(resolveStaticPath(ROOT, "/%zz")).toBeNull();
  });
});

describe("contentTypeFor", () => {
  it("maps known extensions", () => {
    expect(contentTypeFor("/x/index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("/x/app.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("/x/app.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("/x/data.json")).toBe("application/json; charset=utf-8");
    expect(contentTypeFor("/x/icon.SVG")).toBe("image/svg+xml"); // case-insensitive
  });
  it("falls back to application/octet-stream for unknown extensions", () => {
    expect(contentTypeFor("/x/thing.xyz")).toBe("application/octet-stream");
    expect(contentTypeFor("/x/noext")).toBe("application/octet-stream");
  });
});
