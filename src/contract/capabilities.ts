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
  /**
   * #86 — the provider's session listing says whether a permission dialog is
   * on screen, which no hook does for every way one opens or ends.
   *
   * Measured on Claude Code 2.1.291/2.1.312 (`claude agents --json`, polled by
   * DMN-05): `waiting` while a dialog is open, `idle` once Esc dismissed it or
   * the turn ended, `busy` while working. `waitingFor` says what a `waiting`
   * session waits for — `"permission prompt"` for a tool's dialog, by the
   * binary. Two hooks leave gaps it fills:
   *
   * - `PermissionRequest` is a claim, not a sighting — Claude also fires it for
   *   asks that never show a dialog (read from the 2.1.312 binary) — so a
   *   claimed dialog blocks once the listing, or the Notification, has seen it.
   * - Esc at a dialog fires no hook at all (no `PermissionDenied`, `Stop`,
   *   `StopFailure` or `PostToolUseFailure`), and an approved tool fires
   *   nothing until it finishes. Without the listing, a dismissed prompt stays
   *   blocked and reminding until the session's next event, and a long
   *   approved tool reads as unanswered.
   *
   * `waiting` for anything else is not evidence: an MCP elicitation queued
   * behind a dialog reads `waiting` / `"input needed"` for as long as it
   * waits, whatever else is happening. The provider's lister translates these
   * words into astir's (`DiscoveredSession.screen`; Claude's in
   * `discovery/sessions.ts`), and the registry turns those into transitions
   * (`reconcile`), never reading a provider's own (CAP-02).
   */
  listingClearsBlocks: boolean;
}

export const CAPABILITIES: Record<Provider, ProviderCapabilities> = {
  claude: {
    // The `defaultMode: auto` classifier answers in hundreds of milliseconds.
    // Measured since #86, an approval it gives without a dialog fires no
    // `PermissionRequest` at all. A dialog that is seen blocks from its
    // `PermissionRequest`, so the dwell now runs from the moment the dialog
    // was claimed rather than from the `Notification` ~6 s after it, and still
    // absorbs any automatic answer that does follow a block.
    blockDwellMs: 5_000,
    fileWatch: true,
    liveness: "listing",
    listingClearsBlocks: true,
  },
  codex: {
    // Its automatic reviewer answered the captured auto-reviewed request after
    // ~11.9s (test/fixtures/codex/capture.json). 5s would have alerted on it.
    blockDwellMs: 30_000,
    fileWatch: false,
    // No session listing exists (verified against rust-v0.154.0).
    liveness: "pid",
    // Nothing to read: its pid lister reports no status. Codex says Esc itself
    // (`Interrupt`), so it does not need one.
    listingClearsBlocks: false,
  },
};
