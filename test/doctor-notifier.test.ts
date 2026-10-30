/**
 * #65 / #69 — the notifier stops being a second-class citizen.
 *
 * `doctor` reported the token, settings, plugin, autostart, daemon and hooks,
 * and said NOTHING about the notifier. The only mention inside `runDoctor` was
 * the `--notify` test, which sends a notification rather than reporting whether
 * anything exists to receive one.
 *
 * Measured live: a machine whose entire cross-machine path was dead produced
 * six lines, every one of them healthy, none about the thing that was broken.
 * The cause was that no notifier was running; the port was then claimed by an
 * unrelated forward; `detect.ts` correctly refused it as `role: "daemon"`; and
 * the daemon quietly reported `delivery paths: local`. Every component behaved
 * correctly and the feature was dead.
 */

import { describe, expect, it } from "vitest";
import { describeHosts, describeNotifier, notifierGreeting } from "../src/config/plugin.js";
import { SERVICE_LABELS, servicePath, servicePlist } from "../src/config/service.js";
import { PROBE_REASON } from "../src/notify/detect.js";

const text = (lines: string[]) => lines.join("\n");

describe("doctor says whether a notifier exists", () => {
  it("names its absence, since nothing else will", () => {
    const out = text(describeNotifier({ found: false, reason: "no tunnel" }, false, null));
    expect(out).toContain("none");
    expect(out).toContain("no tunnel");
    // And says what to do, because "no notifier" is not self-evidently fixable.
    expect(out).toContain("astir notifier");
  });

  it("passes through WHY, because the reasons need different fixes", () => {
    // "no tunnel" and "something else is listening on this port" are different
    // problems. `detect.ts` already distinguishes them and nobody surfaced it.
    const out = text(
      describeNotifier({ found: false, reason: "something else is listening on this port" }, false, null),
    );
    expect(out).toContain("something else is listening");
  });

  it("distinguishes running-and-never-contacted from running", () => {
    // A notifier up but never pushed to is a TUNNEL problem; a notifier that is
    // down is a PROCESS problem. Rendering both as "running" hides the first.
    const quiet = text(describeNotifier({ found: true }, true, 0));
    expect(quiet).toContain("no machine has pushed a roster");

    const busy = text(describeNotifier({ found: true }, true, 68));
    expect(busy).toContain("68 roster(s)");
    expect(busy).not.toContain("no machine has pushed");
  });

  it("warns when nothing will restart it", () => {
    // #69 — without a service this dies at every reboot, silently.
    expect(text(describeNotifier({ found: true }, false, 3))).toContain("not supervised");
    expect(text(describeNotifier({ found: true }, true, 3))).not.toContain("not supervised");
  });

  it("offers `astir autostart` for an unsupervised notifier only where it exists", () => {
    // review:82 F8 — it is launchd only, and refuses everywhere else. Told
    // "`astir autostart` fixes that" on Linux, you run it and get a refusal.
    const mac = text(describeNotifier({ found: true }, false, 3, { platform: "darwin" }));
    expect(mac).toContain("not supervised — it will not survive a reboot; `astir autostart` fixes that");
    for (const platform of ["linux", "freebsd"]) {
      const out = text(describeNotifier({ found: true }, false, 3, { platform }));
      expect(out).toContain("not supervised — it will not survive a reboot");
      expect(out).not.toContain("fixes that");
      expect(out).toContain("`astir autostart` is macOS only");
      expect(out).toContain("start `astir notifier`");
    }
  });

  it("says when the notifier it found cannot show anything", () => {
    // #78, round two — a headless `astir notifier` answers the probe like any
    // other, and refuses every doorbell. "running" alone reads as a way to
    // reach you, which is the one thing it is not.
    const out = text(describeNotifier({ found: true, canShow: false }, true, 3));
    expect(out).toContain("running");
    expect(out).toMatch(/cannot show/);
    expect(out).toMatch(/refuse/);
  });

  it("adds nothing for one that can show, or is too old to say", () => {
    for (const probe of [{ found: true, canShow: true }, { found: true }]) {
      expect(text(describeNotifier(probe, true, 3))).not.toMatch(/cannot show/);
    }
  });

  const held = (over: { url?: string | undefined } = { url: "http://127.0.0.1:47001/notify" }) => ({
    found: false,
    failure: "silent" as const,
    reason: PROBE_REASON.silent,
    ...over,
  });

  /** Every line a silent port's remedy may never print, wherever it is. */
  const neverForSilent = (out: string) => {
    expect(out).toContain("none");
    expect(out).not.toContain("astir pair");
    expect(out).not.toContain("starts one");
    expect(out).not.toContain("no tunnel");
  };

  it("#82 — on a machine reached over ssh, names the stale forward first, and how to find what holds the port", () => {
    // A stale `ssh -R` forward: something accepts on 47001 and never answers.
    // "Start a notifier, pair a machine" cannot fix that — the new forward
    // cannot even bind while the old one holds the port. Not local: the
    // machine reached over ssh, where 47001 is most likely only a forward.
    const out = text(describeNotifier(held(), false, null, { local: false, platform: "linux" }));
    neverForSilent(out);
    expect(out).toContain("something holds 127.0.0.1:47001 but did not answer in time");
    // WHICH process, not a process title to hunt for: an interactive `ssh`
    // holds the forward in `sshd: <user>@pts/N`, and ending every `@notty`
    // left that one holding the port (review:82, finding 3).
    expect(out).toContain("`sudo ss -ltnp 'sport = :47001'`");
    expect(out).toContain("`sshd: <user>@pts/N`");
    expect(out).toContain("`sshd: <user>@notty`");
    expect(out).toContain("`ClientAliveInterval 30`");
    expect(out).toContain("`ClientAliveCountMax 3`");
    expect(out).toContain("`ServerAliveInterval`");
    expect(out).not.toContain("astir autostart");
    // The forward first; the notifier here second.
    const forward = out.indexOf("left its `ssh -R` forward");
    const hung = out.indexOf("a notifier on this machine has hung");
    expect(forward).toBeGreaterThan(-1);
    expect(hung).toBeGreaterThan(forward);
    expect(out.indexOf("`sshd`")).toBeLessThan(out.indexOf("`node`"));
  });

  it("#82 — never sends someone to sshd_config alone, since `local` can be wrong", () => {
    // review:82, finding 2: `local` comes from `pairedHosts`, which reads only
    // ~/.ssh/config — not an `Include`d file, not a pattern host, not an `ssh
    // -R` typed by hand. A Mac running `astir notifier` by hand, its forward
    // kept in ~/.ssh/config.d/devbox, reads as not local; when its notifier
    // hangs, the remedy must still reach the notifier.
    for (const platform of ["darwin", "linux"]) {
      const out = text(describeNotifier(held(), false, null, { local: false, platform }));
      expect(out).toContain("`node`");
      expect(out).toContain("stop the `astir notifier` you started and start it again");
      expect(out).toContain("sshd_config");
    }
  });

  it("#82 — tells a hand-run notifier to restart what it started, never `astir autostart`", () => {
    // review:82, finding 1: paired (so `local`) but never made a service — the
    // documented flow ends "Run `astir notifier` here". `astir autostart` would
    // not touch that process, would install two agents nobody asked for, and
    // on Linux refuses outright; and there is no notifier.log to read.
    for (const platform of ["darwin", "linux"]) {
      const out = text(describeNotifier(held(), false, null, { local: true, platform }));
      neverForSilent(out);
      expect(out).toContain("something holds 127.0.0.1:47001 but did not answer in time");
      expect(out).not.toContain("astir autostart");
      expect(out).not.toContain("notifier.log");
      expect(out).toContain("stop the `astir notifier` you started and start it again");
      // The notifier here first; the forward second — but still there, since
      // `local` is a hint, not a fact.
      const hung = out.indexOf("the notifier on this machine has most likely hung");
      const forward = out.indexOf("left its `ssh -R` forward");
      expect(hung).toBeGreaterThan(-1);
      expect(forward).toBeGreaterThan(hung);
      expect(out.indexOf("`node`")).toBeLessThan(out.indexOf("`sshd`"));
    }
  });

  it("#82 — promises `astir autostart` only for the notifier service, on the platform that has it", () => {
    // `installService` boots its own label out and back in, which does
    // restart a hung service — and it is only implemented for macOS.
    const mac = text(describeNotifier(held(), true, null, { local: true, platform: "darwin" }));
    neverForSilent(mac);
    expect(mac).toContain("the notifier on this machine is most likely hung — `astir autostart`");
    expect(mac).toContain("~/.astir/notifier.log");
    expect(mac).not.toContain("ssh -R");
    expect(mac).not.toContain("ClientAliveInterval");

    const linux = text(describeNotifier(held(), true, null, { local: true, platform: "linux" }));
    neverForSilent(linux);
    expect(linux).not.toContain("astir autostart");
    expect(linux).not.toContain("notifier.log");
    expect(linux).toContain("`sudo ss -ltnp 'sport = :47001'`");
  });

  it("#82 — finds what holds the port with this platform's own command", () => {
    const on = (platform: string) => text(describeNotifier(held(), false, null, { local: false, platform }));
    expect(on("darwin")).toContain("`sudo lsof -iTCP:47001 -sTCP:LISTEN`");
    expect(on("darwin")).not.toContain("sudo ss");
    expect(on("linux")).toContain("`sudo ss -ltnp 'sport = :47001'`");
    // A container can ship net-tools without iproute2 (megabrain does).
    expect(on("linux")).toContain("`sudo netstat -ltnp | grep :47001`");
    expect(on("linux")).not.toContain("sudo lsof");
    expect(on("darwin")).not.toContain("netstat");
    // Anywhere else, both, rather than a guess.
    expect(on("freebsd")).toContain("`sudo lsof -iTCP:47001 -sTCP:LISTEN`");
    expect(on("freebsd")).toContain("`sudo ss -ltnp 'sport = :47001'`");
  });

  it("#82 — names the notifier port in words when there is no address to name", () => {
    for (const url of [undefined, "not a url"]) {
      const out = text(describeNotifier(held({ url }), false, null, { local: false, platform: "linux" }));
      expect(out).toContain("something holds the notifier port but did not answer in time");
      expect(out).toContain("`sudo ss -ltnp 'sport = :<port>'`");
    }
  });

  it("#82 — still sends a refused port to set one up", () => {
    const out = text(
      describeNotifier({ found: false, failure: "refused", reason: PROBE_REASON.refused }, true, null),
    );
    expect(out).toContain("no tunnel");
    expect(out).toContain("astir pair");
    expect(out).not.toContain("ClientAliveInterval");
  });

  it("#82 — sends a hang-up to the far end, not to set up the tunnel it already is", () => {
    // `ssh -R` with the tunnel up and nothing listening at its far end: the
    // client refuses the channel and sshd closes what it accepted.
    const out = text(
      describeNotifier(
        {
          found: false,
          failure: "closed",
          reason: PROBE_REASON.closed,
          url: "http://127.0.0.1:47001/notify",
        },
        false,
        null,
        { local: false },
      ),
    );
    expect(out).toContain(PROBE_REASON.closed);
    expect(out).toContain("if 127.0.0.1:47001 is an `ssh -R` forward, the tunnel is up");
    expect(out).toContain("start `astir notifier` on that machine");
    expect(out).not.toContain("astir pair");
    expect(out).not.toContain("ClientAliveInterval");
    expect(out).not.toContain("no tunnel");
  });

  it("#82 — says a port held by something that is not a notifier has to be given up", () => {
    const out = text(
      describeNotifier(
        {
          found: false,
          failure: "other",
          reason: "probe failed (HPE_INVALID_CONSTANT)",
          url: "http://127.0.0.1:47001/notify",
        },
        false,
        null,
        { local: false },
      ),
    );
    expect(out).toContain("probe failed (HPE_INVALID_CONSTANT)");
    expect(out).toContain("something that is not a notifier holds 127.0.0.1:47001");
    expect(out).not.toContain("astir pair");
    expect(out).not.toContain("astir notifier");
    expect(out).not.toContain("ClientAliveInterval");
    expect(out).not.toContain("no tunnel");
  });

  it("#82 — names the per-session process newer OpenSSH runs a forward in", () => {
    // review:82 F7 — OpenSSH 9.8 split the per-session server into its own
    // binary, so `ss`, `lsof` and `ps` can name `sshd-session`, not `sshd`.
    const out = text(describeNotifier(held(), false, null, { local: false, platform: "linux" }));
    expect(out).toContain("- `sshd` (`sshd-session` on OpenSSH 9.8 and later): the stale forward");
  });

  it("#82 — takes `local` from `supervised` when it is not given", () => {
    // review:82 F6 — the service installed is this machine's notifier on the
    // port; no service, and nothing else said, is not.
    const supervised = text(describeNotifier(held(), true, null, { platform: "linux" }));
    expect(supervised.indexOf("the notifier on this machine has most likely hung")).toBeGreaterThan(-1);
    expect(supervised.indexOf("`node`")).toBeLessThan(supervised.indexOf("`sshd`"));

    const not = text(describeNotifier(held(), false, null, { platform: "linux" }));
    expect(not.indexOf("most likely an ssh session that dropped")).toBeGreaterThan(-1);
    expect(not.indexOf("`sshd`")).toBeLessThan(not.indexOf("`node`"));
  });

  /** Runs `fn` with `process.platform` reading `platform`, and puts it back. */
  const onPlatform = <T>(platform: string, fn: () => T): T => {
    const real = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
    Object.defineProperty(process, "platform", { ...real, value: platform });
    try {
      return fn();
    } finally {
      Object.defineProperty(process, "platform", real);
    }
  };

  it("#82 — takes the platform from this process when it is not given", () => {
    // review:82 F6 — doctor runs on the machine that holds the port, so its
    // own platform is the one whose commands find the holder, and the one
    // `astir autostart` does or does not exist on.
    const before = process.platform;
    for (const platform of ["freebsd", "darwin", "linux"]) {
      const given = text(describeNotifier(held(), false, null, { local: false, platform }));
      const taken = onPlatform(platform, () => text(describeNotifier(held(), false, null, { local: false })));
      expect(taken, platform).toBe(given);
      const found = onPlatform(platform, () => text(describeNotifier({ found: true }, false, 3)));
      expect(found, platform).toBe(text(describeNotifier({ found: true }, false, 3, { platform })));
    }
    expect(process.platform).toBe(before);
  });

  it("says nothing about supervision when there is no notifier to supervise", () => {
    // One problem at a time: "start one" is the action, not "also supervise it".
    expect(text(describeNotifier({ found: false }, false, null))).not.toContain("not supervised");
  });
});

