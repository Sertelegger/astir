import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeSettingsPath,
  defaultSettingsDeps,
  installToken,
  parseSettings,
  type SettingsDeps,
  serializeSettings,
  tokenIsFilteredOut,
  tokenState,
  withToken,
} from "../src/cli/settings.js";

const TOKEN = "a".repeat(64);

/** An in-memory settings.json, so nothing here touches a real ~/.claude. */
function deps(initial: string | null): SettingsDeps & { current: () => string | null; hardened: string[] } {
  let contents = initial;
  const hardened: string[] = [];
  return {
    path: () => "/fake/.claude/settings.json",
    read: () => contents,
    write: (_path, next) => {
      contents = next;
    },
    harden: (path) => hardened.push(path),
    current: () => contents,
    hardened,
  };
}

describe("settings path resolution", () => {
  it("defaults to ~/.claude/settings.json", () => {
    expect(claudeSettingsPath({}, "/home/x")).toBe(join("/home/x", ".claude", "settings.json"));
  });

  it("honours CLAUDE_CONFIG_DIR", () => {
    // Writing to ~/.claude while Claude Code reads elsewhere would produce a
    // token that looks installed and is never loaded — the exact failure this
    // whole mechanism exists to remove.
    expect(claudeSettingsPath({ CLAUDE_CONFIG_DIR: "/opt/cc" }, "/home/x")).toBe(
      join("/opt/cc", "settings.json"),
    );
  });

  it("ignores a blank CLAUDE_CONFIG_DIR rather than writing to /settings.json", () => {
    expect(claudeSettingsPath({ CLAUDE_CONFIG_DIR: "   " }, "/home/x")).toBe(
      join("/home/x", ".claude", "settings.json"),
    );
  });
});

