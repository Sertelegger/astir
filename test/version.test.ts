import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  execFileSync("node", ["-p", "JSON.stringify(require('./package.json'))"], {
    cwd: root,
    encoding: "utf8",
  }),
) as { version: string };

describe("every version stamp moves together", () => {
  // There are four, and the fourth is why this test exists: a
  // `<bitbar.version>` comment in a shell script, which no JSON tooling would
  // find and an audit reading carefully still missed. Three agreeing while the
  // fourth lags is a state nothing else detects — SwiftBar would go on
  // reporting the old version indefinitely.
  const json = [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"];

  for (const file of json) {
    it(`${file} matches package.json`, async () => {
      const { readFileSync } = await import("node:fs");
      expect(readFileSync(join(root, file), "utf8")).toContain(`"version": "${manifest.version}"`);
    });
  }

  it("the SwiftBar plugin header matches package.json", async () => {
    // Plain containment rather than a regex built from the version. Escaping
    // only dots is incomplete sanitisation — correct here because the input is
    // a semver from our own manifest, and wrong as a habit.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(join(root, "contrib/swiftbar/astir.3s.sh"), "utf8");
    const tag = `<bitbar.version>`;
    expect(src.includes(`${tag}${manifest.version}<`) || src.includes(`${tag}v${manifest.version}<`)).toBe(
      true,
    );
  });

  it("the changelog has a section for this version", async () => {
    // A release whose notes were never written is the other half of the same
    // failure: the workflow refuses to publish, but only after the tag is
    // pushed. Catching it here costs nothing.
    const { readFileSync } = await import("node:fs");
    const log = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const heading = `## [${manifest.version}]`;
    expect(log.split("\n").some((line) => line.startsWith(heading))).toBe(true);
  });

  it("every changelog version has a link definition", async () => {
    // A missing one renders with visible brackets, which is how holdfast
    // shipped two releases before anyone noticed.
    const { readFileSync } = await import("node:fs");
    const log = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const headings = [...log.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]);
    const defined = new Set([...log.matchAll(/^\[([^\]]+)\]:/gm)].map((m) => m[1]));
    for (const h of headings) expect(defined.has(h), `no link definition for [${h}]`).toBe(true);
  });

  it("`astir --version` reports the manifest version", () => {
    // `astir pair` runs this on a remote to decide whether astir is installed.
    // Before it existed the flag fell through to usage(), which exits 0 — so
    // the check passed on any astir at all and its `|| echo MISSING` could
    // never fire.
    const dist = join(root, "dist/cli/main.js");
    if (!existsSync(dist)) return; // built artifact only; the artifact suite builds it
    const out = execFileSync("node", [dist, "--version"], { encoding: "utf8" });
    expect(out.trim()).toBe(`astir ${manifest.version}`);
  });
});
