/**
 * What the ambient menu SAYS, separately from how SwiftBar is told about it.
 *
 * `renderMenubar` was pure and tested, and what it emitted was SwiftBar's plugin
 * protocol — `sfimage=`, `bash=`/`param1=`, `terminal=false`, `--` for depth.
 * The decisions were in one testable place, which was the point of the hedge,
 * but the OUTPUT was a wire format. Anything else that wanted to draw this menu
 * — a native `NSStatusItem` app, a shell prompt, a test — had to parse that
 * format back out to recover the structure that produced it, which is the wrong
 * direction and exactly the coupling the hedge was meant to avoid.
 *
 * So: `buildMenu` decides, `toSwiftBar` serialises, and `renderMenubar` is their
 * composition. A second host implements a second serialiser against this model
 * and touches nothing else.
 *
 * The model is deliberately not a generic menu abstraction. It carries the seven
 * things astir actually says — text, depth, colour, a symbol and its colour, a
 * monospace flag, and an action — because a model with fields nobody sets is a
 * second thing to keep true.
 */

/** Running astir with arguments. The host decides how to spawn it. */
export interface MenuAction {
  /** `[interpreter, script, ...args]`, already resolved. See `MenubarOpts.invocation`. */
  argv: string[];
  /**
   * Run it in a visible terminal rather than silently.
   *
   * True for exactly one item — starting the daemon — because that one has
   * output worth seeing when it fails, and a silent failure there is the
   * situation the item exists to resolve.
   */
  terminal?: boolean;
}

export interface MenuItem {
  text: string;
  /** 0 is a top-level row; 1 is nested under the row above it. */
  depth: number;
  /**
   * A light/dark pair, as `<light>,<dark>`.
   *
   * Kept as a pair rather than reduced to one value because that reduction is
   * what once made this menu unreadable: every colour had been chosen against a
   * dark menu, so white titles landed on light grey. Primary text sets none at
   * all and inherits the system label colour.
   */
  colour?: string;
  /** An SF Symbol name. */
  symbol?: string;
  symbolColour?: string;
  monospace?: boolean;
  action?: MenuAction;
  /** Clicking re-runs the plugin. SwiftBar's `refresh=true` with no command. */
  refresh?: boolean;
}

/** A rule between groups. Hosts that cannot draw one may ignore it. */
export interface MenuSeparator {
  separator: true;
}

export type MenuNode = MenuItem | MenuSeparator;

export const isSeparator = (n: MenuNode): n is MenuSeparator => "separator" in n;

export interface Menu {
  /**
   * What shows in the bar itself — usually a count or a dot, never a sentence.
   * Separate from `items` because it is the one part a host MUST render; the
   * dropdown is optional in a way the status item is not.
   */
  badge: MenuItem;
  items: MenuNode[];
}

/** Collects nodes, so each call site states what it means rather than how it prints. */
export class MenuBuilder {
  private readonly nodes: MenuNode[] = [];

  push(item: MenuItem): void {
    this.nodes.push(item);
  }

  /**
   * A rule, unless the last node is already one.
   *
   * SwiftBar renders two consecutive separators as a visible double rule, and
   * the sections here are conditional — so a group that renders nothing would
   * otherwise leave its separator behind next to the following one's.
   */
  separator(): void {
    if (this.nodes.length === 0) return;
    const last = this.nodes.at(-1);
    if (last !== undefined && isSeparator(last)) return;
    this.nodes.push({ separator: true });
  }

  /**
   * An unconditional rule.
   *
   * Distinct from `separator()`, which collapses a repeat. Both existed in the
   * original — a deduping helper and raw pushes — and preserving the difference
   * is what keeps this refactor faithful rather than an improvement smuggled in
   * under one.
   */
  rule(): void {
    this.nodes.push({ separator: true });
  }

  build(): MenuNode[] {
    return this.nodes;
  }
}

/** SwiftBar treats `|` as the start of parameters, so it cannot appear in text. */
function safe(text: string): string {
  return text.replace(/\|/g, "¦").replace(/\n/g, " ");
}

function attrs(item: MenuItem): string {
  const parts: string[] = [];
  if (item.colour !== undefined) parts.push(`color=${item.colour}`);
  if (item.symbol !== undefined) parts.push(`sfimage=${item.symbol}`);
  if (item.symbolColour !== undefined) parts.push(`sfcolor=${item.symbolColour}`);
  if (item.monospace === true) parts.push("font=Menlo");
  if (item.refresh === true && item.action === undefined) parts.push("refresh=true");
  if (item.action !== undefined) {
    const [command = "", ...rest] = item.action.argv;
    // `param1` is the script because `bash=` is the interpreter — SwiftBar
    // launches from launchd, whose PATH has never heard of a version manager.
    const params = rest.map((value, i) => `param${i + 1}=${value}`);
    parts.push(
      item.action.terminal === true
        ? `bash=${command} ${params.join(" ")} terminal=true`
        : `bash=${command} ${params.join(" ")} terminal=false refresh=true`,
    );
  }
  return parts.join(" ");
}

function line(item: MenuItem): string {
  const prefix = item.depth > 0 ? `${"--".repeat(item.depth)} ` : "";
  const rendered = attrs(item);
  return `${prefix}${safe(item.text)}${rendered === "" ? "" : ` | ${rendered}`}`;
}

/**
 * The SwiftBar/xbar plugin format: the badge, then `---`, then the dropdown.
 *
 * The only place in astir that knows this protocol.
 */
export function toSwiftBar(menu: Menu): string {
  const out = [line(menu.badge), "---"];
  for (const node of menu.items) out.push(isSeparator(node) ? "---" : line(node));
  return out.join("\n");
}
