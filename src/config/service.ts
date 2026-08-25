/**
 * DMN-12 — keep the daemon running, because a hook cannot be quiet when it is not.
 *
 * The hooks are `type: "http"`, and an http hook has no way to fail silently:
 * its schema offers `url`, `timeout`, `headers`, `allowedEnvVars`, `if`,
 * `statusMessage` and `once`, and nothing that says "ignore a refused
 * connection". `async` — which does make a failure quiet — exists only on
 * command hooks. So every event fired while the daemon is down becomes a visible
 * error in whatever session the user is working in, twice per tool call, and
 * clide becomes an active nuisance in exactly the moment it is providing nothing.
 *
 * The honest fix is therefore not to suppress the symptom but to remove the
 * cause: a daemon that comes back by itself after a reboot, a crash, or a
 * logout. That is what a LaunchAgent is for.
 *
 * Installing this is a separate, explicit command for the same reason `clide
 * install` is (INS-01): registering something that runs at every login is not a
 * thing to do as a side effect of anything else.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SERVICE_LABEL = "com.clide.daemon";

export function servicePath(home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface ServiceSpec {
  /** Absolute path to the node binary. */
  node: string;
  /** Absolute path to clide's entrypoint. */
  script: string;
  logPath: string;
}

/**
 * The LaunchAgent.
 *
 * `ProgramArguments` carries absolute paths for both the interpreter and the
 * script: launchd starts this with a minimal PATH that has never heard of a
 * version manager, which is the same failure that made SwiftBar's menu clicks
 * silently do nothing.
 *
 * `KeepAlive` restarts it if it dies, since a daemon that stays dead after one
 * crash puts the user right back where they started — with hook errors and no
 * idea why.
 */
export function servicePlist(spec: ServiceSpec): string {
  const args = [spec.node, spec.script, "daemon"]
    .map((a) => `      <string>${xmlEscape(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xmlEscape(spec.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(spec.logPath)}</string>
  </dict>
</plist>
`;
}

export interface ServiceDeps {
  run: (file: string, args: string[]) => { ok: boolean; detail: string };
  write: (path: string, contents: string) => void;
  remove: (path: string) => void;
  exists: (path: string) => boolean;
  platform: string;
  uid: number;
}

export function defaultServiceDeps(): ServiceDeps {
  return {
    run: (file, args) => {
      try {
        const out = execFileSync(file, args, {
          encoding: "utf8",
          timeout: 15_000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { ok: true, detail: out.trim() };
      } catch (err) {
        const e = err as { stderr?: Buffer | string; message?: string };
        const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString();
        return { ok: false, detail: (stderr || e.message || "failed").trim() };
      }
    },
    write: (path, contents) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    },
    remove: (path) => {
      if (existsSync(path)) unlinkSync(path);
    },
    exists: (path) => existsSync(path),
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
  };
}

export interface ServiceResult {
  ok: boolean;
  detail: string;
}

/**
 * `bootstrap` is the modern verb and `load` the deprecated one. Both are tried
 * because which works depends on the macOS version, and a service that silently
 * failed to load would leave the user believing the problem is fixed.
 */
export function installService(spec: ServiceSpec, deps: ServiceDeps = defaultServiceDeps()): ServiceResult {
  if (deps.platform !== "darwin") {
    return {
      ok: false,
      detail:
        `autostart is only implemented for macOS, not ${deps.platform}. ` +
        "Run `clide daemon` from your session manager (systemd --user, supervisor) instead.",
    };
  }

  const path = servicePath();
  // Unload an older copy first, or bootstrap refuses with "service already loaded"
  // and the newly written plist would never take effect.
  if (deps.exists(path)) {
    deps.run("launchctl", ["bootout", `gui/${deps.uid}/${SERVICE_LABEL}`]);
  }
  deps.write(path, servicePlist(spec));

  const bootstrapped = deps.run("launchctl", ["bootstrap", `gui/${deps.uid}`, path]);
  if (bootstrapped.ok) return { ok: true, detail: `installed and started (${path})` };

  const loaded = deps.run("launchctl", ["load", "-w", path]);
  if (loaded.ok) return { ok: true, detail: `installed and started (${path})` };

  return {
    ok: false,
    detail: `wrote ${path} but launchctl refused it: ${bootstrapped.detail || loaded.detail}`,
  };
}

export function uninstallService(deps: ServiceDeps = defaultServiceDeps()): ServiceResult {
  if (deps.platform !== "darwin") {
    return { ok: false, detail: `autostart is only implemented for macOS, not ${deps.platform}` };
  }
  const path = servicePath();
  if (!deps.exists(path)) return { ok: true, detail: "autostart was not installed" };

  deps.run("launchctl", ["bootout", `gui/${deps.uid}/${SERVICE_LABEL}`]);
  deps.run("launchctl", ["unload", path]);
  deps.remove(path);
  return { ok: true, detail: `removed ${path}` };
}

export function serviceInstalled(deps: ServiceDeps = defaultServiceDeps()): boolean {
  return deps.exists(servicePath());
}
