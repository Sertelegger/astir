/**
 * What astir-tui keeps for the session in `$.state`: a count and an id,
 * nothing past the session, nothing drawn from a tool, path or prompt.
 */
declare module "claude-code" {
  interface PluginState {
    "astir-tui": {
      /** The ungated blocked count astir last reported (PSH-16); null when astir could not be read. */
      blocked: number | null;
      /** The id of the session that has completed a turn here, if any. */
      worked: string | null;
    };
  }
}
