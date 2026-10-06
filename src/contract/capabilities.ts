/**
 * §6 / G5 — what each provider can tell astir, declared in one place.
 *
 * CAP-02: the daemon and the views branch on these, never on a provider's
 * name. Keyed by `Provider`, so adding a provider without declaring them is a
 * compile error rather than a silent default.
 *
 * Measured, not assumed: every value here cites what it was measured from.
 */

import type { Provider } from "./event.js";

export interface ProviderCapabilities {
  /**
   * PSH-16 — how long a permission block must last before it is worth
   * interrupting anyone. It has to outlast the provider's own automatic
   * answer, so it is a property of that answerer, not a constant.
   */
  blockDwellMs: number;
  /**
   * CAP-06 — the provider watches the paths astir names and reports
   * shell-driven writes (Claude's `FileChanged`). Without it, answering
   * SessionStart with a path list is a repo walk on a synchronous hook for a
   * field nothing on the other side reads.
   */
  fileWatch: boolean;
  /**
   * DMN-05 — how astir learns a session is still running. `listing`: the
   * provider lists its sessions (`claude agents --json`). `pid`: it cannot,
   * so a session is vouched for by the pid its hook relay reported
   * (`discovery/pids.ts`) — and one with no pid yet is one discovery could
   * never have seen, so its silence proves nothing.
   */
  liveness: "listing" | "pid";
}

export const CAPABILITIES: Record<Provider, ProviderCapabilities> = {
  claude: {
    // The `defaultMode: auto` classifier answers in hundreds of milliseconds.
    blockDwellMs: 5_000,
    fileWatch: true,
    liveness: "listing",
  },
  codex: {
    // Its automatic reviewer answered the one captured request after ~11.9s
    // (test/fixtures/codex/capture.json). 5s would have alerted on it.
    blockDwellMs: 30_000,
    fileWatch: false,
    // No session listing exists (verified against rust-v0.154.0).
    liveness: "pid",
  },
};
