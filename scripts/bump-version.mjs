#!/usr/bin/env node
/**
 * Move every version stamp at once.
 *
 * There are four, and the fourth is the point of this script: an audit reading
 * carefully still missed `contrib/swiftbar/astir.3s.sh`, whose version lives in
 * a `<bitbar.version>` comment that SwiftBar reads and no JSON tooling would
 * ever look at. Three stamps agreeing and one lagging is a state nothing else
 * detects.
 *
 *   node scripts/bump-version.mjs 0.2.0
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every file carrying the version, and how it is written in each. */
const STAMPS = [
  { file: "package.json", find: /("version":\s*")[^"]+(")/, label: "npm manifest" },
  { file: ".claude-plugin/plugin.json", find: /("version":\s*")[^"]+(")/, label: "plugin manifest" },
  {
    file: ".claude-plugin/marketplace.json",
    find: /("version":\s*")[^"]+(")/,
    // This one is load-bearing for delivery, not cosmetic: it is what tells an
    // already-installed `claude plugin install` that there is something newer.
    label: "marketplace manifest — triggers the plugin refresh",
  },
  {
    file: "contrib/swiftbar/astir.3s.sh",
    find: /(<bitbar\.version>v?)[^<]+(<\/bitbar\.version>)/,
    label: "SwiftBar plugin header",
  },
];

const next = process.argv[2];
if (next === undefined || !/^\d+\.\d+\.\d+$/.test(next)) {
  process.stderr.write("usage: node scripts/bump-version.mjs X.Y.Z\n");
  process.exit(64);
}

let failed = false;
for (const stamp of STAMPS) {
  const path = join(root, stamp.file);
  const before = readFileSync(path, "utf8");
  const after = before.replace(stamp.find, `$1${next}$2`);
  if (after === before) {
    // Refusing loudly rather than reporting success on three of four, which is
    // exactly the failure this exists to prevent.
    process.stderr.write(`no version stamp matched in ${stamp.file}\n`);
    failed = true;
    continue;
  }
  writeFileSync(path, after);
  process.stdout.write(`  ${next}  ${stamp.file}  (${stamp.label})\n`);
}
process.exit(failed ? 1 : 0);
