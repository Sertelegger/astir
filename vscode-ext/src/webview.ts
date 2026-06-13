import type { WorkspaceRelay } from "./resolve.js";

/** Query string clide-web reads from location.search (?port&token&session). Returns URLSearchParams.toString() value (no leading ?). */
export function webviewParams(relay: Pick<WorkspaceRelay, "port" | "token">, sessionId: string): string {
  return new URLSearchParams({ port: String(relay.port), token: relay.token, session: sessionId }).toString();
}
