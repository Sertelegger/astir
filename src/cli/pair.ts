/**
 * PSH-15 — `astir pair <host>`: make a remote machine able to reach you, once.
 *
 * The manual setup was three steps in two places, one of which had to be
 * repeated on every connection:
 *
 *   1. remember `ssh -R 47001:127.0.0.1:47001 devbox` every single time
 *   2. get the shared token onto the remote machine somehow
 *   3. start the remote daemon with a `--notify-url` pointing back through it
 *
 * Steps 1 and 3 are the same every time, which means they are configuration, not
 * decisions — so they belong in `~/.ssh/config` and in autodetection
 * respectively. Step 2 is a one-time secret copy. What remains is one command.
 *
 * Everything here is done over the user's existing SSH access, using their own
 * config and agent. Nothing is installed, no credentials are created, and the
 * only file modified is `~/.ssh/config` — which is asked about first, because
 * silently editing the file that governs how someone reaches every machine they
 * own would be an unpleasant surprise.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PairDeps {
  ssh: (host: string, command: string, input?: string) => { ok: boolean; out: string };
  readSshConfig: () => string;
  appendSshConfig: (block: string) => void;
  log: (line: string) => void;
  confirm: (question: string) => boolean;
}

export interface PairOptions {
  host: string;
  notifyPort: number;
  token: string;
  /** Skip the ssh-config edit entirely and just print what would be added. */
  dryRun?: boolean;
}

export function sshConfigPath(): string {
  return join(homedir(), ".ssh", "config");
}

/** The forward that makes the local notifier reachable from the remote machine. */
export function forwardBlock(host: string, port: number): string {
  return `\nHost ${host}\n  RemoteForward ${port} 127.0.0.1:${port}\n`;
}

/**
 * Does the config already forward this port to this host?
 *
 * Deliberately conservative: a loose match risks appending a duplicate `Host`
 * stanza, and OpenSSH applies the *first* matching value for most keywords, so a
 * duplicate can silently shadow the user's own settings.
 */
export function alreadyForwards(config: string, host: string, port: number): boolean {
  const lines = config.split("\n");
  let inHost = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^host\s/i.test(line)) {
      inHost = line
        .slice(4)
        .trim()
        .split(/\s+/)
        .some((pattern) => pattern === host);
      continue;
    }
    if (!inHost) continue;
    if (new RegExp(`^remoteforward\\s+(?:\\S+:)?${port}\\b`, "i").test(line)) return true;
  }
  return false;
}

/**
 * Every host `astir pair` has set up a forward for.
 *
 * This is the paired-host list, derived from the file that already records it
 * rather than from a second config of our own: a host is paired exactly when its
 * stanza carries the RemoteForward pair wrote. Deriving it means the two can
 * never disagree, and un-pairing is just deleting the stanza.
 */
export function pairedHosts(config: string, port: number): string[] {
  const hosts: string[] = [];
  let current: string[] = [];
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    if (/^host\s/i.test(line)) {
      current = line
        .slice(4)
        .trim()
        .split(/\s+/)
        // A pattern is not a host we can ssh to.
        .filter((h) => h.length > 0 && !h.includes("*") && !h.includes("?"));
      continue;
    }
    if (current.length === 0) continue;
    if (new RegExp(`^remoteforward\\s+(?:\\S+:)?${port}\\b`, "i").test(line)) {
      for (const h of current) if (!hosts.includes(h)) hosts.push(h);
      current = [];
    }
  }
  return hosts;
}

