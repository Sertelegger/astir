/**
 * MOD-07 — the boundary every event crosses, and nothing tested it.
 *
 * `validateEvent` is the whole of M1's "hostile input cannot kill the daemon".
 * It appeared in zero test files, and `LIMITS` was referenced nowhere outside
 * the module that declares it — so every bound in it was held by a comment.
 *
 * The named regression is real and specific: v1 accepted `Infinity` for `ts`,
 * which permanently froze an agent, because every later event then failed the
 * staleness comparison against it. Nothing could unstick it and nothing said
 * why. That is the shape of failure this file exists to prevent — not a crash,
 * which announces itself, but a value that is accepted and poisons the model.
 */

import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION, LIMITS, validateEvent } from "../src/contract/event.js";

/** A payload that passes, so each test can break exactly one thing. */
const good = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: CONTRACT_VERSION,
  eventId: "e1",
  provider: "claude",
  sessionId: "s1",
  ts: 1_787_000_000,
  kind: "session_start",
  agentId: "a1",
  ...over,
});

const err = (payload: Record<string, unknown>): string => {
  const r = validateEvent(payload);
  expect(r.ok, `expected rejection, got an accepted event`).toBe(false);
  return r.ok ? "" : r.error;
};

describe("the fixture itself is valid", () => {
  it("accepts a well-formed event, or every rejection below proves nothing", () => {
    // A `good()` that does not pass would make all of these pass for the wrong
    // reason — the failure mode a negative-only suite cannot see.
    const r = validateEvent(good());
    expect(r.ok).toBe(true);
  });
});

describe("ts — the value that froze an agent permanently", () => {
  it("rejects Infinity", () => {
    // THE regression. `typeof Infinity === "number"` is true, so a naive check
    // admits it; it then wins every staleness comparison forever.
    expect(err(good({ ts: Number.POSITIVE_INFINITY }))).toContain("ts");
  });

  it("rejects -Infinity and NaN, which the same naive check also admits", () => {
    expect(err(good({ ts: Number.NEGATIVE_INFINITY }))).toContain("ts");
    expect(err(good({ ts: Number.NaN }))).toContain("ts");
  });

  it("rejects a timestamp outside the sane window in both directions", () => {
    expect(err(good({ ts: LIMITS.minTs - 1 }))).toContain("ts");
    expect(err(good({ ts: LIMITS.maxTs + 1 }))).toContain("ts");
  });

  it("accepts the window's own edges, so the bound is not off by one", () => {
    expect(validateEvent(good({ ts: LIMITS.minTs })).ok).toBe(true);
    expect(validateEvent(good({ ts: LIMITS.maxTs })).ok).toBe(true);
  });

  it("rejects a timestamp sent as a string, however well-formed", () => {
    expect(err(good({ ts: "1787000000" }))).toContain("ts");
  });
});

describe("the contract version gate", () => {
  it("refuses a different major rather than guessing at its shape", () => {
    expect(err(good({ v: { major: CONTRACT_VERSION.major + 1, minor: 0 } }))).toContain("major");
  });

  it("accepts an unknown MINOR — VER-01 is additive", () => {
    // A newer minor may carry fields this build ignores. Rejecting it would
    // make every field addition a breaking change.
    expect(validateEvent(good({ v: { major: CONTRACT_VERSION.major, minor: 99 } })).ok).toBe(true);
  });

  it("refuses a missing or malformed version instead of assuming the current one", () => {
    expect(err(good({ v: undefined }))).toContain("contract version");
    expect(err(good({ v: { minor: 1 } }))).toContain("contract version");
    expect(err(good({ v: "1.0" }))).toContain("contract version");
  });
});

describe("strings are bounded, and rejected rather than truncated", () => {
  for (const field of ["eventId", "sessionId", "agentId"] as const) {
    it(`rejects an oversized ${field}`, () => {
      expect(err(good({ [field]: "x".repeat(LIMITS.maxStringLength + 1) }))).toContain(field);
    });

    it(`rejects an empty ${field}, which is not an identity`, () => {
      expect(err(good({ [field]: "" }))).toContain(field);
    });

    it(`rejects a non-string ${field}`, () => {
      expect(err(good({ [field]: 42 }))).toContain(field);
    });
  }

  it("accepts a string exactly at the limit", () => {
    expect(validateEvent(good({ eventId: "x".repeat(LIMITS.maxStringLength) })).ok).toBe(true);
  });

  it("rejects an oversized description rather than cutting it down", () => {
    // DMN-03. Truncating would put a malformed payload into the model wearing
    // a valid shape; rejecting keeps the boundary meaningful.
    expect(err(good({ description: "x".repeat(LIMITS.maxStringLength + 1) }))).toContain("description");
  });
});

