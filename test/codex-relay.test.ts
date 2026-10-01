/**
 * The relay is the http hook Codex does not have — and it runs inside every
 * Codex tool call, synchronously. So the properties that matter are the ones a
 * user would feel: it never fails the session, never stalls it, never prints,
 * and never sends content astir has no business holding (SEC-01).
 *
 * Spawned for real, against a real socket. A unit test of its functions would
 * miss exactly the failures that matter here: a process that does not exit, or
 * a stray byte on stdout.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeCodexHook } from "../src/adapters/codex/normalize.js";
import { Daemon } from "../src/daemon/server.js";
import { Registry } from "../src/model/registry.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELAY = join(root, "hooks", "codex-relay.mjs");
const TOKEN = "f".repeat(64);
const capture = JSON.parse(readFileSync(join(root, "test", "fixtures", "codex", "capture.json"), "utf8")) as {
  events: Record<string, Record<string, unknown>>;
  permissionSequence: Array<{ payload: Record<string, unknown> }>;
};

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

/** A home with `.astir/token`, or with nothing when `token` is null. */
function home(token: string | null = TOKEN): string {
  const dir = mkdtempSync(join(tmpdir(), "astir-relay-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  if (token !== null) {
    mkdirSync(join(dir, ".astir"));
    writeFileSync(join(dir, ".astir", "token"), `${token}\n`);
  }
  return dir;
}

interface Received {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  pid: string | undefined;
  body: Record<string, unknown>;
}

async function listen(handler: (req: IncomingMessage, body: string) => void): Promise<number> {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      handler(req, body);
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise((r) => server.close(r)));
  return (server.address() as AddressInfo).port;
}

async function fakeDaemon(): Promise<{ port: number; received: Received[] }> {
  const received: Received[] = [];
  const port = await listen((req, body) => {
    received.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      pid: req.headers["x-astir-agent-pid"] as string | undefined,
      body: JSON.parse(body) as Record<string, unknown>,
    });
  });
  return { port, received };
}

