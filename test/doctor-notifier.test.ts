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