export function defaultPairDeps(): PairDeps {
  return {
    ssh: (host, command, input) => {
      try {
        const out = execFileSync("ssh", ["-o", "BatchMode=yes", host, command], {
          encoding: "utf8",
          timeout: 30_000,
          ...(input === undefined ? {} : { input }),
          stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
        });
        return { ok: true, out: out.trim() };
      } catch (err) {
        const e = err as { stderr?: Buffer | string; message?: string };
        const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString();
        return { ok: false, out: (stderr || e.message || "ssh failed").trim() };
      }
    },
    readSshConfig: () => {
      const path = sshConfigPath();
      return existsSync(path) ? readFileSync(path, "utf8") : "";
    },
    appendSshConfig: (block) => {
      const path = sshConfigPath();
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
      appendFileSync(path, block);
    },
    log: (line) => process.stdout.write(`${line}\n`),
    confirm: () => false, // callers that can prompt override this
  };
}

export interface PairResult {
  ok: boolean;
  /** Everything that changed, so the user can undo it if they want to. */
  changed: string[];
}

export function pair(opts: PairOptions, deps: PairDeps = defaultPairDeps()): PairResult {
  const { host, notifyPort, token } = opts;
  const changed: string[] = [];
  const step = (label: string, detail: string): void => deps.log(`  ${label.padEnd(28)} ${detail}`);

  // 1 — reachability, before anything is changed anywhere.
  const probe = deps.ssh(host, "echo ok");
  if (!probe.ok || probe.out !== "ok") {
    deps.log(`cannot reach ${host} over ssh:`);
    deps.log(`  ${probe.out}`);
    deps.log("");
    deps.log("`astir pair` uses your existing ssh access — fix the connection first");
    deps.log("(agent forwarding, key, or Host entry), then run it again.");
    return { ok: false, changed };
  }
  step("ssh", "ok");

  // 2 — is astir even there? Pairing a machine that cannot run the daemon would
  // produce a setup that looks complete and delivers nothing.
  const remote = deps.ssh(host, "command -v astir >/dev/null 2>&1 && astir --version || echo MISSING");
  if (remote.out.includes("MISSING") || !remote.ok) {
    step("astir on remote", "NOT FOUND");
    deps.log("");
    deps.log(`Install astir on ${host} first — pairing without it would configure a`);
    deps.log("path that silently carries nothing.");
    return { ok: false, changed };
  }
  step("astir on remote", remote.out.split("\n")[0] ?? "present");

  // 3 — the shared secret. Written by shell redirection rather than scp so it
  // works on hosts without scp, and chmod'd in the same command so it is never
  // briefly world-readable.
  const put = deps.ssh(
    host,
    "mkdir -p ~/.astir && cat > ~/.astir/token && chmod 600 ~/.astir/token && echo stored",
    token,
  );
  if (!put.ok || !put.out.includes("stored")) {
    step("token", `FAILED — ${put.out}`);
    return { ok: false, changed };
  }
  step("token", "copied to ~/.astir/token (0600)");
  changed.push(`${host}:~/.astir/token`);

  // 4 — the forward. This is the part that turns "works once" into "works every
  // time you ssh in", and the only thing touching a file the user owns.
  const config = deps.readSshConfig();
  if (alreadyForwards(config, host, notifyPort)) {
    step("ssh config", "already forwards this port");
  } else {
    const block = forwardBlock(host, notifyPort);
    if (opts.dryRun === true) {
      deps.log("");
      deps.log(`Add to ${sshConfigPath()}:`);
      deps.log(block.replace(/^/gm, "  "));
    } else if (deps.confirm(`Append a RemoteForward for ${host} to ${sshConfigPath()}?`)) {
      deps.appendSshConfig(block);
      step("ssh config", `RemoteForward ${notifyPort} added`);
      changed.push(sshConfigPath());
    } else {
      step("ssh config", "declined — add this yourself:");
      deps.log(block.replace(/^/gm, "    "));
    }
  }

  deps.log("");
  deps.log(`${host} is paired.`);
  deps.log("");
  deps.log("  Run `astir notifier` here, then ssh over as you normally would.");
  deps.log(`  \`astir daemon\` on ${host} will find this machine by itself — no flags.`);
  deps.log("");
  deps.log("  Verify with:  ssh " + host + " astir doctor --notify");
  return { ok: true, changed };
}
