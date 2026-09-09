/**
 * VIEW-02 — a stream that has gone silent must not keep reading as "Live".
 *
 * The failure is a HALF-OPEN connection: a laptop sleeps, a tunnel dies, an ssh
 * forward is severed. The socket is never closed, so `read()` never settles and
 * never errors — nothing throws, the last frame stays on screen, and the view
 * goes on claiming to be live indefinitely. It is the dishonesty VIEW-02 exists
 * to prevent, arrived at by doing nothing at all.
 */

import { describe, expect, it } from "vitest";
import { STREAM_HEARTBEAT_MS } from "../src/daemon/server.js";
import { readSse, SILENCE_DEADLINE_MS, type SseEvent } from "../view/src/sse.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stream whose timing the test drives, standing in for a socket. */
function controlled() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
    },
  });
  const enc = new TextEncoder();
  return {
    stream,
    send: (s: string) => ctl.enqueue(enc.encode(s)),
    close: () => ctl.close(),
  };
}

/** Consume in the background so the test can drive the stream meanwhile. */
function consume(stream: ReadableStream<Uint8Array>, deadlineMs: number) {
  const seen: SseEvent[] = [];
  let error: Error | null = null;
  const done = (async () => {
    try {
      for await (const e of readSse(stream, undefined, deadlineMs)) seen.push(e);
    } catch (e) {
      error = e as Error;
    }
  })();
  return { seen, done, err: () => error };
}

describe("a stream that says nothing is lost, not live", () => {
  it("gives up when no bytes arrive at all", async () => {
    const { stream } = controlled();
    const run = consume(stream, 40);
    await run.done;
    expect(run.err()).not.toBeNull();
  });

  it("says how long it waited, because that message reaches the user", async () => {
    // useSession puts `error.message` straight into the `lost` detail, which the
    // view renders. "no data for 45s" is a diagnosis; "undefined" is noise.
    const { stream } = controlled();
    const run = consume(stream, 1_000);
    await run.done;
    expect(run.err()?.message).toBe("no data for 1s");
  });

  it("SURVIVES on heartbeats alone — the case that decides where this lives", async () => {
    // A heartbeat yields no event: `parseBlock` returns null for a comment-only
    // block, so the consumer never sees one. A deadline in `useSession` would
    // therefore fire during a perfectly healthy quiet stream. Only the reader
    // sees these bytes, which is why the timer is down here.
    const { stream, send, close } = controlled();
    const run = consume(stream, 60);

    for (let i = 0; i < 6; i++) {
      await sleep(20);
      send(": beat\n\n");
    }
    await sleep(20);
    close();
    await run.done;

    expect(run.err()).toBeNull();
    // And the heartbeats really were invisible as events, or this proves nothing.
    expect(run.seen).toEqual([]);
  });

  it("survives on real events, and still delivers them", async () => {
    const { stream, send, close } = controlled();
    const run = consume(stream, 60);

    for (let i = 1; i <= 4; i++) {
      await sleep(20);
      send(`id: ${i}\nevent: delta\ndata: {"seq":${i}}\n\n`);
    }
    close();
    await run.done;

    expect(run.err()).toBeNull();
    expect(run.seen.map((e) => e.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("ends normally when the stream closes, rather than reporting silence", async () => {
    // A closed stream is `done`, which means the session ENDED. Conflating that
    // with a lost connection is the exact pair connection.ts exists to separate.
    const { stream, close } = controlled();
    const run = consume(stream, 5_000);
    close();
    await run.done;
    expect(run.err()).toBeNull();
  });

  it("can be switched off with a non-positive deadline", async () => {
    const { stream, close } = controlled();
    const run = consume(stream, 0);
    await sleep(30);
    close();
    await run.done;
    expect(run.err()).toBeNull();
  });
});

describe("the deadline is meaningful only against the heartbeat", () => {
  it("allows several missed beats before giving up", () => {
    // The two constants live in different files and are useless apart: shorter
    // than the beat drops healthy streams, far longer leaves a dead map reading
    // as live. Pinning the RATIO is what makes changing one alone fail loudly.
    expect(SILENCE_DEADLINE_MS).toBeGreaterThanOrEqual(STREAM_HEARTBEAT_MS * 2.5);
    expect(SILENCE_DEADLINE_MS).toBeLessThanOrEqual(STREAM_HEARTBEAT_MS * 6);
  });
});
