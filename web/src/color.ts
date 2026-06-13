export const IDLE_COLOR = "rgba(255, 255, 255, 0.06)";
const WARM: [number, number, number] = [255, 180, 90];
const HOT: [number, number, number] = [255, 90, 40];

/** Heat normalized to the current max leaf heat (REQ-022). 0 when max is 0. */
export function normalizeHeat(heat: number, maxLeafHeat: number): number {
  if (maxLeafHeat <= 0) return 0;
  return heat / maxLeafHeat;
}

/** idle at <=0, else linear warm→hot. REQ-022. */
export function heatColor(norm: number): string {
  if (norm <= 0) return IDLE_COLOR;
  const t = Math.min(norm, 1);
  const g = Math.round(WARM[1] + (HOT[1] - WARM[1]) * t);
  const b = Math.round(WARM[2] + (HOT[2] - WARM[2]) * t);
  return `rgb(255, ${g}, ${b})`;
}
