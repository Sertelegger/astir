import type { Kind, Op } from "../src/contract/types.js";

let seq = 0;
const nextId = () => `e${++seq}`;

/** Posts scripted events/reasoning to a running relay and reads /state. Test input only — NOT a product replay feature (NG1). */
export class Driver {
  constructor(private baseUrl: string, private token: string, private sessionId: string) {}
  private auth = () => ({ Authorization: `Bearer ${this.token}`, "content-type": "application/json" });

  async event(e: { kind: Kind; agentId: string; tool?: string; paths?: string[]; op?: Op; ok?: boolean; ts?: number }): Promise<void> {
    await this.eventRaw({ v: 1, eventId: nextId(), provider: "claude", sessionId: this.sessionId, ts: e.ts ?? Date.now() / 1000, paths: e.paths ?? [], op: e.op ?? null, ...e });
  }
  async eventRaw(body: unknown): Promise<void> {
    await fetch(`${this.baseUrl}/events`, { method: "POST", headers: this.auth(), body: JSON.stringify(body) });
  }
  async reasoning(agentId: string, text: string, ts = Date.now() / 1000): Promise<void> {
    await fetch(`${this.baseUrl}/reasoning`, { method: "POST", headers: this.auth(), body: JSON.stringify({ agentId, ts, text }) });
  }
  async state(): Promise<any> {
    return (await fetch(`${this.baseUrl}/state`, { headers: this.auth() })).json();
  }
}
