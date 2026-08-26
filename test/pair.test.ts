import { describe, expect, it } from "vitest";
import { alreadyForwards, forwardBlock, type PairDeps, pair } from "../src/cli/pair.js";

function deps(over: Partial<PairDeps> & { config?: string; remote?: Record<string, string> } = {}) {
  const log: string[] = [];
  const appended: string[] = [];
  const sshCalls: Array<{ command: string; input?: string }> = [];
  const d: PairDeps & { log_: string[]; appended: string[]; sshCalls: typeof sshCalls } = {
    log_: log,
    appended,
    sshCalls,
    ssh: (_host, command, input) => {
      sshCalls.push(input === undefined ? { command } : { command, input });
      if (command === "echo ok") return { ok: true, out: over.remote?.probe ?? "ok" };
      if (command.includes("command -v astir")) {
        return { ok: true, out: over.remote?.version ?? "astir 0.1.0" };
      }
      if (command.includes("~/.astir/token")) return { ok: true, out: over.remote?.token ?? "stored" };
      return { ok: true, out: "" };
    },
    readSshConfig: () => over.config ?? "",
    appendSshConfig: (b) => appended.push(b),
    log: (l) => log.push(l),
    confirm: () => true,
    ...over,
  };
  return d;
}

const opts = { host: "devbox", notifyPort: 47001, token: "s3cret" };

describe("ssh config detection", () => {
  it("finds an existing forward for the host", () => {
    const config = "Host devbox\n  RemoteForward 47001 127.0.0.1:47001\n";
    expect(alreadyForwards(config, "devbox", 47001)).toBe(true);
  });

  it("does not confuse a forward on a different host", () => {
    // Appending a duplicate Host stanza is not harmless: OpenSSH applies the
    // FIRST matching value for most keywords, so a duplicate can silently shadow
    // the user's own settings.
    const config = "Host other\n  RemoteForward 47001 127.0.0.1:47001\n";
    expect(alreadyForwards(config, "devbox", 47001)).toBe(false);
  });

  it("does not confuse a different port on the right host", () => {
    const config = "Host devbox\n  RemoteForward 9999 127.0.0.1:9999\n";
    expect(alreadyForwards(config, "devbox", 47001)).toBe(false);
  });

  it("matches a host listed among several patterns", () => {
    const config = "Host devbox buildbox\n  RemoteForward 47001 127.0.0.1:47001\n";
    expect(alreadyForwards(config, "buildbox", 47001)).toBe(true);
  });

  it("emits a block ssh will actually parse", () => {
    expect(forwardBlock("devbox", 47001)).toContain("RemoteForward 47001 127.0.0.1:47001");
  });
});

describe("PSH-15 — astir pair", () => {
  it("copies the token and adds the forward", () => {
    const d = deps();
    const r = pair(opts, d);

    expect(r.ok).toBe(true);
    // The token goes over stdin and is chmod'd in the same command, so it is
    // never briefly world-readable on the remote machine.
    const put = d.sshCalls.find((c) => c.command.includes("~/.astir/token"));
    expect(put?.input).toBe("s3cret");
    expect(put?.command).toContain("chmod 600");
    expect(d.appended[0]).toContain("RemoteForward 47001");
  });

  it("stops before changing anything when the host is unreachable", () => {
    const d = deps({ ssh: () => ({ ok: false, out: "Permission denied (publickey)." }) });
    const r = pair(opts, d);

    expect(r.ok).toBe(false);
    expect(r.changed, "nothing may be half-configured").toEqual([]);
    expect(d.appended).toHaveLength(0);
    expect(d.log_.join("\n")).toContain("Permission denied");
  });

  it("refuses to pair a machine that has no astir", () => {
    // Otherwise the setup looks complete and delivers nothing.
    const d = deps({ remote: { version: "MISSING" } });
    const r = pair(opts, d);

    expect(r.ok).toBe(false);
    expect(d.appended).toHaveLength(0);
    expect(d.log_.join("\n")).toContain("Install astir on devbox first");
  });

  it("never edits ssh config without consent, but says what to add", () => {
    const d = deps({ confirm: () => false });
    const r = pair(opts, d);

    expect(d.appended, "declining must mean untouched").toHaveLength(0);
    expect(d.log_.join("\n")).toContain("RemoteForward 47001 127.0.0.1:47001");
    expect(r.ok).toBe(true); // the token still landed; only the convenience was declined
  });

  it("is idempotent — pairing twice does not duplicate the stanza", () => {
    const d = deps({ config: "Host devbox\n  RemoteForward 47001 127.0.0.1:47001\n" });
    pair(opts, d);
    expect(d.appended).toHaveLength(0);
    expect(d.log_.join("\n")).toContain("already forwards");
  });

  it("--dry-run changes nothing anywhere", () => {
    const d = deps();
    pair({ ...opts, dryRun: true }, d);
    expect(d.appended).toHaveLength(0);
    expect(d.log_.join("\n")).toContain("Add to");
  });
});
