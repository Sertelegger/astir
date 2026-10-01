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

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(d.received[0]?.body).toEqual(capture.events.SessionStart);
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

  it("SEC-01 — strips the prompt, the model's reply and the tool's output before sending", async () => {
    const d = await fakeDaemon();
    const payload = {
      ...capture.events.Stop,
      prompt: "a prompt",
      tool_response: "a file's contents",
    };
    expect(payload).toHaveProperty("last_assistant_message");
    await relay(JSON.stringify(payload), envFor(home(), d.port));

    const sent = d.received[0]?.body ?? {};
    expect(sent).not.toHaveProperty("prompt");
    expect(sent).not.toHaveProperty("last_assistant_message");
    expect(sent).not.toHaveProperty("tool_response");
    // Everything the adapter reads survives.
    expect(sent.session_id).toBe(capture.events.Stop?.session_id);
    expect(sent.hook_event_name).toBe("Stop");
  });

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
