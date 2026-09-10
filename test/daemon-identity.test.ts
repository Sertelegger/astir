/**
 * A port that answers is not proof of what is behind it.
 *
 * The notifier has refused anything not reporting its role since it was
 * written. The daemon had no such check, so nothing could tell THIS machine's
 * daemon from another machine's reached through a forwarded port — and because
 * `astir pair` copies one token to both machines, that impostor authenticates
 * cleanly and its sessions render as local. The dangerous case is not an
 * unreachable port; it is a perfectly valid reply from the wrong machine.
 */

import { hostname } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeDaemon } from "../src/daemon/detect.js";
import { fetchStatus } from "../src/status/fetch.js";

const TOKEN = "t".repeat(48);
const SELF = hostname();

function stub(status: number, body: unknown): void {
  vi.stubEnv("ASTIR_TOKEN", TOKEN);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("fetchStatus refuses another machine's daemon", () => {
  it("rejects a valid reply that came from somewhere else", async () => {
    // The whole point. Status 200, correct shape, right token — and every
    // session in it belongs to a different computer.
    stub(200, { blockedCount: 0, sessions: [], host: "some-other-box" });
    const r = await fetchStatus(47_000);
    expect(r.ok).toBe(false);
    // The reason has to name the machine, or the user cannot act on it.
    expect(r.ok === false && r.reason).toContain("some-other-box");
  });

  it("accepts this machine's own daemon", async () => {
    stub(200, { blockedCount: 0, sessions: [], host: SELF });
    const r = await fetchStatus(47_000);
    expect(r.ok).toBe(true);
  });

  it("accepts a daemon that says nothing about its host", async () => {
    // VER-01 — an unknown minor is ignored field-wise, not rejected. An older
    // daemon sends no host, and "cannot tell" must not read as "wrong machine"
    // or upgrading the CLI first would blank every surface.
    stub(200, { blockedCount: 0, sessions: [] });
    const r = await fetchStatus(47_000);
    expect(r.ok).toBe(true);
  });

  it("compares on the first label, so a FQDN is still this machine", async () => {
    // macOS reports `name.local`; a raw comparison would call the machine
    // someone else's and refuse its own daemon.
    stub(200, { blockedCount: 0, sessions: [], host: `${SELF}.local` });
    const r = await fetchStatus(47_000);
    expect(r.ok).toBe(true);
  });

  it("still reports an unreachable daemon as unreachable", async () => {
    vi.stubEnv("ASTIR_TOKEN", TOKEN);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const r = await fetchStatus(47_000);
    expect(r.ok === false && r.reason).toContain("no daemon");
  });
});

describe("probeDaemon says what is actually on the port", () => {
  it("recognises this machine's daemon", async () => {
    stub(200, { ok: true, role: "daemon", host: SELF });
    expect(await probeDaemon(47_000)).toEqual({ kind: "mine", host: SELF.split(".")[0] });
  });

  it("names another machine's daemon rather than calling it broken", async () => {
    // The diagnosis a user can act on: not "unreachable", which would send them
    // to restart a daemon that is running perfectly.
    stub(200, { ok: true, role: "daemon", host: "megabrain-dev" });
    expect(await probeDaemon(47_000)).toEqual({ kind: "foreign", host: "megabrain-dev" });
  });

  it("does not claim to know what a roleless answer is", async () => {
    // Something else on the port, OR a daemon too old to say. Both are "cannot
    // tell", and guessing hostile would be as wrong as guessing friendly.
    stub(200, { ok: true, counters: {} });
    expect((await probeDaemon(47_000)).kind).toBe("unknown");
  });

  it("does not accept a roleless answer even when it names THIS machine", async () => {
    // The fixture above has no role AND no host, so it is refused by the host
    // check whether or not the role check exists — it cannot tell the two
    // reasons apart, and a mutation removing the role check survived it. This
    // one carries a perfectly good host and no role, so only the role check
    // stands between it and being trusted.
    stub(200, { ok: true, host: SELF, counters: {} });
    expect((await probeDaemon(47_000)).kind).toBe("unknown");
  });

  it("treats a daemon with no host as unknown, not as mine", async () => {
    // Failing OPEN here is the trap: assuming an unidentified daemon is local
    // is exactly the assumption this exists to remove.
    stub(200, { ok: true, role: "daemon" });
    expect((await probeDaemon(47_000)).kind).toBe("unknown");
  });

  it("reports nothing listening as absent, which is the ordinary case", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    expect((await probeDaemon(47_000)).kind).toBe("absent");
  });
});
