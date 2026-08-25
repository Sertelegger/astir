import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowLoopback,
  effectiveSandbox,
  inspectSandbox,
  isBlocked,
  LOOPBACK,
  withLoopbackAllowed,
} from "../src/config/sandbox.js";

/** A project tree with the given settings layers written into it. */
function project(layers: { user?: unknown; project?: unknown; local?: unknown }): {
  home: string;
  cwd: string;
} {
  const home = mkdtempSync(join(tmpdir(), "clide-sbx-"));
  const cwd = join(home, "repo");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  const put = (path: string, value: unknown): void => {
    if (value !== undefined) writeFileSync(path, JSON.stringify(value));
  };
  put(join(home, ".claude", "settings.json"), layers.user);
  put(join(cwd, ".claude", "settings.json"), layers.project);
  put(join(cwd, ".claude", "settings.local.json"), layers.local);
  return { home, cwd };
}

describe("effective sandbox settings", () => {
  it("is off when nothing mentions it", () => {
    expect(effectiveSandbox([null, {}, {}])).toEqual({ enabled: false, allowedDomains: [] });
  });

  it("lets a later layer turn it on", () => {
    // user < project < local, which is Claude Code's own precedence.
    expect(effectiveSandbox([{ sandbox: { enabled: false } }, { sandbox: { enabled: true } }])).toMatchObject(
      {
        enabled: true,
      },
    );
  });

  it("lets a later layer turn it back off", () => {
    expect(effectiveSandbox([{ sandbox: { enabled: true } }, { sandbox: { enabled: false } }])).toMatchObject(
      {
        enabled: false,
      },
    );
  });

  it("replaces allowedDomains rather than unioning them", () => {
    // A project that narrows the list has narrowed it; merging would silently
    // re-permit a host the user removed.
    const s = effectiveSandbox([
      { sandbox: { network: { allowedDomains: ["a.com", "127.0.0.1"] } } },
      { sandbox: { network: { allowedDomains: ["b.com"] } } },
    ]);
    expect(s.allowedDomains).toEqual(["b.com"]);
  });

  it("ignores a sandbox key that is not an object", () => {
    expect(effectiveSandbox([{ sandbox: "yes" }])).toEqual({ enabled: false, allowedDomains: [] });
  });
});

describe("blocked detection", () => {
  it("is not blocked when the sandbox is off, whatever the allowlist says", () => {
    expect(isBlocked({ enabled: false, allowedDomains: [] })).toBe(false);
  });

  it("is blocked when sandboxed without loopback allowed", () => {
    expect(isBlocked({ enabled: true, allowedDomains: ["example.com"] })).toBe(true);
  });

  it("is not blocked once loopback is allowed", () => {
    expect(isBlocked({ enabled: true, allowedDomains: [LOOPBACK] })).toBe(false);
  });
});

describe("inspecting a project", () => {
  it("reports a sandboxed project as blocked", () => {
    const { home, cwd } = project({ local: { sandbox: { enabled: true } } });
    expect(inspectSandbox(cwd, LOOPBACK, home)).toMatchObject({ enabled: true, blocked: true });
  });

  it("reports an unsandboxed project as fine", () => {
    const { home, cwd } = project({ local: { permissions: {} } });
    expect(inspectSandbox(cwd, LOOPBACK, home)).toMatchObject({ enabled: false, blocked: false });
  });

  it("does not call an unparseable settings file sandboxed", () => {
    // A confident wrong diagnosis is worse than none — the user has a bigger
    // problem than clide if this file is broken.
    const { home, cwd } = project({});
    writeFileSync(join(cwd, ".claude", "settings.local.json"), "{ oops");
    expect(inspectSandbox(cwd, LOOPBACK, home).blocked).toBe(false);
  });

  it("sees a sandbox enabled globally but allowed in the project", () => {
    const { home, cwd } = project({
      user: { sandbox: { enabled: true } },
      local: { sandbox: { network: { allowedDomains: [LOOPBACK] } } },
    });
    expect(inspectSandbox(cwd, LOOPBACK, home)).toMatchObject({ enabled: true, blocked: false });
  });
});

describe("granting the exception", () => {
  it("adds loopback while preserving every other setting", () => {
    const { home, cwd } = project({
      local: { permissions: { allow: ["Bash(git push)"] }, sandbox: { enabled: true } },
    });

    const r = allowLoopback(cwd, LOOPBACK, home);
    expect(r).toMatchObject({ ok: true, changed: true });

    const after = JSON.parse(readFileSync(r.path, "utf8"));
    expect(after.permissions.allow).toEqual(["Bash(git push)"]);
    expect(after.sandbox.enabled).toBe(true);
    expect(after.sandbox.network.allowedDomains).toContain(LOOPBACK);
    expect(inspectSandbox(cwd, LOOPBACK, home).blocked).toBe(false);
  });

  it("keeps domains the project had already allowed", () => {
    const { home, cwd } = project({
      local: { sandbox: { enabled: true, network: { allowedDomains: ["registry.npmjs.org"] } } },
    });
    const r = allowLoopback(cwd, LOOPBACK, home);
    const after = JSON.parse(readFileSync(r.path, "utf8"));
    expect(after.sandbox.network.allowedDomains).toEqual(["registry.npmjs.org", LOOPBACK]);
  });

  it("is idempotent and writes nothing the second time", () => {
    const { home, cwd } = project({ local: { sandbox: { enabled: true } } });
    allowLoopback(cwd, LOOPBACK, home);
    const again = allowLoopback(cwd, LOOPBACK, home);
    expect(again).toMatchObject({ ok: true, changed: false });
  });

  it("refuses an unparseable file instead of replacing it", () => {
    const { home, cwd } = project({});
    const path = join(cwd, ".claude", "settings.local.json");
    writeFileSync(path, "{ oops");
    const r = allowLoopback(cwd, LOOPBACK, home);
    expect(r.ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("{ oops");
  });

  it("writes to the local, uncommitted layer", () => {
    // Loosening a sandbox is a personal decision and does not belong in a file
    // the whole team checks out.
    const { home, cwd } = project({ local: { sandbox: { enabled: true } } });
    expect(allowLoopback(cwd, LOOPBACK, home).path).toBe(join(cwd, ".claude", "settings.local.json"));
  });
});

describe("withLoopbackAllowed", () => {
  it("creates the nested shape from nothing", () => {
    const out = withLoopbackAllowed({}, LOOPBACK) as {
      sandbox: { network: { allowedDomains: string[]; allowLocalBinding: boolean } };
    };
    expect(out.sandbox.network.allowedDomains).toEqual([LOOPBACK]);
    // Asked for together; a half-applied exception fails like no exception.
    expect(out.sandbox.network.allowLocalBinding).toBe(true);
  });
});
