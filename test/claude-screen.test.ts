/**
 * #86 — Claude's session listing, in astir's words.
 *
 * `claude agents --json` says what is on a session's screen in Claude's own
 * vocabulary (`status`, and `waitingFor` beside `waiting`). The lister turns
 * that into `DiscoveredSession.screen`, and the registry reads only that word
 * (CAP-02). The table of words below was read off a live listing
 * (test/fixtures/claude/permission-capture.json, Claude Code 2.1.322); the
 * few others are labelled with where they come from.
 *
 * `pollInto` is the other half: a listing describes the screen when the poll
 * STARTED, and the answer can land a second later, so the start time travels
 * with it.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  claudeScreen,
  type DiscoveredSession,
  type DiscoveryResult,
  parseAgentsJson,
  pollInto,
  type SessionScreen,
} from "../src/discovery/sessions.js";

interface CapturedPoll {
  start: number;
  end: number;
  status: string | null;
  waitingFor: string | null;
}

const capture = JSON.parse(
  readFileSync(new URL("./fixtures/claude/permission-capture.json", import.meta.url), "utf8"),
) as { timelines: Record<string, { polls: CapturedPoll[] }> };

/** Every (status, waitingFor) the capture's listings returned for a probe session. */
const capturedWords = new Map<string, { status: string | null; waitingFor: string | null }>();
for (const tl of Object.values(capture.timelines)) {
  for (const p of tl.polls) capturedWords.set(`${p.status}|${p.waitingFor}`, p);
}

describe("claudeScreen: the listing's words, as astir's", () => {
  it("the capture used exactly these words", () => {
    // If a new word ever shows up in a re-capture, this says so before
    // anything downstream quietly reads it as "no evidence".
    expect([...capturedWords.keys()].sort()).toEqual([
      "busy|null",
      "idle|null",
      "waiting|input needed",
      "waiting|permission prompt",
    ]);
  });

  it.each<[string | null, string | null, SessionScreen | undefined]>([
    // Bash, Edit, Write, WebFetch, MCP tools and ExitPlanMode (n=20).
    ["waiting", "permission prompt", "permission-dialog"],
    // AskUserQuestion (n=5) and an MCP elicitation (n=2): a dialog, but not
    // known to be a permission one.
    ["waiting", "input needed", "other-dialog"],
    // Nothing on screen and the turn over: Esc read this on the first poll
    // after the key, 20/20.
    ["idle", null, "at-prompt"],
    // Nothing on screen and the session working: what an approved long tool
    // reads.
    ["busy", null, "working"],
  ])("%s / %s → %s", (status, waitingFor, screen) => {
    expect(claudeScreen(status, waitingFor)).toBe(screen);
  });

  it("a session with no status yet says nothing (seen 4 times, each before SessionStart)", () => {
    expect(claudeScreen(null, null)).toBeUndefined();
  });

  it("`waiting` for anything but a permission prompt is some other dialog", () => {
    expect(claudeScreen("waiting", null)).toBe("other-dialog");
    expect(claudeScreen("waiting", "dialog open")).toBe("other-dialog");
  });

  it("words the capture did not read, kept on purpose (not captured)", () => {
    // `running` and `working` are the registry's PROVIDER_BUSY words (a remote
    // session was seen reporting `running`; registry.test.ts "treats `running`
    // as busy too"), so nothing read as working before reads as anything else.
    expect(claudeScreen("running", null)).toBe("working");
    expect(claudeScreen("working", null)).toBe("working");
    // `shell` is Claude's session-file word for idle with a background shell
    // running, read from the binary; `--json` folds it into `busy` today.
    expect(claudeScreen("shell", null)).toBe("at-prompt");
  });

  it("a status it does not know says nothing rather than guessing", () => {
    expect(claudeScreen("compacting", null)).toBeUndefined();
  });
});

describe("parseAgentsJson carries the screen, and keeps Claude's words to itself", () => {
  const listing = (status: string | null, waitingFor: string | null) =>
    JSON.stringify([
      {
        pid: 101,
        cwd: "/repo",
        kind: "interactive",
        startedAt: 1,
        sessionId: "s1",
        name: "n",
        status,
        ...(waitingFor === null ? {} : { waitingFor }),
      },
    ]);

  it("translates each captured row", () => {
    for (const { status, waitingFor } of capturedWords.values()) {
      const [row] = parseAgentsJson(listing(status, waitingFor)) ?? [];
      expect(row?.screen).toBe(claudeScreen(status, waitingFor));
      expect(row?.status).toBe(status);
    }
  });

  it("never passes `waitingFor` on: the registry reads `screen`, not Claude's vocabulary", () => {
    const [row] = parseAgentsJson(listing("waiting", "permission prompt")) ?? [];
    expect(row).toBeDefined();
    expect(Object.keys(row as object)).not.toContain("waitingFor");
    expect(row?.screen).toBe("permission-dialog");
  });

  it("leaves `screen` off a row it cannot translate", () => {
    const [row] = parseAgentsJson(listing(null, null)) ?? [];
    expect(row).toBeDefined();
    expect(Object.keys(row as object)).not.toContain("screen");
  });
});

describe("pollInto: a poll's answer is dated from when it was asked", () => {
  function recorder() {
    const calls: Array<{ discovered: DiscoveredSession[] | null; opts: unknown }> = [];
    return {
      calls,
      registry: {
        reconcile: (discovered: DiscoveredSession[] | null, opts: unknown) => {
          calls.push({ discovered, opts });
          return { enriched: 0, pruned: 0 };
        },
      },
    };
  }

  it("reads the clock BEFORE the lister runs, however late the answer lands", async () => {
    // A listing poll takes ~0.5 s (median 484-612 ms, max 3.5 s, n=3730) and
    // describes the screen as it was near its start. Dated on landing, a poll
    // that began before a dialog was answered would be read as after it.
    let t = 1_000;
    const r = recorder();
    const row: DiscoveredSession = {
      sessionId: "s1",
      cwd: "/r",
      pid: 1,
      status: "idle",
      name: null,
      startedAt: null,
    };
    const lister = async (): Promise<DiscoveryResult> => {
      t += 3_549;
      return { complete: true, sessions: [row] };
    };
    await pollInto(lister, r.registry, "claude", () => t);
    expect(r.calls).toEqual([
      { discovered: [row], opts: { complete: true, provider: "claude", observedAt: 1_000 } },
    ]);
  });

  it("passes on 'could not determine' as null, and an incomplete view as incomplete", async () => {
    const r = recorder();
    await pollInto(
      async () => null,
      r.registry,
      "claude",
      () => 5,
    );
    expect(r.calls).toEqual([
      { discovered: null, opts: { complete: false, provider: "claude", observedAt: 5 } },
    ]);
  });

  it("never throws: a lister that rejects is a poll that said nothing", async () => {
    const r = recorder();
    await expect(
      pollInto(
        async () => {
          throw new Error("spawn failed");
        },
        r.registry,
        "claude",
        () => 5,
      ),
    ).resolves.toBeUndefined();
    expect(r.calls).toEqual([]);
  });
});
