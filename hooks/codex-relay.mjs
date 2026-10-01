#!/usr/bin/env node
/**
 * Codex → astir. One hook payload in on stdin, one POST to the daemon out.
 *
 * Claude Code can POST a hook itself (`type: "http"`); Codex runs command hooks
 * only, so this is the http hook Codex does not have. It is plain JavaScript
 * with no imports beyond Node's own, because it runs from the plugin checkout
 * and must not depend on `dist/` having been built.
 *
 * ## Three rules
 *
 * **Never fail the session.** Every path exits 0 and prints nothing. Codex
 * reads a hook's stdout — a `PermissionRequest` hook's output can be taken as
 * the DECISION — so this file writes nothing there, ever.
 *
 * **Never stall it.** Codex hooks are synchronous. The request is bounded, and
 * a backstop timer ends the process even if a socket hangs in a way the request
 * timeout does not cover.
 *
 * **SEC-01 starts here.** The prompt, the model's reply and the tool's output
 * are stripped before anything is sent. The adapter never reads them either;
 * not sending them means they are never even in the daemon's memory. It also
 * keeps a large command output from breaching the daemon's body limit, which
 * would lose the event that says the tool finished.
 */

import { readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

/** Content, not activity. See SEC-01 above. */
const STRIP = ["prompt", "last_assistant_message", "tool_response"];
const TIMEOUT_MS = 2_000;

setTimeout(() => process.exit(0), TIMEOUT_MS + 500).unref();

/** The same order every other astir client uses: the environment, then the file. */
function token() {
  if (process.env.ASTIR_TOKEN) return process.env.ASTIR_TOKEN;
  try {
    const t = readFileSync(join(homedir(), ".astir", "token"), "utf8").trim();
    return t.length >= 32 ? t : null;
  } catch {
    return null;
  }
}

function relay() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return;
  for (const key of STRIP) delete payload[key];

  const bearer = token();
  // No token means no daemon was ever set up on this machine. Sending anyway
  // would only add to its unauthorized count, if there were one.
  if (bearer === null) return;

  const body = JSON.stringify(payload);
  const req = request({
    host: "127.0.0.1",
    port: Number(process.env.ASTIR_PORT) || 47000,
    path: "/hook/codex",
    method: "POST",
    timeout: TIMEOUT_MS,
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
  });
  req.on("response", (res) => res.resume());
  req.on("timeout", () => req.destroy());
  // A daemon that is down refuses at once. That is the normal state between
  // sessions, not an error worth anyone's attention.
  req.on("error", () => {});
  req.end(body);
}

try {
  relay();
} catch {
  // See "Never fail the session".
}
