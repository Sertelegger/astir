export interface RelayParams { port: number; token: string; }
/** Query string clide-web reads from location.search (?port&token&session). */
export function webviewParams(relay: RelayParams, sessionId: string): string {
  return new URLSearchParams({ port: String(relay.port), token: relay.token, session: sessionId }).toString();
}
