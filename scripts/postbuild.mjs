/**
 * `tsc` emits 0644, which is wrong for a file with a shebang that is both the
 * package `bin` and the target of SwiftBar menu actions. npm chmods bin links on
 * install, so this only bites a checkout run in place — where a menu click would
 * do nothing at all, silently, which is the failure mode this project exists to
 * avoid inflicting on people.
 */
import { chmodSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli", "main.js");
chmodSync(entry, statSync(entry).mode | 0o111);
