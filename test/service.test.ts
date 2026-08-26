import { describe, expect, it } from "vitest";
import {
  installService,
  SERVICE_LABEL,
  type ServiceDeps,
  servicePlist,
  uninstallService,
} from "../src/config/service.js";

const SPEC = {
  node: "/opt/node/bin/node",
  script: "/usr/local/lib/astir/main.js",
  logPath: "/home/u/.astir/daemon.log",
};

function deps(over: Partial<ServiceDeps> & { fail?: string[] } = {}): ServiceDeps & {
  calls: string[][];
  written: Array<[string, string]>;
} {
  const calls: string[][] = [];
  const written: Array<[string, string]> = [];
  return {
    calls,
    written,
    platform: "darwin",
    uid: 501,
    exists: () => false,
    write: (path, contents) => {
      written.push([path, contents]);
    },
    remove: () => undefined,
    run: (file, args) => {
      calls.push([file, ...args]);
      const failed = (over.fail ?? []).some((f) => args.includes(f));
      return failed ? { ok: false, detail: "refused" } : { ok: true, detail: "" };
    },
    ...over,
  };
}

describe("the LaunchAgent", () => {
  it("runs the interpreter and the script by absolute path", () => {
    // launchd starts this with a minimal PATH that has never heard of a version
    // manager — the same failure that made SwiftBar's menu clicks do nothing.
    const plist = servicePlist(SPEC);
    expect(plist).toContain("<string>/opt/node/bin/node</string>");
    expect(plist).toContain("<string>/usr/local/lib/astir/main.js</string>");
    expect(plist).toContain("<string>daemon</string>");
  });

  it("comes back after a reboot and after a crash", () => {
    // A daemon that stays dead after one crash puts the user back where they
    // started: hook errors, and no idea why.
    const plist = servicePlist(SPEC);
    expect(plist).toContain("<key>RunAtLoad</key>\n    <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n    <true/>");
  });

  it("escapes paths so a stray character cannot produce invalid XML", () => {
    const plist = servicePlist({ ...SPEC, script: "/tmp/a&b<c>/main.js" });
    expect(plist).toContain("/tmp/a&amp;b&lt;c&gt;/main.js");
    expect(plist).not.toContain("a&b<c>");
  });
});

describe("installing it", () => {
  it("writes the plist and bootstraps it", () => {
    const d = deps();
    const r = installService(SPEC, d);
    expect(r.ok).toBe(true);
    expect(d.written).toHaveLength(1);
    expect(d.calls).toContainEqual(["launchctl", "bootstrap", "gui/501", d.written[0]?.[0] ?? ""]);
  });

  it("falls back to the deprecated load verb when bootstrap is refused", () => {
    // Which verb works depends on the macOS version, and a service that silently
    // failed to load would leave the user believing the problem is fixed.
    const d = deps({ fail: ["bootstrap"] });
    const r = installService(SPEC, d);
    expect(r.ok).toBe(true);
    expect(d.calls.some((c) => c.includes("load"))).toBe(true);
  });

  it("reports failure rather than claiming success when launchctl refuses both", () => {
    const d = deps({ fail: ["bootstrap", "load"] });
    const r = installService(SPEC, d);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("refused");
  });

  it("boots out an existing copy first, or the new plist never takes effect", () => {
    const d = deps({ exists: () => true });
    installService(SPEC, d);
    const bootout = d.calls.findIndex((c) => c.includes("bootout"));
    const bootstrap = d.calls.findIndex((c) => c.includes("bootstrap"));
    expect(bootout).toBeGreaterThanOrEqual(0);
    expect(bootout).toBeLessThan(bootstrap);
  });

  it("refuses on a platform it has not implemented, instead of doing nothing", () => {
    const r = installService(SPEC, deps({ platform: "linux" }));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("macOS");
    expect(r.detail).toContain("systemd");
  });
});

describe("removing it", () => {
  it("unloads and deletes the plist", () => {
    const removed: string[] = [];
    const d = deps({ exists: () => true, remove: (p) => removed.push(p) });
    const r = uninstallService(d);
    expect(r.ok).toBe(true);
    expect(d.calls.some((c) => c.includes(`gui/501/${SERVICE_LABEL}`))).toBe(true);
    expect(removed).toHaveLength(1);
  });

  it("is not an error when it was never installed", () => {
    const r = uninstallService(deps({ exists: () => false }));
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("not installed");
  });
});
