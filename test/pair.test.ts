import { describe, expect, it } from "vitest";
import {
  alreadyForwards,
  forwardBlock,
  loginShell,
  type PairDeps,
  pair,
  pairSshArgs,
} from "../src/cli/pair.js";

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
      // The READ must be distinguishable from the WRITE — they touch the same
      // path, and answering the read with the write's reply is how a stub ends
      // up agreeing with whatever the code does.
      if (command.startsWith("cat ~/.astir/token")) {
        return { ok: true, out: over.remote?.existingToken ?? "" };
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
    // The WRITE specifically: the read that precedes it touches the same path.
    const put = d.sshCalls.find((c) => c.command.includes("chmod 600"));
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

describe("remote commands run in a LOGIN shell", () => {
  it("wraps the command so a profile-set PATH is visible", () => {
    // `ssh host <cmd>` gets a non-login shell that sources no profile, so
    // anything from a version manager or `npm link` is not on PATH. `pair` then
    // reported "astir on remote: NOT FOUND" for a correctly installed machine
    // and told the user to go install it again.
    expect(loginShell("command -v astir")).toBe("${SHELL:-/bin/sh} -lc 'command -v astir'");
  });

  it("does not let the LOCAL shell expand the payload", () => {
    // $HOME must be resolved by the remote shell. Expanding it here would send
    // this machine's home directory to the other machine.
    const wrapped = loginShell("echo $HOME");
    expect(wrapped).toContain("$HOME");
    expect(wrapped).not.toContain(process.env.HOME ?? "  never  ");
  });

  it("survives a command containing a quote", () => {
    // The '\'' dance. Getting it wrong ends the quoting early and the rest of
    // the command runs unquoted on someone else's machine.
    const wrapped = loginShell("echo 'hi'");
    expect(wrapped).toContain("'\\''hi'\\''");
    expect(wrapped.startsWith("${SHELL:-/bin/sh} -lc '")).toBe(true);
    expect(wrapped.endsWith("'")).toBe(true);
  });

  it("keeps a multi-part command in ONE shell invocation", () => {
    // The token write is `mkdir && cat > file && chmod`; splitting it would run
    // the chmod in a different shell from the redirect that created the file.
    const wrapped = loginShell("mkdir -p ~/.astir && cat > ~/.astir/token && chmod 600 ~/.astir/token");
    expect(wrapped.match(/-lc/g)).toHaveLength(1);
    expect(wrapped).toContain("chmod 600");
  });
});

describe("--dry-run does not touch the other machine", () => {
  it("does NOT write the token to the remote", () => {
    // It writes a credential. A flag named --dry-run that ships a secret to a
    // host you are still deciding about is worse than no flag at all, because
    // the whole point of asking was to find out what would happen.
    const d = deps({ remote: { "command -v astir": "astir 0.1.0" } });
    pair({ host: "box", notifyPort: 47001, token: "s3cret", dryRun: true }, d);

    const writes = d.sshCalls.filter((c) => c.command.includes("chmod 600"));
    expect(writes).toHaveLength(0);
    expect(d.sshCalls.some((c) => c.input === "s3cret")).toBe(false);
  });

  it("says it WOULD copy, rather than claiming it did", () => {
    const d = deps({ remote: { "command -v astir": "astir 0.1.0" } });
    pair({ host: "box", notifyPort: 47001, token: "s3cret", dryRun: true }, d);
    const out = d.log_.join("\n");

    expect(out).toContain("would copy");
    expect(out).toContain("would be paired");
    expect(out).not.toMatch(/\bis paired\b/);
  });

  it("still writes the token on a real run", () => {
    // The guard must not have turned pairing itself off.
    const d = deps({ remote: { "command -v astir": "astir 0.1.0" } });
    pair({ host: "box", notifyPort: 47001, token: "s3cret" }, d);

    expect(d.sshCalls.some((c) => c.input === "s3cret")).toBe(true);
    expect(d.log_.join("\n")).toContain("is paired");
  });

  it("leaves the ssh config alone either way", () => {
    const d = deps({ remote: { "command -v astir": "astir 0.1.0" } });
    pair({ host: "box", notifyPort: 47001, token: "s3cret", dryRun: true }, d);
    expect(d.appended).toEqual([]);
  });
});

describe("the argv that actually runs", () => {
  it("wraps the command in a login shell", () => {
    // Asserted on the argv rather than on `loginShell`, because a correct
    // helper that nothing calls is the shape of bug this project shipped once.
    const args = pairSshArgs("box", "command -v astir");
    expect(args.at(-1)).toBe(loginShell("command -v astir"));
    expect(args.at(-1)).toContain("-lc");
  });

  it("keeps BatchMode so it can never sit at a password prompt", () => {
    // `pair` runs unattended from a CLI; an interactive prompt here would hang
    // the command with no indication why.
    expect(pairSshArgs("box", "echo ok")).toContain("BatchMode=yes");
  });

  it("passes the host as its own argument, never interpolated", () => {
    const args = pairSshArgs("weird host", "echo ok");
    expect(args).toContain("weird host");
  });
});

describe("pairing a machine that already had a token", () => {
  const withToken = (existingToken: string) => ({ remote: { existingToken } });

  it("says it replaced one, and names the command that finishes the job", () => {
    // Pairing shares ONE secret across both machines, so a host that has run
    // `astir install` has a different one. Overwriting it silently leaves that
    // host's settings.json naming the old value, and its daemon then rejects
    // its own hooks — which looks, from over there, like a broken install.
    const d = deps(withToken("a-different-token"));
    pair({ host: "box", notifyPort: 47001, token: "shared" }, d);
    const out = d.log_.join("\n");

    expect(out).toContain("already had a different astir token");
    expect(out).toContain("ssh box astir install --no-plugin");
  });

  it("stays quiet when the remote had no token at all", () => {
    const d = deps({ remote: { existingToken: "" } });
    pair({ host: "box", notifyPort: 47001, token: "shared" }, d);
    expect(d.log_.join("\n")).not.toContain("already had a different");
  });

  it("stays quiet when the remote already had THIS token", () => {
    // Re-pairing an already-paired host is a no-op, and telling someone to go
    // repair a machine that is fine is its own kind of wrong.
    const d = deps(withToken("shared"));
    pair({ host: "box", notifyPort: 47001, token: "shared" }, d);
    expect(d.log_.join("\n")).not.toContain("already had a different");
  });
});
