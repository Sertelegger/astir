/**
 * §6 / G5 — what each provider can tell astir, declared in one place.
 *
 * CAP-02: the daemon and the views branch on these, never on a provider's
 * name. Keyed by `Provider`, so adding a provider without declaring them is a
 * compile error rather than a silent default.
 *
 * Measured, not assumed: every value here cites what it was measured from.
 */

import type { Provider } from "../contract/event.js";

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
}

export const CAPABILITIES: Record<Provider, ProviderCapabilities> = {
  claude: {
    // The `defaultMode: auto` classifier answers in hundreds of milliseconds.
    blockDwellMs: 5_000,
    fileWatch: true,
  },
  codex: {
    // Its automatic reviewer answered the one captured request after ~11.9s
    // (test/fixtures/codex/capture.json). 5s would have alerted on it.
    blockDwellMs: 30_000,
    fileWatch: false,
  },
};