describe("paths are bounded in all three dimensions", () => {
  it("rejects more paths than the cap", () => {
    expect(err(good({ paths: Array(LIMITS.maxPaths + 1).fill("a.ts") }))).toContain("too many");
  });

  it("accepts exactly the cap", () => {
    expect(validateEvent(good({ paths: Array(LIMITS.maxPaths).fill("a.ts") })).ok).toBe(true);
  });

  it("rejects a path longer than the cap", () => {
    expect(err(good({ paths: ["x".repeat(LIMITS.maxPathLength + 1)] }))).toContain("too long");
  });

  it("rejects a path deeper than the cap", () => {
    // A deep path is a cheap way to make downstream splitting expensive.
    expect(
      err(
        good({
          paths: [
            Array(LIMITS.maxPathSegments + 1)
              .fill("d")
              .join("/"),
          ],
        }),
      ),
    ).toContain("too deep");
  });

  it("rejects a non-string inside the array", () => {
    expect(err(good({ paths: ["a.ts", 7] }))).toContain("non-string");
  });

  it("rejects paths that are not an array at all", () => {
    expect(err(good({ paths: "a.ts" }))).toContain("array");
  });

  it("treats absent paths as empty rather than as a fault", () => {
    const r = validateEvent(good());
    expect(r.ok && r.event.paths).toEqual([]);
  });
});

describe("closed vocabularies are checked against their set", () => {
  it("rejects an unknown provider", () => {
    expect(err(good({ provider: "definitely-not-a-provider" }))).toContain("provider");
  });

  it("rejects an unknown kind", () => {
    expect(err(good({ kind: "whatever" }))).toContain("kind");
  });

  it("rejects an unknown op", () => {
    expect(err(good({ op: "chmod" }))).toContain("op");
  });

  it("allows a null op, which means the event has none", () => {
    expect(validateEvent(good({ op: null })).ok).toBe(true);
  });
});

describe("what it is NOT is an object", () => {
  for (const bad of [null, undefined, 42, "a string", true] as const) {
    it(`rejects ${String(bad)}`, () => {
      expect(err(bad as unknown as Record<string, unknown>)).toContain("not an object");
    });
  }

  it("rejects an array, which is an object to `typeof`", () => {
    expect(validateEvent([]).ok).toBe(false);
  });
});

describe("the accepted event carries only what the contract declares", () => {
  it("drops fields nobody asked for", () => {
    // The result is built field by field rather than spread, so a payload
    // cannot smuggle anything past the boundary into the model. That is a
    // property worth pinning, not an implementation detail.
    const r = validateEvent(good({ evilPayload: "rm -rf /", __proto__: { polluted: true } }));
    expect(r.ok).toBe(true);
    expect(r.ok && Object.keys(r.event)).not.toContain("evilPayload");
  });

  it("does not let a payload pollute Object.prototype", () => {
    validateEvent(JSON.parse('{"__proto__":{"pwned":true},"eventId":"e1"}'));
    expect(({} as Record<string, unknown>).pwned).toBeUndefined();
  });

  it("normalises absent optional fields to null rather than leaving them undefined", () => {
    // Downstream compares against null; undefined would pass `!== null` and
    // reach code that assumed a value.
    const r = validateEvent(good());
    expect(r.ok && r.event.agentType).toBeNull();
    expect(r.ok && r.event.tool).toBeNull();
    expect(r.ok && r.event.description).toBeNull();
    expect(r.ok && r.event.ok).toBeNull();
  });
});

describe("the two vocabularies that were not checked", () => {
  /**
   * `provider`, `kind` and `op` are each tested against a Set. `parentSource`
   * and `notificationKind` were cast straight through — so whatever arrived
   * reached the model wearing the type's name.
   *
   * Not a bug while exactly one provider exists, because the Claude normalizer
   * happens to validate `notificationKind` itself and falls back to "other".
   * That is the same shape as the prune bug #37 fixed: an invariant held by one
   * caller's diligence rather than by the boundary that claims to enforce it.
   * A second normalizer is being written now (#24), and it inherits none of
   * that diligence.
   *
   * `notificationKind` is the one that matters. It reaches the registry as
   * `kind: event.notificationKind ?? "blocked"` and travels into a notification
   * envelope — so an unbounded string from a payload ends up in what astir
   * shows a human, which is the one surface whose credibility is the product.
   */
  it("rejects a notificationKind that is not one of the declared kinds", () => {
    expect(err(good({ notificationKind: "please_run_rm_rf" }))).toContain("notificationKind");
  });

  it("rejects an unbounded string as a notificationKind", () => {
    expect(err(good({ notificationKind: "x".repeat(10_000) }))).toContain("notificationKind");
  });

  it("rejects a non-string notificationKind", () => {
    expect(err(good({ notificationKind: { toString: "nope" } }))).toContain("notificationKind");
  });

  it("accepts every kind the type declares", () => {
    for (const k of [
      "permission_prompt",
      "agent_needs_input",
      "worker_permission_prompt",
      "idle_prompt",
      "agent_completed",
      "other",
    ]) {
      expect(validateEvent(good({ notificationKind: k })).ok, `${k} should be accepted`).toBe(true);
    }
  });

  it("rejects a parentSource outside its three values", () => {
    expect(err(good({ parentSource: "vibes" }))).toContain("parentSource");
  });

  it("accepts every parentSource the type declares", () => {
    for (const s of ["sidecar", "tooluse", "inferred"]) {
      expect(validateEvent(good({ parentSource: s })).ok, `${s} should be accepted`).toBe(true);
    }
  });

  it("still treats both as optional, since most events have neither", () => {
    expect(validateEvent(good()).ok).toBe(true);
    expect(validateEvent(good({ notificationKind: null, parentSource: null })).ok).toBe(true);
  });
});
