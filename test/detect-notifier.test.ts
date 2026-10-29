/**
 * #82 — the probe says WHICH nothing it found.
 *
 * Seen on megabrain with the Mac disconnected: a connection to
 * 127.0.0.1:47001 was accepted and never answered (`curl -m 3` exit 28), held
 * by an `ssh -R` forward from a session that had dropped. Every layer reported
 * it as "no tunnel", which sends you to set one up — when the fix is to end the
 * session holding the port, and a new tunnel could not even bind until then.
 *
 * Every case here is a real socket, because what is being pinned is what
 * undici makes of each far end; a mock would test the mock's idea of it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { describeNotifier } from "../src/config/plugin.js";
import { classifyProbeFailure, detectNotifier, PROBE_REASON, probeReason } from "../src/notify/detect.js";
import { NotifierServer } from "../src/notify/server.js";
import { closedPort, type Far, garbageOn, hangUpOn, httpOn, resetOn, silentOn } from "./fixtures/sockets.js";

/** Short, so the silent case does not cost the daemon's 1.5s per test. */
const QUICK = 200;

const open: Far[] = [];
afterEach(async () => {
  for (const far of open.splice(0)) await far.close();
});
const held = async (far: Promise<Far>): Promise<Far> => {
  const f = await far;
  open.push(f);
  return f;
};

