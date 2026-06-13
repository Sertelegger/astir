import { egressFields, type Summarizer, type SummarizerEvent } from "./summarizer.js";
import { passesNowGate } from "../model/reasoning.js";

export type EgressFields = ReturnType<typeof egressFields>;
export type ModelFn = (fields: EgressFields) => Promise<string | null>;

export interface AutoSummarizerOpts { minIntervalSeconds?: number; cooldownSeconds?: number; failureThreshold?: number; now?: () => number; }

/** Model-backed Summarizer (REQ-035): debounce, ≤1 in-flight/agent, circuit-breaker, output validation, egress allow-list. */
export class AutoSummarizer implements Summarizer {
  private inFlight = new Set<string>();
  private lastCall = new Map<string, number>();
  private failures = 0;
  private breakerUntil = 0;
  private readonly minInterval: number;
  private readonly cooldown: number;
  private readonly threshold: number;
  private readonly now: () => number;

  constructor(private modelFn: ModelFn, opts: AutoSummarizerOpts = {}) {
    this.minInterval = opts.minIntervalSeconds ?? 3;
    this.cooldown = opts.cooldownSeconds ?? 60;
    this.threshold = opts.failureThreshold ?? 3;
    this.now = opts.now ?? (() => Date.now() / 1000);
  }

  async summarize(agentId: string, events: SummarizerEvent[]): Promise<string | null> {
    const t = this.now();
    if (t < this.breakerUntil) return null;
    if (this.inFlight.has(agentId)) return null;
    if (t - (this.lastCall.get(agentId) ?? -Infinity) < this.minInterval) return null;
    this.inFlight.add(agentId);
    this.lastCall.set(agentId, t);
    try {
      const out = await this.modelFn(egressFields(events)); // egress allow-list enforced here (REQ-036)
      this.failures = 0;
      if (out === null) return null;
      const trimmed = out.trim().slice(0, 80);
      return passesNowGate(trimmed) ? trimmed : null;
    } catch {
      this.failures += 1;
      if (this.failures >= this.threshold) { this.breakerUntil = t + this.cooldown; this.failures = 0; }
      return null;
    } finally {
      this.inFlight.delete(agentId);
    }
  }
}