/** A port nothing is listening on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  await new Promise((r) => server.close(r));
  return port;
}

async function relay(
  stdin: string,
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  const started = Date.now();
  const { ASTIR_TOKEN: _drop, ...inherited } = process.env;
  const child = spawn(process.execPath, [RELAY], { env: { ...inherited, ...env }, stdio: "pipe" });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => {
    stdout += c;
  });
  child.stderr.on("data", (c) => {
    stderr += c;
  });
  child.stdin.end(stdin);
  const code = await new Promise<number | null>((r) => child.on("close", r));
  return { code, stdout, stderr, ms: Date.now() - started };
}

const envFor = (dir: string, port: number) => ({ HOME: dir, USERPROFILE: dir, ASTIR_PORT: String(port) });

describe("the Codex relay", () => {
  it("POSTs the payload to /hook/codex with the token from ~/.astir/token", async () => {
    const d = await fakeDaemon();
    const r = await relay(JSON.stringify(capture.events.SessionStart), envFor(home(), d.port));

    expect(r.code).toBe(0);
    expect(d.received).toHaveLength(1);
    expect(d.received[0]?.method).toBe("POST");
    expect(d.received[0]?.url).toBe("/hook/codex");
    expect(d.received[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    const start = capture.events.SessionStart ?? {};
    expect(d.received[0]?.body).toEqual({
      session_id: start.session_id,
      hook_event_name: "SessionStart",
      cwd: start.cwd,
    });
  });

  it("prefers $ASTIR_TOKEN, as every other astir client does", async () => {
    const d = await fakeDaemon();
    const other = "e".repeat(64);
    await relay(JSON.stringify(capture.events.SessionStart), {
      ...envFor(home(), d.port),
      ASTIR_TOKEN: other,
    });
    expect(d.received[0]?.authorization).toBe(`Bearer ${other}`);
  });

  it("SEC-01 — sends no content: not the prompt, the reply, a command, a patch body or a tool's output", async () => {
    // An allowlist. The capture's markers stand in for the real text, so
    // finding one on the wire is finding content on the wire.
    const d = await fakeDaemon();
    const payloads = [
      { ...capture.events.Stop, prompt: "<redacted: x>", tool_response: "<redacted: y>" },
      capture.events["PreToolUse:Bash"],
      capture.events["PostToolUse:apply_patch"],
      capture.permissionSequence[0]?.payload,
    ];
    for (const p of payloads) await relay(JSON.stringify(p), envFor(home(), d.port));

    expect(d.received).toHaveLength(payloads.length);
    for (const r of d.received) expect(JSON.stringify(r.body)).not.toContain("<redacted");
  });

  it("sends everything the adapter reads: the same event comes out either way", async () => {
    // The allowlist's other edge. Cutting a field the adapter needs would not
    // fail loudly — the event would just quietly lose its paths or its agent.
    const declared = JSON.parse(
      readFileSync(join(root, "test", "fixtures", "codex", "declared.json"), "utf8"),
    ) as {
      events: Record<string, Record<string, unknown>>;
    };
    const all = [
      ...Object.values(capture.events),
      ...capture.permissionSequence.map((s) => s.payload),
      ...Object.values(declared.events),
    ];
    const d = await fakeDaemon();
    const dir = home();
    for (const p of all) await relay(JSON.stringify(p), envFor(dir, d.port));

    const deps = { readSidecar: () => null, newId: () => "e", realpath: (x: string) => x, now: () => 1 };
    expect(d.received).toHaveLength(all.length);
    all.forEach((full, i) => {
      expect(normalizeCodexHook(d.received[i]?.body, deps), String(full.hook_event_name)).toEqual(
        normalizeCodexHook(full, deps),
      );
    });
  });

  it("delivers a permission riding with a patch too big for the daemon's body limit", async () => {
    // It used to forward the whole patch, so a large generated file breached
    // 1 MiB and the PermissionRequest that came with it was rejected — the one
    // event this product exists to deliver.
    const registry = new Registry({ nowMs: () => 1_000 });
    const daemon = new Daemon({ token: TOKEN, registry });
    cleanup.push(() => daemon.close());
    const port = await daemon.listen(0);
    const request = capture.permissionSequence[1]?.payload ?? {};
    const huge = `*** Begin Patch\n*** Add File: /home/user/repo/big.txt\n${"+x\n".repeat(600_000)}*** End Patch\n`;
    const r = await relay(
      JSON.stringify({ ...request, tool_name: "apply_patch", tool_input: { command: huge } }),
      envFor(home(), port),
    );

    expect(r.code).toBe(0);
    expect(registry.blockedAgents()).toHaveLength(1);
  });

  it("never sends the token through a proxy", async () => {
    // Node honours HTTP_PROXY when NODE_USE_ENV_PROXY is set, and
    // NO_PROXY=localhost does not cover 127.0.0.1.
    const d = await fakeDaemon();
    const proxied: string[] = [];
    const proxy = await listen((req) => {
      proxied.push(String(req.headers.authorization));
    });
    await relay(JSON.stringify(capture.events.SessionStart), {
      ...envFor(home(), d.port),
      NODE_USE_ENV_PROXY: "1",
      HTTP_PROXY: `http://127.0.0.1:${proxy}`,
      http_proxy: `http://127.0.0.1:${proxy}`,
      NO_PROXY: "localhost",
    });
    expect(proxied).toEqual([]);
    expect(d.received).toHaveLength(1);
  });

  it("ends within budget even if stdin never closes", async () => {
    // A synchronous read would block the timer meant to end it.
    const started = Date.now();
    const { ASTIR_TOKEN: _drop, ...inherited } = process.env;
    const child = spawn(process.execPath, [RELAY], {
      env: { ...inherited, ...envFor(home(), await closedPort()) },
      stdio: "pipe",
    });
    const code = await new Promise<number | null>((r) => child.on("close", r));
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 10_000);

  it("never prints — a PermissionRequest hook's stdout can be read as the decision", async () => {
    const d = await fakeDaemon();
    const request = capture.permissionSequence[1]?.payload;
    const r = await relay(JSON.stringify(request), envFor(home(), d.port));
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(d.received).toHaveLength(1);
  });

  it("exits 0, silently and at once, when no daemon is listening", async () => {
    // The normal state between sessions. Every tool call would otherwise raise
    // an error in the session the user is working in.
    const r = await relay(JSON.stringify(capture.events.SessionStart), envFor(home(), await closedPort()));
    expect(r).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(r.ms).toBeLessThan(2_000);
  });

  it("gives up on a daemon that accepts and never answers, instead of stalling Codex", async () => {
    const server = createServer(() => {
      // Never respond.
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanup.push(() => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    });
    const { port } = server.address() as AddressInfo;

    const r = await relay(JSON.stringify(capture.events.SessionStart), envFor(home(), port));
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(r.ms).toBeLessThan(4_000);
  }, 10_000);

  it("gives up on a daemon that trickles a response forever", async () => {
    // Never idle, so a socket timeout would never fire. Only a budget on the
    // whole process ends this one.
    const server = createServer((_req, res) => {
      res.writeHead(200);
      const tick = setInterval(() => res.write(" "), 200);
      res.on("close", () => clearInterval(tick));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanup.push(() => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    });
    const { port } = server.address() as AddressInfo;

    const r = await relay(JSON.stringify(capture.events.SessionStart), envFor(home(), port));
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(r.ms).toBeLessThan(4_000);
  }, 10_000);

  it("sends nothing for input that is not a JSON object", async () => {
    const d = await fakeDaemon();
    for (const stdin of ["", "not json", "[1,2]", "null", "3"]) {
      const r = await relay(stdin, envFor(home(), d.port));
      expect(r).toMatchObject({ code: 0, stdout: "" });
    }
    expect(d.received).toEqual([]);
  });

  it("does not send a token too short to be one, as readTokenIfPresent refuses it", async () => {
    // A truncated or hand-edited file would only add to the daemon's
    // unauthorized count, which `astir doctor` then reports as a wiring fault.
    const d = await fakeDaemon();
    const r = await relay(JSON.stringify(capture.events.SessionStart), envFor(home("short"), d.port));
    expect(r.code).toBe(0);
    expect(d.received).toEqual([]);
  });

  it("sends nothing when this machine has no token at all", async () => {
    const d = await fakeDaemon();
    const r = await relay(JSON.stringify(capture.events.SessionStart), envFor(home(null), d.port));
    expect(r.code).toBe(0);
    expect(d.received).toEqual([]);
  });

  it("delivers a captured permission end to end: relay → daemon → a blocked Codex agent", async () => {
    const registry = new Registry({ nowMs: () => 1_000 });
    const daemon = new Daemon({ token: TOKEN, registry });
    cleanup.push(() => daemon.close());
    const port = await daemon.listen(0);
    const dir = home();

    for (const step of capture.permissionSequence.slice(0, 2)) {
      expect((await relay(JSON.stringify(step.payload), envFor(dir, port))).code).toBe(0);
    }

    const blocked = registry.blockedAgents();
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.provider).toBe("codex");
    expect(blocked[0]?.sessionId).toBe(capture.permissionSequence[1]?.payload.session_id);
  });
});

describe("the relay says which Codex process it runs under", () => {
  /**
   * Codex has no session listing, so this pid is the daemon's only way to tell
   * a live session from a dead one. A process named `codex` stands in for the
   * real one: a symlink to node, which on Linux is named after the link.
   */
  const fake = join(tmpdir(), "astir-fake-codex", "codex");
  const named = (): boolean => {
    if (process.platform === "win32") return false;
    try {
      mkdirSync(dirname(fake), { recursive: true });
      try {
        symlinkSync(process.execPath, fake);
      } catch {
        // already there
      }
      const comm = execFileSync(
        fake,
        [
          "-e",
          "process.stdout.write(require('child_process').execFileSync('ps',['-o','comm=','-p',String(process.pid)]).toString())",
        ],
        { encoding: "utf8" },
      );
      return basename(comm.trim()) === "codex";
    } catch {
      return false;
    }
  };
  const canName = named();

  /** Run the relay as Codex would: a `codex` process, a shell, the wrapper. */
  async function underCodex(payload: unknown, env: Record<string, string>): Promise<number> {
    const script = `
      const { spawn } = require("child_process");
      const c = spawn("sh", ["-c", process.argv[1]], { stdio: ["pipe", "inherit", "inherit"] });
      c.stdin.end(process.argv[2]);
      c.on("close", () => process.stdout.write(String(process.pid)));
    `;
    const command = `sh "${join(root, "hooks", "codex-relay.sh")}" 2>/dev/null || true`;
    const { ASTIR_TOKEN: _drop, ...inherited } = process.env;
    // Async: a synchronous spawn would block this process's event loop, and
    // with it the fake daemon the relay is trying to reach.
    const child = spawn(fake, ["-e", script, command, JSON.stringify(payload)], {
      env: { ...inherited, ...env },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
    });
    await new Promise((r) => child.on("close", r));
    return Number(out.trim());
  }

  it.skipIf(!canName)("sends the codex pid on a PermissionRequest", async () => {
    const d = await fakeDaemon();
    const codexPid = await underCodex(capture.permissionSequence[1]?.payload, envFor(home(), d.port));
    expect(d.received[0]?.pid).toBe(String(codexPid));
  });

  it.skipIf(!canName)("does not pay for the process table on the per-tool hot path", async () => {
    const d = await fakeDaemon();
    await underCodex(capture.events["PreToolUse:Bash"], envFor(home(), d.port));
    expect(d.received).toHaveLength(1);
    expect(d.received[0]?.pid).toBeUndefined();
  });

  it("sends no pid when there is no codex process to find", async () => {
    const d = await fakeDaemon();
    await relay(JSON.stringify(capture.permissionSequence[1]?.payload), envFor(home(), d.port));
    expect(d.received).toHaveLength(1);
    expect(d.received[0]?.pid).toBeUndefined();
  });
});