describe("detectNotifier tells a closed port from a silent one", () => {
  it("calls a refused connection `refused` — no tunnel, as before", async () => {
    const port = await closedPort();
    expect(await detectNotifier(port, QUICK)).toEqual({
      found: false,
      url: `http://127.0.0.1:${port}/notify`,
      failure: "refused",
      reason: "no tunnel",
    });
  });

  it("calls a connection accepted and never answered `silent`, with its own reason", async () => {
    const { port } = await held(silentOn());
    const got = await detectNotifier(port, QUICK);
    expect(got).toEqual({
      found: false,
      url: `http://127.0.0.1:${port}/notify`,
      failure: "silent",
      reason: PROBE_REASON.silent,
    });
    expect(got.reason).not.toContain("no tunnel");
  });

  it("waits only its own timeout on a silent port", async () => {
    const { port } = await held(silentOn());
    const started = Date.now();
    await detectNotifier(port, QUICK);
    expect(Date.now() - started).toBeLessThan(QUICK + 1_000);
  });

  it("still finds a real notifier", async () => {
    const server = new NotifierServer({ token: "n".repeat(48), notify: () => undefined });
    const port = await server.listen(0);
    try {
      const got = await detectNotifier(port, QUICK);
      expect(got).toMatchObject({ found: true, url: `http://127.0.0.1:${port}/notify` });
      expect(got.failure).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("calls a peer that hangs up without answering `closed`, and not a missing tunnel", async () => {
    // An `ssh -R` whose far end has nothing listening: the client refuses the
    // channel and sshd closes the connection it accepted.
    const { port } = await held(hangUpOn());
    const got = await detectNotifier(port, QUICK);
    expect(got).toMatchObject({ found: false, failure: "closed", reason: PROBE_REASON.closed });
  });

  it("calls a peer that resets the connection `closed` too", async () => {
    // RST rather than FIN: undici says ECONNRESET, not "other side closed".
    const { port } = await held(resetOn());
    const got = await detectNotifier(port, QUICK);
    expect(got).toMatchObject({ found: false, failure: "closed", reason: PROBE_REASON.closed });
  });

  it("calls a peer that does not speak HTTP `other`, naming only the error's code", async () => {
    const { port } = await held(garbageOn());
    const got = await detectNotifier(port, QUICK);
    expect(got.failure).toBe("other");
    expect(got.reason).toMatch(/^probe failed \(HPE_[A-Z_]+\)$/);
    expect(got.reason).not.toContain("SSH-2.0");
  });

  it("does not call a peer that answered and then stalled `silent`", async () => {
    // The headers arrived, so something answered: the deadline then passes
    // while the BODY is read, and that must not get the stale-forward remedy.
    const { port } = await held(
      httpOn((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"role":');
      }),
    );
    const got = await detectNotifier(port, QUICK);
    expect(got.found).toBe(false);
    expect(got.failure).toBeUndefined();
    expect(got.reason).toBe(PROBE_REASON.notNotifier);
  });

  it("calls something else answering `something else`, with no failure kind", async () => {
    const { port } = await held(
      httpOn((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true,"role":"daemon"}');
      }),
    );
    const got = await detectNotifier(port, QUICK);
    expect(got).toEqual({
      found: false,
      url: `http://127.0.0.1:${port}/notify`,
      reason: PROBE_REASON.notNotifier,
    });
  });
});

describe("classifyProbeFailure, on what fetch really throws", () => {
  it("does not read a caller's abort as silence — that says nothing about the far end", async () => {
    const { port } = await held(silentOn());
    const ac = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/healthz`, { signal: ac.signal });
    ac.abort();
    const err = await pending.catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
    expect(classifyProbeFailure(err)).toBe("other");
  });

  it("reads the request's own deadline on an accepting port as silence", async () => {
    const { port } = await held(silentOn());
    const err = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(50) }).catch(
      (e: unknown) => e,
    );
    expect(classifyProbeFailure(err)).toBe("silent");
  });

  it("reads a reset as a hang-up", async () => {
    const { port } = await held(resetOn());
    const err = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(QUICK) }).catch(
      (e: unknown) => e,
    );
    expect((err as { cause?: { code?: unknown } }).cause?.code).toBe("ECONNRESET");
    expect(classifyProbeFailure(err)).toBe("closed");
  });

  it("reads ECONNREFUSED as refused", async () => {
    const port = await closedPort();
    const err = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(QUICK) }).catch(
      (e: unknown) => e,
    );
    expect(classifyProbeFailure(err)).toBe("refused");
  });
});

describe("probeReason never prints what came off the socket", () => {
  // The reason goes into the daemon's log and doctor's output. undici's codes
  // are constants, so this is a guard on a promise, fed what no real socket
  // here can produce.
  it("names a code that looks like one", () => {
    expect(probeReason("other", { cause: { code: "HPE_INVALID_CONSTANT" } })).toBe(
      "probe failed (HPE_INVALID_CONSTANT)",
    );
  });

  it("leaves out a code that does not", () => {
    for (const code of ["bad\ncode", "#[fg=red]x", "hpe_lower", `E${"X".repeat(40)}`, 42]) {
      expect(probeReason("other", { cause: { code } })).toBe("probe failed");
    }
    expect(probeReason("other", new Error("boom"))).toBe("probe failed");
  });
});

describe("doctor, from a real probe", () => {
  it("gives a silent port on a machine that does not serve it the stale forward first, and how to find it", async () => {
    // megabrain: no notifier of its own, nothing paired from it — 47001 is
    // most likely an `ssh -R` forward in. Most likely, not surely: `local` is
    // read off ~/.ssh/config alone, so the notifier cause stays on the list.
    const { port } = await held(silentOn());
    const out = describeNotifier(await detectNotifier(port, QUICK), false, null, {
      local: false,
      platform: "linux",
    }).join("\n");
    expect(out).toContain(`127.0.0.1:${port}`);
    expect(out).toContain("did not answer in time");
    expect(out).toContain(`\`sudo ss -ltnp 'sport = :${port}'\``);
    expect(out).toContain("ClientAliveInterval 30");
    expect(out).toContain("stop the `astir notifier` you started");
    expect(out.indexOf("`sshd`")).toBeLessThan(out.indexOf("`node`"));
    expect(out).not.toContain("astir autostart");
    expect(out).not.toContain("astir pair");
    expect(out).not.toContain("no tunnel");
  });

  it("gives a silent port held by the notifier service on a Mac the restart, not sshd's", async () => {
    // Its service is installed, so the port is that service's, and `astir
    // autostart` boots it out and back in.
    const { port } = await held(silentOn());
    const out = describeNotifier(await detectNotifier(port, QUICK), true, null, { platform: "darwin" }).join(
      "\n",
    );
    expect(out).toContain(`127.0.0.1:${port}`);
    expect(out).toContain("hung");
    expect(out).toContain("astir autostart");
    expect(out).toContain("~/.astir/notifier.log");
    expect(out).not.toContain("ssh -R");
    expect(out).not.toContain("sshd");
    expect(out).not.toContain("astir pair");
  });

  it("gives a silent port held by a notifier started by hand the restart of what was started", async () => {
    // Paired, so local, but never a service: `astir autostart` would neither
    // stop it nor bind past it, and there is no notifier.log.
    const { port } = await held(silentOn());
    const out = describeNotifier(await detectNotifier(port, QUICK), false, null, {
      local: true,
      platform: "darwin",
    }).join("\n");
    expect(out).toContain("the notifier on this machine has most likely hung");
    expect(out).toContain("stop the `astir notifier` you started and start it again");
    expect(out).toContain(`\`sudo lsof -iTCP:${port} -sTCP:LISTEN\``);
    expect(out.indexOf("`node`")).toBeLessThan(out.indexOf("`sshd`"));
    expect(out).not.toContain("astir autostart");
    expect(out).not.toContain("notifier.log");
    expect(out).not.toContain("astir pair");
  });

  it("gives a hang-up the far end's remedy, never 'set up a tunnel'", async () => {
    const { port } = await held(hangUpOn());
    const out = describeNotifier(await detectNotifier(port, QUICK), false, null).join("\n");
    expect(out).toContain(PROBE_REASON.closed);
    expect(out).toContain("the tunnel is up");
    expect(out).not.toContain("astir pair");
    expect(out).not.toContain("ClientAliveInterval");
  });

  it("gives a closed port the setup advice, as before", async () => {
    const out = describeNotifier(await detectNotifier(await closedPort(), QUICK), true, null).join("\n");
    expect(out).toContain("no tunnel");
    expect(out).toContain("astir pair");
    expect(out).not.toContain("ClientAliveInterval");
  });
});
