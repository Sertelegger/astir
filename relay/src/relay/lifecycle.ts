import type { RelayLifecycle } from "../contract/types.js";

export interface LifecycleOpts {
  pidAlive: () => boolean;       // may throw if unknowable
  idleShutdownMs: number;
  endGraceMs: number;
  onShutdown: () => void;        // exit + remove discovery file
}

export class Lifecycle {
  state: RelayLifecycle = "LIVE";
  private lastEventMs = 0;
  private endedAtMs: number | null = null;
  private shutdownCalled = false;

  constructor(private opts: LifecycleOpts) {}

  /** Record activity (wall ms) — keeps the session live and revives within grace. */
  note(nowMs: number): void { this.lastEventMs = Math.max(this.lastEventMs, nowMs); }

  onSessionStart(nowMs: number): void {
    this.note(nowMs);
    if (this.state === "ENDED") { this.state = "LIVE"; this.endedAtMs = null; } // revive (REQ-096)
  }
  onSessionEnd(nowMs: number): void { this.state = "ENDED"; this.endedAtMs = nowMs; }

  /** Call periodically. Decides reaping per REQ-019/096. */
  evaluate(nowMs: number): void {
    if (this.shutdownCalled) return;
    if (this.state === "ENDED" && this.endedAtMs !== null && nowMs - this.endedAtMs >= this.opts.endGraceMs) {
      return this.shutdown("SHUTDOWN");
    }
    // (b) pid death is the primary terminal signal.
    let alive: boolean | null;
    try { alive = this.opts.pidAlive(); } catch { alive = null; }
    if (alive === false) return this.shutdown("ENDED");
    // (c) idle backstop only when liveness is unconfirmable.
    if (alive === null && nowMs - this.lastEventMs >= this.opts.idleShutdownMs) return this.shutdown("ENDED");
  }

  private shutdown(finalState: RelayLifecycle): void {
    this.shutdownCalled = true; this.state = finalState; this.opts.onShutdown();
  }
}
