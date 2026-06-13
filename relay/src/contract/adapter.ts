import type { ClideEvent } from "./event.js";
import type { Provider } from "./types.js";

/**
 * The ONE provider-specific seam (REQ-007). PA-claude and PA-codex each implement this.
 * The relay/models/renderers depend only on the emitted ClideEvent + /reasoning, never on a provider.
 */
export interface CaptureAdapter {
  readonly provider: Provider;
  /** Register the provider's hooks (Claude: plugin hooks.json; Codex: ~/.codex/config.toml block). REQ-001/008. */
  installHooks(): void;
  uninstallHooks(): void;
  /** Translate one provider hook payload → normalized event. Sets provider + maps tool→op. */
  normalize(payload: unknown, sessionId: string): ClideEvent;
}

/**
 * The long-lived per-session reasoning tailer (REQ-007a). Started by SessionStart (or `clide watch`),
 * reaped with the relay. It tails the provider transcript and POSTs normalized reasoning to /reasoning.
 */
export interface Tailer {
  readonly provider: Provider;
  /** Begin tailing for a session; resolve the relay port/token from the discovery file. */
  start(sessionId: string, discoveryPath: string): void;
  stop(): void;
}
