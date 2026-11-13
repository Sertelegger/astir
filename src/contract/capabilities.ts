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
   * #86 — how long a permission dialog has been on screen, at least, when the
   * provider's `permission_prompt` notification arrives. The block it begins
   * is dated that far back (never before the agent's previous state began),
   * so PSH-16's dwell counts from about when the dialog appeared rather than
   * from a notification that is itself a dwell. 0 when the notification is
   * the ask itself.
   *
   * Must not exceed the provider's shortest measured notice delay: dated
   * further back than the dialog has existed, the dwell would be spent on
   * time nobody was asked anything (pinned by test/permission-block.test.ts).
   */
  promptNoticeAgeMs: number;
  /**
   * #86 — the provider's session listing says when a dialog is gone, so it
   * can end a `permission_prompt` block that no hook ends. The lister
   * translates its words into `DiscoveredSession.screen`; the registry reads
   * only that.
   */
  listingEndsPermissionBlocks: boolean;
}

export const CAPABILITIES: Record<Provider, ProviderCapabilities> = {
  claude: {
    // The `defaultMode: auto` classifier answers in hundreds of milliseconds.
    blockDwellMs: 5_000,
    fileWatch: true,
    liveness: "listing",
    // Claude sends `permission_prompt` once a dialog has been left alone for
    // 6 s: 5983-6125 ms after its PermissionRequest (n=53), the dialog on
    // screen from 9 ms before to 244 ms after that hook (n=45). A key at the
    // dialog restarts the check (12 or 18 s). Claude Code 2.1.322,
    // test/fixtures/claude/permission-capture.json. 5 s keeps ~0.9 s of margin.
    promptNoticeAgeMs: 5_000,
    // `claude agents --json` read `idle` on the first poll after Esc (20/20),
    // which fires no hook at all, and left `waiting` on the first poll after
    // an approval (11/11). Same capture.
    listingEndsPermissionBlocks: true,
  },
  codex: {
    // Its automatic reviewer answered the captured auto-reviewed request after
    // ~11.9s (test/fixtures/codex/capture.json). 5s would have alerted on it.
    blockDwellMs: 30_000,
    fileWatch: false,
    // No session listing exists (verified against rust-v0.154.0).
    liveness: "pid",
    // Codex's `permission_prompt` is its PermissionRequest hook, sent before
    // its automatic reviewer answers (test/fixtures/codex/capture.json): the
    // ask itself, not a report of one that has waited.
    promptNoticeAgeMs: 0,
    // No listing to read, and Codex reports its own Esc (`Interrupt`).
    listingEndsPermissionBlocks: false,
  },
};
