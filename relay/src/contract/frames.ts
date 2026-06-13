import type { DiscoveryState } from "./types.js";

export type FrameType = "snapshot" | "delta" | "spec" | "session-state";
export const FRAME_TYPES = new Set<FrameType>(["snapshot", "delta", "spec", "session-state"]);

export interface Frame<T = unknown> {
  type: FrameType;
  sessionId: string;
  ts: number;
  payload: T;
}

export interface SessionStatePayload { state: DiscoveryState; }
// Note: a file "pulse" is a boolean FLAG on a changed node inside a `delta` payload,
// never its own frame type (REQ-024).

export function makeFrame<T>(type: FrameType, sessionId: string, ts: number, payload: T): Frame<T> {
  return { type, sessionId, ts, payload };
}
