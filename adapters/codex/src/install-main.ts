/* c8 ignore start — writes the user's ~/.codex/config.toml; verified manually */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { writeManagedBlock, removeManagedBlock } from "./config-install.js";

const cfgPath = join(homedir(), ".codex", "config.toml");
const hookEntry = join(fileURLToPath(new URL(".", import.meta.url)), "hook-entry.js"); // built sibling
const command = `node ${hookEntry}`;

function read(): string { try { return readFileSync(cfgPath, "utf8"); } catch { return ""; } }
function write(s: string): void { mkdirSync(dirname(cfgPath), { recursive: true }); writeFileSync(cfgPath, s); }

const uninstall = process.argv.includes("--uninstall");
const next = uninstall ? removeManagedBlock(read()) : writeManagedBlock(read(), command);
write(next);
process.stdout.write(`clide: Codex hooks ${uninstall ? "removed from" : "installed into"} ${cfgPath}\n`);
/* c8 ignore stop */
