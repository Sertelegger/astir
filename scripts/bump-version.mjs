#!/usr/bin/env node
/**
 * Move every version stamp at once.
 *
 * There are seven, in six files, and the SwiftBar one is the point of this
 * script: an audit reading carefully still missed `contrib/swiftbar/astir.3s.sh`,
 * whose version lives in a `<bitbar.version>` comment that SwiftBar reads and
 * no JSON tooling would ever look at. Six stamps agreeing and one lagging is a
 * state nothing else detects. The marketplace holds two of them, one per entry
 * (astir and astir-tui), which is why each file says how many it carries.
 *
 *   node scripts/bump-version.mjs 0.2.0
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every file carrying the version, how it is written there, and how many times
 * (`count`, 1 when unsaid). A file holding any other number of matches is
 * refused: fewer is a stamp gone missing, more is one this list has not heard of.
 */
const STAMPS = [
  { file: "package.json", find: /("version":\s*")[^"]+(")/g, label: "npm manifest" },
  { file: ".claude-plugin/plugin.json", find: /("version":\s*")[^"]+(")/g, label: "plugin manifest" },
  { file: ".codex-plugin/plugin.json", find: /("version":\s*")[^"]+(")/g, label: "Codex plugin manifest" },
  {
    file: ".claude-plugin/marketplace.json",
    find: /("version":\s*")[^"]+(")/g,
    count: 2,
    // These are load-bearing for delivery, not cosmetic: each entry's version
    // is what tells an already-installed `claude plugin install` of that
    // plugin that there is something newer. Replacing only the first match
    // would leave astir-tui's installs on the old version for good.
    label: "marketplace manifest, astir and astir-tui — triggers the plugin refresh",
  },
  {
    file: "tui/.claude-plugin/plugin.json",
    find: /("version":\s*")[^"]+(")/g,
    label: "astir-tui plugin manifest",
  },
  {
    file: "contrib/swiftbar/astir.3s.sh",
    find: /(<bitbar\.version>v?)[^<]+(<\/bitbar\.version>)/g,
    label: "SwiftBar plugin header",
  },
];

const next = process.argv[2];
if (next === undefined || !/^\d+\.\d+\.\d+$/.test(next)) {
  process.stderr.write("usage: node scripts/bump-version.mjs X.Y.Z\n");
  process.exit(64);
}

// Every file is checked before any is written, so a refusal leaves all seven
// where they were rather than six moved and one not.
let failed = false;
const writes = [];
for (const stamp of STAMPS) {
  const path = join(root, stamp.file);
  const before = readFileSync(path, "utf8");
  const want = stamp.count ?? 1;
  const found = before.match(stamp.find)?.length ?? 0;
  if (found !== want) {
    // Refusing loudly rather than reporting success on six of seven, which is
    // exactly the failure this exists to prevent.
    process.stderr.write(`expected ${want} version stamp(s) in ${stamp.file}, found ${found}\n`);
    failed = true;
    continue;
  }
  writes.push({ path, text: before.replace(stamp.find, `$1${next}$2`), stamp });
}
if (failed) process.exit(1);
for (const { path, text, stamp } of writes) {
  writeFileSync(path, text);
  process.stdout.write(`  ${next}  ${stamp.file}  (${stamp.label})\n`);
}
