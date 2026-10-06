import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/** Every file `scripts/bump-version.mjs` stamps, as the repository holds it. */
const STAMPED = [
  "package.json",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".codex-plugin/plugin.json",
  "tui/.claude-plugin/plugin.json",
  "contrib/swiftbar/astir.3s.sh",
];

interface Marketplace {
  plugins: { name: string; source: string; version: string }[];
}

describe("every version stamp moves together", () => {
  // There are seven, and the SwiftBar one is why this test exists: a
  // `<bitbar.version>` comment in a shell script, which no JSON tooling would
  // find and an audit reading carefully still missed. Six agreeing while one
  // lags is a state nothing else detects — SwiftBar would go on reporting the
  // old version indefinitely.
  const json = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "tui/.claude-plugin/plugin.json"];

  for (const file of json) {
    it(`${file} matches package.json`, async () => {
      const { readFileSync } = await import("node:fs");
      expect(readFileSync(join(root, file), "utf8")).toContain(`"version": "${manifest.version}"`);
    });
  }

  it("every marketplace entry matches package.json, astir-tui's included", () => {
    // Read per entry, not by containment: with two entries, one matching would
    // satisfy a search of the file while the other lagged — and a lagging
    // entry is the one whose installs never hear there is something newer.
    const market = JSON.parse(
      readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"),
    ) as Marketplace;
    expect(market.plugins.map((p) => [p.name, p.source])).toEqual([
      ["astir", "./"],
      ["astir-tui", "./tui"],
    ]);
    for (const p of market.plugins) expect(p.version, p.name).toBe(manifest.version);
  });

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

  it("bump-version.mjs moves all seven stamps, both marketplace entries included", () => {
    // Run on a copy: the script finds the repository from its own location.
    const copy = stampedCopy();
    const ran = spawnSync("node", [join(copy, "scripts/bump-version.mjs"), "9.8.7"], { encoding: "utf8" });
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);

    for (const file of STAMPED.filter((f) => f.endsWith(".json") && !f.endsWith("marketplace.json"))) {
      expect(readFileSync(join(copy, file), "utf8"), file).toContain('"version": "9.8.7"');
    }
    const market = JSON.parse(
      readFileSync(join(copy, ".claude-plugin/marketplace.json"), "utf8"),
    ) as Marketplace;
    expect(market.plugins.map((p) => p.version)).toEqual(["9.8.7", "9.8.7"]);
    expect(readFileSync(join(copy, "contrib/swiftbar/astir.3s.sh"), "utf8")).toMatch(
      /<bitbar\.version>v?9\.8\.7<\/bitbar\.version>/,
    );
  });

  it("bump-version.mjs refuses loudly when a stamp it expects is not there", () => {
    // A marketplace that lost an entry is a stamp gone missing, not a smaller
    // job: reporting success on the rest is the failure the script prevents.
    const copy = stampedCopy();
    const market = JSON.parse(
      readFileSync(join(copy, ".claude-plugin/marketplace.json"), "utf8"),
    ) as Marketplace;
    market.plugins = market.plugins.slice(0, 1);
    writeFileSync(join(copy, ".claude-plugin/marketplace.json"), JSON.stringify(market, null, 2));
    const ran = spawnSync("node", [join(copy, "scripts/bump-version.mjs"), "9.8.7"], { encoding: "utf8" });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain(".claude-plugin/marketplace.json");
    // Nothing moved: six bumped and one not is the state this exists to prevent.
    expect(readFileSync(join(copy, "package.json"), "utf8")).toContain(`"version": "${manifest.version}"`);
  });

  it("bump-version.mjs refuses loudly when a file holds more stamps than it knows of", () => {
    // A third marketplace entry is a plugin this list has not heard of: its
    // stamp would move or not by accident of the regex, and its tui-like
    // manifest elsewhere would not move at all. Refused, not guessed at.
    const copy = stampedCopy();
    const market = JSON.parse(
      readFileSync(join(copy, ".claude-plugin/marketplace.json"), "utf8"),
    ) as Marketplace;
    market.plugins.push({ name: "astir-extra", source: "./extra", version: manifest.version });
    writeFileSync(join(copy, ".claude-plugin/marketplace.json"), JSON.stringify(market, null, 2));
    const ran = spawnSync("node", [join(copy, "scripts/bump-version.mjs"), "9.8.7"], { encoding: "utf8" });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("expected 2 version stamp(s) in .claude-plugin/marketplace.json, found 3");
    expect(readFileSync(join(copy, "package.json"), "utf8")).toContain(`"version": "${manifest.version}"`);
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

/** The script and every file it stamps, copied into a fresh directory. */
function stampedCopy(): string {
  const copy = mkdtempSync(join(tmpdir(), "astir-bump-"));
  for (const file of ["scripts/bump-version.mjs", ...STAMPED]) {
    mkdirSync(dirname(join(copy, file)), { recursive: true });
    copyFileSync(join(root, file), join(copy, file));
  }
  return copy;
}
