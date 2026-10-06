/**
 * What astir-tui keeps for the session in `$.state`: a count, an id, the rows
 * the `/astir` pane draws and the last action's answer. Nothing past the
 * session, nothing drawn from a tool, path or prompt.
 */

/**
 * One row of the `/astir` pane: one of `astir status --line --json`'s `rows`,
 * as astir wrote it, shape-checked and with control characters taken out of
 * the text it draws (`label`, `host`, `state`).
 */
export type PaneRow = {
  /** What `astir focus` and `astir dismiss` are given. Never drawn. */
  sessionId: string;
  /** The machine, when it is not this one. */
  host: string | null;
  /** The repo label astir gives the session. */
  label: string;
  /** astir's word for what it is doing (`blocked`, `idle`, ...); null when astir cannot say. */
  state: string | null;
  /** How long its longest current block has lasted; null when nothing is blocked. */
  waitingMs: number | null;
  /** Every block in it has been dismissed. */
  acknowledged: boolean;
  /** Some block in it has been announced to a human. */
  announced: boolean;
  /** PSH-11: `astir focus` can raise it from here. Never true for another machine's. */
  focusable: boolean;
};

declare module "claude-code" {
  interface PluginState {
    "astir-tui": {
      /** The ungated blocked count astir last reported (PSH-16); null when astir could not be read. */
      blocked: number | null;
      /** The id of the session that has completed a turn here, if any. */
      worked: string | null;
      /**
       * The rows astir last reported, blocked first, in its order; null when the
       * last reading was not a good one. Never the last good rows.
       */
      rows: PaneRow[] | null;
      /**
       * The last action's one-line answer. It stands for a period at least,
       * then until the next good reading begun after that.
       */
      detail: string | null;
    };
  }
}
