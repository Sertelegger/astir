import { randomBytes, timingSafeEqual } from "node:crypto";

/** 16 bytes = 128 bits, hex-encoded (32 chars). REQ-010/090. */
export function generateToken(): string {
  return randomBytes(16).toString("hex");
}

/** Length-safe, constant-time compare. REQ-012. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
