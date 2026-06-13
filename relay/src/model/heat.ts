import type { Op } from "../contract/types.js";
import type { Clock } from "./clock.js";

export const HEAT_WEIGHTS: Record<Op, number> = { write: 3, edit: 3, read: 1, other: 1 };

const DT_CAP_SECONDS = 3600; // clamp dt to [0, cap] (REQ-021)

/** Per-leaf decaying activity intensity. Decay uses the monotonic clock only. */
export class FileHeat {
  heat = 0;
  reads = 0;
  edits = 0;
  lastTouch = 0; // wall-clock ts, for display only
  private lastMono: number;

  constructor(private clock: Clock, private halfLifeSeconds = 30) {
    this.lastMono = clock.monoNow();
  }

  private decayTo(mono: number): void {
    const dt = Math.min(Math.max(mono - this.lastMono, 0), DT_CAP_SECONDS);
    if (dt > 0) this.heat *= Math.pow(0.5, dt / this.halfLifeSeconds);
    this.lastMono = mono;
  }

  touch(op: Op, wallTs: number, weightsOrWeight?: Partial<Record<Op, number>>): void {
    const mono = this.clock.monoNow();
    this.decayTo(mono);
    const w = (weightsOrWeight as Record<Op, number> | undefined)?.[op] ?? HEAT_WEIGHTS[op];
    this.heat += w;
    if (op === "read") this.reads += 1;
    else if (op === "write" || op === "edit") this.edits += 1;
    this.lastTouch = wallTs;
  }

  /** Current decayed heat (does not advance counters). */
  value(): number {
    this.decayTo(this.clock.monoNow());
    return this.heat;
  }
}
