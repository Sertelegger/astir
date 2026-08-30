/**
 * VIEW-02 — the live wire: one snapshot, then deltas, over Server-Sent Events.
 *
 * The state machine lives here rather than in the route handler so it can be
 * driven by a test with a fake clock and no socket. `server.ts` supplies a sink
 * that happens to be an HTTP response; nothing below knows that.
 *
 * ## Why SSE rather than a WebSocket
 *
 * The traffic is one-directional — the daemon talks, the view listens — and SSE
 * is plain HTTP, so it inherits the bearer token, the Host check and the
 * loopback bind already in place. A WebSocket upgrade would bypass all three and
 * need its own authentication path, for a channel that carries nothing upstream.
 */

import type { Registry, SessionRecord } from "../model/registry.js";
import {
  buildSnapshot,
  diffSnapshots,
  type Frame,
  type Snapshot,
  type SnapshotInput,
} from "../status/frames.js";
import type { StatusAgent } from "../status/types.js";

/** A frame ends the stream: the session it followed is gone. */
export interface EndFrame {
  kind: "end";
  sessionId: string;
  reason: "gone";
}

export type StreamMessage = Frame | EndFrame;

/**
 * Turns a sequence of observations into a sequence of frames.
 *
 * The contract: the FIRST message is always a snapshot, every later one is a
 * delta against what the client already has, and a `null` observation means the
 * session vanished. Intervals where nothing changed produce no message at all —
 * that is the entire point of diffing, and it is why the transport needs a
 * separate heartbeat to prove it is still alive.
 */
export class StreamState {
  private prev: Snapshot | null = null;
  private seq = 0;
  private ended = false;

  constructor(private readonly sessionId: string) {}

  next(observed: Observation | null): StreamMessage | null {
    if (this.ended) return null;
    if (observed === null) {
      this.ended = true;
      return { kind: "end", sessionId: this.sessionId, reason: "gone" };
    }

    // `seq` numbers frames that were actually SENT, so the client can tell a
    // gap from a quiet stretch. It is therefore assigned at emit time and not
    // before: a tick that turns out to be a no-op must not burn a number and
    // make the next delta look like it lost one.
    const snapshot = buildSnapshot({ ...observed, seq: this.seq + 1 });
    if (this.prev === null) {
      this.prev = snapshot;
      this.seq++;
      return snapshot;
    }

    const delta = diffSnapshots(this.prev, snapshot);
    // No delta means nothing moved. Emitting an empty frame anyway would be a
    // heartbeat wearing a data frame's clothes, and the client would have to
    // tell them apart to know whether to re-render.
    if (delta === null) return null;

    this.seq++;
    this.prev = { ...snapshot, seq: this.seq };
    return { ...delta, seq: this.seq };
  }

  /** Frames emitted so far. `0` means the stream has produced nothing yet. */
  get emitted(): number {
    return this.seq;
  }
}

/** A session as observed at one instant. The stream owns the sequence number. */
export type Observation = Omit<SnapshotInput, "seq">;

/**
 * A session as the frame layer wants it.
 *
 * `inStateMs` is computed here for the same reason `/state` computes it: the
 * daemon owns the clock, and a surface that derives it from a cached response
 * would silently age.
 */
export function observe(session: SessionRecord, now: number): Observation {
  const agents: StatusAgent[] = [...session.agents.values()].map((a) => ({
    id: a.id,
    agentType: a.agentType,
    state: a.state,
    activeMs: a.activeMs,
    turnMs: a.turnMs,
    blockedMs: a.blockedMs,
    inStateMs: Math.max(0, now - a.stateSince),
    acknowledged: a.acknowledgedAt !== null,
    description: a.description,
    tool: a.tool,
    toolPath: a.toolPath,
  }));
  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    name: session.name,
    status: session.status,
    agents,
    map: session.map,
    // Off the session, never off the daemon — see `SessionRecord.pathsOutsideRepo`.
    counters: {
      pathsOutsideRepo: session.pathsOutsideRepo,
      invalidEvents: session.invalidEvents,
    },
  };
}

/** Reads the session out of the registry, or `null` once it is gone. */
export function observer(registry: Registry, sessionId: string, now: () => number): () => Observation | null {
  return () => {
    const session = registry.get(sessionId);
    return session === undefined ? null : observe(session, now());
  };
}

/** Where frames go. An HTTP response is one implementation; a test array is another. */
export interface FrameSink {
  send(message: StreamMessage): void;
  /** SSE comment — invisible to the client's event handlers, but proves liveness. */
  heartbeat(): void;
  close(): void;
}

/** Serialise one message as an SSE event block. */
export function sseFrame(message: StreamMessage): string {
  const id = "seq" in message ? `id: ${message.seq}\n` : "";
  return `${id}event: ${message.kind}\ndata: ${JSON.stringify(message)}\n\n`;
}
