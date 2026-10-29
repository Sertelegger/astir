/**
 * #82 — the far ends a probe can meet, as real sockets on loopback. No mocks:
 * what is being tested is what undici makes of each.
 */

import { createServer as createHttpServer, type RequestListener } from "node:http";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";

export interface Far {
  port: number;
  close: () => Promise<void>;
}

/** Listens, keeping every connection so `close` can end it rather than wait on it. */
async function serve(server: Server, port: number): Promise<Far> {
  const held = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    held.add(socket);
    socket.on("close", () => held.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Accepts and never writes a byte: what a stale `ssh -R` forward does. */
export function silentOn(port = 0): Promise<Far> {
  return serve(
    createServer(() => {}),
    port,
  );
}

/** Accepts and closes at once: an `ssh -R` whose far end has nothing listening. */
export function hangUpOn(port = 0): Promise<Far> {
  return serve(
    createServer((socket) => socket.destroy()),
    port,
  );
}

/**
 * Accepts, reads the request, and resets the connection (RST, not FIN). After
 * the request rather than at once: a reset straight after accept reaches undici
 * mid-connect, and measured 1 run in 20 as a hang until the deadline.
 */
export function resetOn(port = 0): Promise<Far> {
  return serve(
    createServer((socket) => socket.once("data", () => socket.resetAndDestroy())),
    port,
  );
}

/** Accepts and answers something that is not HTTP. */
export function garbageOn(port = 0): Promise<Far> {
  return serve(
    createServer((socket) => socket.end("SSH-2.0-not-http\r\n\r\n")),
    port,
  );
}

/** A real HTTP server. */
export function httpOn(handler: RequestListener, port = 0): Promise<Far> {
  return serve(createHttpServer(handler), port);
}

/** A port that was just free: nothing listening, so a connection is refused. */
export async function closedPort(): Promise<number> {
  const far = await serve(createServer(), 0);
  await far.close();
  return far.port;
}
