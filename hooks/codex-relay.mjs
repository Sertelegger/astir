#!/usr/bin/env node
/**
 * Codex → astir. One hook payload in on stdin, one POST to the daemon out.
 *
 * Claude Code can POST a hook itself (`type: "http"`); Codex runs command hooks
 * only, so this is the http hook Codex does not have. It is plain JavaScript
 * with no imports beyond Node's own, because it runs from the plugin checkout
 * and must not depend on `dist/` having been built.
 *
 * ## Rules
 *
 * **Never fail the session, never print.** Codex reads a hook's output. Exit 2
 * with stderr DENIES a `PermissionRequest`, BLOCKS a `PreToolUse`, REPLACES a
 * tool's result in `PostToolUse` and re-prompts the model from `Stop`; stdout
 * from `SessionStart` becomes model context. So every path exits 0 and writes
 * nothing, and the hook command adds `2>/dev/null || true` for the case where
 * this file is not even there to run.
 *
 * **Never stall it.** Codex hooks are synchronous, so the whole process has one
 * budget and ends when it runs out — whatever the socket is doing. Reads are
 * async so the budget covers them too: a synchronous read of a stdin that never
 * closes would block the very timer meant to end it.
 *
 * **Send only what the adapter reads (SEC-01).** An allowlist, not a denylist:
 * the ids, the event, the cwd, the tool's name, and from its input only the
 * path arguments and an `apply_patch`'s directive lines. Command text, patch
 * bodies, the prompt and the model's reply never leave Codex. That also keeps a
 * large patch from breaching the daemon's 1 MiB body limit, which used to lose
 * the very `PermissionRequest` that rode with it.
 *
 * **Say which process this is.** Codex has no session listing, so the daemon
 * cannot ask whether a session is still alive. On the events where that matters
 * the relay finds the Codex process it runs under and sends its pid; the daemon
 * watches that pid instead.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUDGET_MS = 2_000;

/** Top-level fields the adapter reads. Everything else stays in Codex. */
const KEEP = ["session_id", "hook_event_name", "cwd", "tool_name", "agent_id", "agent_type"];
/** The path arguments CAP-03 keeps from any tool's input. */
const PATH_KEYS = ["file_path", "notebook_path", "path"];
/**
 * Where liveness is decided: a session appearing, blocking, or ending a turn.
 * Not the per-tool events, which are the hot path and would pay for a
 * process-table read on every call.
 */
const PID_EVENTS = new Set(["SessionStart", "PermissionRequest", "Stop", "Interrupt"]);

/** The payload, cut down to what the adapter reads. */
export function reduce(payload) {
  const out = {};
  for (const key of KEEP) if (key in payload) out[key] = payload[key];
  const input = payload.tool_input;
  if (input !== null && typeof input === "object") {
    const kept = {};
    for (const key of PATH_KEYS) if (typeof input[key] === "string") kept[key] = input[key];
    // A directive line names a file and nothing else. Every line of content in
    // a patch starts with `+`, `-` or a space, so none can pass this.
    if (payload.tool_name === "apply_patch" && typeof input.command === "string") {
      kept.command = input.command
        .split("\n")
        .filter((line) => line.startsWith("*** "))
        .join("\n");
    }
    out.tool_input = kept;
  }
  return out;
}

/** The same order every other astir client uses: the environment, then the file. */
async function token() {
  if (process.env.ASTIR_TOKEN) return process.env.ASTIR_TOKEN;
  try {
    const t = (await readFile(join(homedir(), ".astir", "token"), "utf8")).trim();
    return t.length >= 32 ? t : null;
  } catch {
    return null;
  }
}

/** Decimal and in range, or the default. `Number("0x50")` is port 80. */
function port() {
  const raw = process.env.ASTIR_PORT ?? "";
  const n = /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
  return n >= 1 && n <= 65_535 ? n : 47_000;
}

/**
 * The nearest ancestor named `codex`: the native binary this session lives in.
 *
 * Codex spawns a hook as `<shell> -c <command>` directly from that binary, and
 * the command starts a shell that starts this, so it is a few levels up. (An
 * npm install's `node` shim sits ABOVE it, so it is never reached first.) One
 * process-table read rather than one per level; null when there is nothing to
 * find, which the daemon handles as "no liveness signal".
 */
function codexPid() {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,comm="], { timeout: 1_000 }, (err, stdout) => {
      if (err) return resolve(null);
      const parent = new Map();
      const name = new Map();
      for (const line of stdout.split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        if (m === null) continue;
        parent.set(Number(m[1]), Number(m[2]));
        // macOS reports the executable's path, Linux its name.
        name.set(Number(m[1]), basename(m[3]));
      }
      let pid = process.ppid;
      for (let depth = 0; depth < 8 && pid > 1; depth++) {
        if (name.get(pid) === "codex") return resolve(pid);
        pid = parent.get(pid) ?? 0;
      }
      resolve(null);
    });
  });
}

async function stdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function relay() {
  let payload;
  try {
    payload = JSON.parse(await stdin());
  } catch {
    return;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return;

  const bearer = await token();
  // No token means no daemon was ever set up on this machine. Sending anyway
  // would only add to its unauthorized count, if there were one.
  if (bearer === null) return;

  const pid = PID_EVENTS.has(payload.hook_event_name) ? await codexPid() : null;
  const body = JSON.stringify(reduce(payload));
  const req = request({
    host: "127.0.0.1",
    port: port(),
    path: "/hook/codex",
    method: "POST",
    // Never through a proxy. Node honours HTTP_PROXY when NODE_USE_ENV_PROXY
    // is set, and `NO_PROXY=localhost` does not exempt 127.0.0.1 — so the
    // token would go to whoever runs the proxy.
    agent: false,
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      ...(pid === null ? {} : { "x-astir-agent-pid": String(pid) }),
    },
  });
  req.on("response", (res) => res.resume());
  // A daemon that is down refuses at once. That is the normal state between
  // sessions, not an error worth anyone's attention.
  req.on("error", () => {});
  req.end(body);
}

// Run only when executed, so the tests can import `reduce` without sending.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Unref'd, so a relay that finishes early is not kept alive waiting for it.
  setTimeout(() => process.exit(0), BUDGET_MS).unref();
  relay().catch(() => {});
}