describe("doctor says which hosts it polls", () => {
  it("reports a host that returns nothing as such, not as absent", () => {
    // DMN-09's poll is the FALLBACK for when a machine's daemon is down, so a
    // host silently returning [] forever is the case it exists to cover. See
    // #68 — the probe cannot see non-default profiles at all.
    const out = text(describeHosts(["box-a"], new Set()));
    expect(out).toContain("box-a");
    expect(out).toContain("nothing returned");
  });

  it("marks a host that is reporting", () => {
    expect(text(describeHosts(["box-a"], new Set(["box-a"])))).toContain("reporting");
  });

  it("says nothing at all when no host is watched", () => {
    // An empty section is noise on the many machines that watch nothing.
    expect(describeHosts([], new Set())).toEqual([]);
  });
});

describe("#69 — the notifier gets a service of its own", () => {
  it("has a distinct label, or one would boot the other out", () => {
    expect(SERVICE_LABELS.notifier).not.toBe(SERVICE_LABELS.daemon);
    expect(servicePath("notifier")).not.toBe(servicePath("daemon"));
  });

  it("launches the notifier, not a second daemon", () => {
    // The plist's argv is what actually runs. A role that only changed the
    // label would install two supervisors for the same process.
    const plist = servicePlist({ node: "/n", script: "/s.js", logPath: "/l", role: "notifier" });
    expect(plist).toContain("<string>notifier</string>");
    expect(plist).toContain(SERVICE_LABELS.notifier);
    expect(plist).not.toContain("<string>daemon</string>");
  });

  it("still defaults to the daemon, so existing callers are unchanged", () => {
    const plist = servicePlist({ node: "/n", script: "/s.js", logPath: "/l" });
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toContain(SERVICE_LABELS.daemon);
  });
});