describe("parsing", () => {
  it("treats an absent file as an empty object", () => {
    expect(parseSettings(null)).toEqual({ ok: true, settings: {}, existed: false });
  });

  it("treats an empty file as existing but empty", () => {
    expect(parseSettings("  \n")).toEqual({ ok: true, settings: {}, existed: true });
  });

  it("refuses malformed JSON instead of replacing it", () => {
    // A malformed settings.json silently disables every setting in it. The one
    // unacceptable outcome is overwriting a file we could not read.
    const r = parseSettings('{"env": ');
    expect(r.ok).toBe(false);
  });

  it("refuses a non-object top level", () => {
    expect(parseSettings("[1,2]").ok).toBe(false);
  });

  it("refuses a non-object env rather than clobbering it", () => {
    const r = parseSettings('{"env": "nope"}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("env");
  });
});

describe("token state", () => {
  it("reports absent when there is no env block", () => {
    expect(tokenState({}, TOKEN)).toEqual({ kind: "absent" });
  });

  it("reports absent when env exists without the key", () => {
    expect(tokenState({ env: { OTHER: "1" } }, TOKEN)).toEqual({ kind: "absent" });
  });

  it("reports current on an exact match", () => {
    expect(tokenState({ env: { CLIDE_TOKEN: TOKEN } }, TOKEN)).toEqual({ kind: "current" });
  });

  it("reports stale when the token file has been regenerated", () => {
    expect(tokenState({ env: { CLIDE_TOKEN: "old" } }, TOKEN)).toEqual({
      kind: "stale",
      existing: "old",
    });
  });
});

describe("merging", () => {
  it("preserves every unrelated setting", () => {
    const before = {
      permissions: { defaultMode: "auto" },
      enabledPlugins: { "clide@clide-marketplace": true },
      model: "opus",
    };
    const after = withToken(before, TOKEN);
    expect(after.permissions).toEqual({ defaultMode: "auto" });
    expect(after.enabledPlugins).toEqual({ "clide@clide-marketplace": true });
    expect(after.model).toBe("opus");
  });

  it("preserves other env vars", () => {
    const after = withToken({ env: { DEBUG: "1", PATH_EXTRA: "/x" } }, TOKEN);
    expect(after.env).toEqual({ DEBUG: "1", PATH_EXTRA: "/x", CLIDE_TOKEN: TOKEN });
  });

  it("does not reorder existing keys", () => {
    const after = withToken({ a: 1, env: { DEBUG: "1" }, z: 2 }, TOKEN);
    expect(Object.keys(after)).toEqual(["a", "env", "z"]);
  });

  it("serializes the way Claude Code writes the file", () => {
    const out = serializeSettings({ env: { CLIDE_TOKEN: TOKEN } });
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain('\n  "env": {');
  });
});

describe("installToken", () => {
  it("creates the file when there is none", () => {
    const d = deps(null);
    const r = installToken(TOKEN, d);
    expect(r).toMatchObject({ ok: true, outcome: "written" });
    expect(JSON.parse(d.current() ?? "").env.CLIDE_TOKEN).toBe(TOKEN);
  });

  it("adds the key to an existing file without disturbing it", () => {
    const d = deps('{\n  "model": "opus",\n  "enabledPlugins": { "x@y": true }\n}\n');
    const r = installToken(TOKEN, d);
    expect(r.outcome).toBe("written");
    const after = JSON.parse(d.current() ?? "");
    expect(after.model).toBe("opus");
    expect(after.enabledPlugins).toEqual({ "x@y": true });
    expect(after.env.CLIDE_TOKEN).toBe(TOKEN);
  });

  it("is idempotent — a second run writes nothing", () => {
    const d = deps(`{"env":{"CLIDE_TOKEN":"${TOKEN}"}}`);
    let writes = 0;
    const counted: SettingsDeps = {
      ...d,
      write: (p, c) => {
        writes++;
        d.write(p, c);
      },
    };
    const r = installToken(TOKEN, counted);
    expect(r.outcome).toBe("already-current");
    expect(writes).toBe(0);
  });

  it("still re-asserts the mode when the token was already correct", () => {
    // The value being right says nothing about the mode being right: a file
    // written before this hardening existed holds the token at 0644.
    const d = deps(`{"env":{"CLIDE_TOKEN":"${TOKEN}"}}`);
    installToken(TOKEN, d);
    expect(d.hardened).toEqual(["/fake/.claude/settings.json"]);
  });

  it("replaces a stale token and says so", () => {
    const d = deps('{"env":{"CLIDE_TOKEN":"stale-value","KEEP":"1"}}');
    const r = installToken(TOKEN, d);
    expect(r.outcome).toBe("updated");
    expect(r.detail).toContain("older token");
    const after = JSON.parse(d.current() ?? "");
    expect(after.env.CLIDE_TOKEN).toBe(TOKEN);
    expect(after.env.KEEP).toBe("1");
  });

  it("refuses to overwrite a file it cannot parse, and leaves it byte-identical", () => {
    const broken = '{"model": "opus", oops}';
    const d = deps(broken);
    const r = installToken(TOKEN, d);
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe("refused");
    expect(d.current()).toBe(broken);
  });
});

describe("httpHookAllowedEnvVars", () => {
  it("is fine when unset", () => {
    expect(tokenIsFilteredOut({})).toBe(false);
  });

  it("is fine when it names CLIDE_TOKEN", () => {
    expect(tokenIsFilteredOut({ httpHookAllowedEnvVars: ["CLIDE_TOKEN"] })).toBe(false);
  });

  it("is flagged when set without CLIDE_TOKEN", () => {
    // Intersected with the hook's own allowedEnvVars, so this filters the header
    // to empty while the variable itself looks perfectly installed.
    expect(tokenIsFilteredOut({ httpHookAllowedEnvVars: ["OTHER"] })).toBe(true);
  });
});

describe("on-disk write", () => {
  const fixture = (): SettingsDeps & { file: string } => {
    const home = mkdtempSync(join(tmpdir(), "clide-settings-"));
    const file = join(home, ".claude", "settings.json");
    return { ...defaultSettingsDeps(), path: () => file, file };
  };

  it("creates the settings directory when it does not exist yet", () => {
    const d = fixture();
    const r = installToken(TOKEN, d);
    expect(r.ok).toBe(true);
    expect(JSON.parse(readFileSync(d.file, "utf8")).env.CLIDE_TOKEN).toBe(TOKEN);
  });

  // PLT-02: POSIX modes do not exist on Windows, so these assert nothing there.
  it.skipIf(process.platform === "win32")("writes the file 0600", () => {
    // It now holds a bearer token; the conventional 0644 would leave it readable
    // by every other user on the machine.
    const d = fixture();
    installToken(TOKEN, d);
    expect(statSync(d.file).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("re-asserts 0600 when it rewrites a 0644 file", () => {
    const d = fixture();
    installToken(TOKEN, d);
    chmodSync(d.file, 0o644);
    writeFileSync(d.file, '{"model":"opus"}');

    installToken(TOKEN, d);
    expect(statSync(d.file).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("re-asserts 0600 without rewriting a correct file", () => {
    // The path an already-installed machine takes. Nothing is written, so if the
    // mode were not re-asserted here it would never be fixed at all.
    const d = fixture();
    installToken(TOKEN, d);
    chmodSync(d.file, 0o644);

    const r = installToken(TOKEN, d);
    expect(r.outcome).toBe("already-current");
    expect(statSync(d.file).mode & 0o777).toBe(0o600);
  });
});
