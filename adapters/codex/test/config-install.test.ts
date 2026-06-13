import { describe, it, expect } from "vitest";
import { writeManagedBlock, removeManagedBlock, START, END } from "../src/config-install.js";

const userToml = `model = "gpt-5"\n\n[[hooks.PreToolUse]]\ncommand = "user-hook.sh"\n`;
const cmd = "node /abs/dist/hook-entry.js";

describe("config.toml managed block (REQ-008)", () => {
  it("appends a sentinel-delimited block, preserving all user content", () => {
    const out = writeManagedBlock(userToml, cmd);
    expect(out).toContain(userToml.trim());                 // user content preserved verbatim
    expect(out).toContain(START); expect(out).toContain(END);
    expect(out).toContain('[[hooks.PostToolUse]]');
    expect(out).toContain(`command = "${cmd}"`);            // static command, no interpolation
    expect(out).not.toContain("${");                        // no runtime interpolation in the command
  });
  it("is idempotent: re-writing replaces the managed block, not duplicating it", () => {
    const once = writeManagedBlock(userToml, cmd);
    const twice = writeManagedBlock(once, cmd);
    expect(twice).toBe(once);
    expect((twice.match(new RegExp(START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length).toBe(1);
  });
  it("removeManagedBlock strips only the managed region, leaving user content", () => {
    const installed = writeManagedBlock(userToml, cmd);
    const removed = removeManagedBlock(installed);
    expect(removed).toContain('command = "user-hook.sh"');
    expect(removed).not.toContain(START);
    expect(removed).not.toContain("hook-entry.js");
  });
});
