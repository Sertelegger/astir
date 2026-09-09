/**
 * An SSE reader built on `fetch` rather than `EventSource`.
 *
 * `EventSource` cannot send an `Authorization` header — the API has no way to
 * set one — so using it would mean putting the token in the query string, where
 * it lands in logs. `fetch` can, at the cost of parsing the wire format here,
 * which is a dozen lines.
 */

/**
 * How long a stream may say nothing at all before we call it lost.
 *
 * The daemon sends `: beat` every `STREAM_HEARTBEAT_MS` (15s), so silence is
 * evidence rather than absence of it: three missed beats means the bytes have
 * stopped arriving, whatever the socket believes. Tolerant enough to survive one
 * slow beat, a GC pause or a laptop hiccup; short enough that nobody stares at a
 * dead map for minutes.
 *
 * This has to live HERE rather than in `useSession`, and the reason is easy to
 * miss: a heartbeat produces no event. `parseBlock` returns null for a
 * comment-only block, so the consumer never sees one — a timer up there would
 * fire during a perfectly healthy quiet stream. Only the reader sees the bytes.
 */
export const SILENCE_DEADLINE_MS = 45_000;

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** Parse an event-stream body into events. Comments (`:` lines) are skipped. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  /** Injectable so a test need not wait three quarters of a minute. */
  silenceMs: number = SILENCE_DEADLINE_MS,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted === true) return;
      const { value, done } = await withDeadline(reader.read(), silenceMs);
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      let cut = buffer.indexOf("\n\n");
      while (cut !== -1) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const parsed = parseBlock(block);
        if (parsed !== null) yield parsed;
        cut = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * A read that gives up on silence.
 *
 * The failure this exists for is a HALF-OPEN connection: a laptop sleeps, a
 * tunnel dies, or an ssh forward is severed, and the socket is never closed —
 * so `read()` simply never settles and never errors. Nothing throws, the view
 * keeps its last frame, and it goes on saying "Live" indefinitely. That is the
 * exact dishonesty VIEW-02 exists to prevent, arrived at by doing nothing.
 *
 * Rejecting here rather than returning `done` is deliberate: `done` means the
 * stream ENDED, which the reducer would render as a finished session. This is a
 * connection that was lost, and the caller's existing catch already turns a
 * throw into `lost` → `unreachable`, with a retry and a countdown.
 */
function withDeadline<T>(read: Promise<T>, ms: number): Promise<T> {
  // A non-positive deadline disables the timer rather than firing immediately,
  // so a caller can opt out without a second code path.
  if (!(ms > 0)) return read;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no data for ${Math.round(ms / 1000)}s`)), ms);
    read.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function parseBlock(block: string): SseEvent | null {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue; // heartbeat
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (data.length === 0) return null;
  return id === undefined ? { event, data: data.join("\n") } : { event, data: data.join("\n"), id };
}
