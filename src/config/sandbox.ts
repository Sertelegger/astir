/**
 * DMN-08 — why a sandboxed session is silent, and how to let it through.
 *
 * A project with `sandbox.enabled` runs behind an egress proxy, and clide's
 * hooks POST to `http://127.0.0.1:<port>`. Loopback is not in
 * `sandbox.network.allowedDomains` by default, so the proxy answers 403 and the
 * event never reaches the daemon.
 *
 * That failure is invisible from the daemon's side. Nothing arrives, so no
 * counter moves, and the session is indistinguishable from one whose hooks were
 * never installed — the menu bar could only list both possibilities and let the
 * reader guess which applied to them. Reading the project's own settings turns
 * that guess into a statement, and into a one-click fix.
 *
 * Nothing here runs on its own. Detection is read-only, and the write is only
 * ever reached from an explicit `clide allow-sandbox` or a menu item the user
 * clicked: relaxing someone's sandbox is exactly the kind of change that must
 * not happen as a side effect of installing a status tool.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The loopback host clide's hooks POST to. Ports are not part of the allowlist. */
export const LOOPBACK = "127.0.0.1";

export interface SandboxSettings {
  enabled: boolean;
  allowedDomains: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return asRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // A settings file we cannot parse is not a sandbox verdict. Treating it as
    // "not sandboxed" keeps a broken file from producing a confident wrong
    // diagnosis; the user has a bigger problem than clide either way.
    return null;
  }
}

/**
 * Collapse the settings layers into the sandbox config that actually applies.
 *
 * Claude Code resolves user < project < local, later winning, so this walks in
 * that order and lets each layer that mentions a key replace it. `allowedDomains`
 * is replaced rather than unioned, which is what the real precedence does — a
 * project that narrows the list has narrowed it.
 */
export function effectiveSandbox(layers: Array<Record<string, unknown> | null>): SandboxSettings {
  const out: SandboxSettings = { enabled: false, allowedDomains: [] };
  for (const layer of layers) {
    const sandbox = asRecord(layer?.sandbox);
    if (sandbox === null) continue;
    if (typeof sandbox.enabled === "boolean") out.enabled = sandbox.enabled;
    const network = asRecord(sandbox.network);
    if (network !== null && Array.isArray(network.allowedDomains)) {
      out.allowedDomains = network.allowedDomains.filter((d): d is string => typeof d === "string");
    }
  }
  return out;
}

/** Sandboxed, and not permitted to reach the daemon. */
export function isBlocked(sandbox: SandboxSettings, host: string = LOOPBACK): boolean {
  return sandbox.enabled && !sandbox.allowedDomains.includes(host);
}

/** The settings files that apply to a project, in precedence order. */
export function settingsLayers(cwd: string, home: string = homedir()): string[] {
  return [
    join(home, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ];
}

export interface SandboxState {
  /** Sandboxed AND unable to reach the daemon — the only case worth reporting. */
  blocked: boolean;
  enabled: boolean;
  /** Where `allowLoopback` would write. */
  path: string;
}

export function inspectSandbox(cwd: string, host: string = LOOPBACK, home: string = homedir()): SandboxState {
  const layers = settingsLayers(cwd, home).map(readJsonObject);
  const sandbox = effectiveSandbox(layers);
  return {
    enabled: sandbox.enabled,
    blocked: isBlocked(sandbox, host),
    // The personal, uncommitted layer: loosening a sandbox is a local decision
    // and does not belong in a file the whole team checks out.
    path: join(cwd, ".claude", "settings.local.json"),
  };
}

/**
 * Add the loopback host to a settings object, merging rather than replacing.
 *
 * `allowLocalBinding` rides along because the two are asked for together and a
 * half-applied exception fails exactly like no exception at all.
 */
export function withLoopbackAllowed(
  settings: Record<string, unknown>,
  host: string = LOOPBACK,
): Record<string, unknown> {
  const sandbox = asRecord(settings.sandbox) ?? {};
  const network = asRecord(sandbox.network) ?? {};
  const existing = Array.isArray(network.allowedDomains)
    ? network.allowedDomains.filter((d): d is string => typeof d === "string")
    : [];
  const allowedDomains = existing.includes(host) ? existing : [...existing, host];
  return {
    ...settings,
    sandbox: { ...sandbox, network: { ...network, allowedDomains, allowLocalBinding: true } },
  };
}

export interface AllowResult {
  ok: boolean;
  /** False when it was already allowed — nothing was written. */
  changed: boolean;
  detail: string;
  path: string;
}

/**
 * Permit the daemon through a project's sandbox.
 *
 * Refuses an unparseable file rather than replacing it, for the same reason the
 * token installer does: overwriting settings we could not read discards work
 * that is not ours to discard.
 */
export function allowLoopback(cwd: string, host: string = LOOPBACK, home: string = homedir()): AllowResult {
  const path = inspectSandbox(cwd, host, home).path;

  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed = readJsonObject(path);
    if (parsed === null) {
      return {
        ok: false,
        changed: false,
        path,
        detail: `${path} is not readable as JSON — fix or move it and try again`,
      };
    }
    current = parsed;
  }

  const sandbox = effectiveSandbox([current]);
  if (sandbox.allowedDomains.includes(host)) {
    return { ok: true, changed: false, path, detail: `${host} is already allowed in ${path}` };
  }

  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(withLoopbackAllowed(current, host), null, 2)}\n`);
  renameSync(tmp, path);
  return { ok: true, changed: true, path, detail: `allowed ${host} in ${path}` };
}