describe("#66 — what `astir notifier` tells you to do", () => {
  /**
   * It printed the manual setup PSH-14 and `astir pair` replaced:
   *
   *     on the remote host, run the daemon with:
   *       astir daemon --notify-url http://…/notify --notify-token <token>
   *     forward it with:  ssh -R 47001:127.0.0.1:47001 <host>
   *
   * Neither flag is dead, so this was superseded guidance rather than a broken
   * instruction — but it presented as required two things that are not, and
   * during a live debugging session it was read as "the daemon must be told
   * where the notifier is". That is the model PSH-14 exists to remove, and it
   * pulled attention away from the real fault: no notifier was running at all.
   */
  const greeting = (port = 47001, host = "mac") => notifierGreeting(port, host).join("\n");

  it("leads with `astir pair`, which is the one command that works", () => {
    const out = greeting(47001, "my-mac");
    expect(out).toContain("astir pair my-mac");
    // Named with THIS machine's host, because that is the argument the user
    // needs and the one they are least likely to have to hand.
    expect(out).not.toContain("astir pair <host>");
  });

  it("says the daemon finds the notifier by itself", () => {
    // PSH-14. Without this the reader reasonably concludes the opposite from
    // the flags mentioned further down.
    expect(greeting()).toMatch(/finds this notifier by itself/i);
    expect(greeting()).toMatch(/no token to copy/i);
  });

  it("no longer presents the manual flags as the way to do it", () => {
    const out = greeting();
    const pairAt = out.indexOf("astir pair");
    const flagsAt = out.indexOf("--notify-url");
    expect(pairAt).toBeGreaterThan(-1);
    expect(flagsAt).toBeGreaterThan(-1);
    // Order is the whole fix: the flags are real and belong last.
    expect(flagsAt).toBeGreaterThan(pairAt);
  });

  it("keeps the flags documented, since they exist for a real case", () => {
    // A tunnel astir did not set up. Deleting them would trade one wrong
    // instruction for a missing one.
    expect(greeting()).toContain("--notify-url");
    expect(greeting()).toContain("--notify-token");
  });

  it("still says where it is listening", () => {
    expect(greeting(47123)).toContain("127.0.0.1:47123");
  });
});
