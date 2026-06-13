export type ColorMode = "truecolor" | "256" | "mono";

export function detectColorMode(env: Record<string, string | undefined>): ColorMode {
  if (env.NO_COLOR !== undefined || env.TERM === "dumb") return "mono";
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return "truecolor";
  return "256";
}

const WARM: [number, number, number] = [255, 180, 90];
const HOT: [number, number, number] = [255, 90, 40];

/** One heat-colored block char (REQ-062). mono → plain glyph; idle → faint. */
export function heatBlock(norm: number, mode: ColorMode, ch = "█"): string {
  const t = Math.min(Math.max(norm, 0), 1);
  if (mode === "mono") return t <= 0 ? "·" : "#";
  if (t <= 0) return `\x1b[2m·\x1b[0m`;
  if (mode === "truecolor") {
    const g = Math.round(WARM[1] + (HOT[1] - WARM[1]) * t);
    const b = Math.round(WARM[2] + (HOT[2] - WARM[2]) * t);
    return `\x1b[38;2;255;${g};${b}m${ch}\x1b[0m`;
  }
  const code = Math.round(222 - (222 - 196) * t); // warm→red in the 256 cube
  return `\x1b[38;5;${code}m${ch}\x1b[0m`;
}
