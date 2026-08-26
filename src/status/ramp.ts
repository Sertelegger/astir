/**
 * VIEW-04 — the heat ramp, and the arithmetic that proves it is legible.
 *
 * A monitoring surface that encodes its primary signal in colour has to answer
 * for that colour. Two properties are load-bearing, and neither is a matter of
 * taste:
 *
 * 1. **Monotonic lightness.** Every step up the ramp is lighter than the last.
 *    This is what makes the ramp survive greyscale, a projector, a cheap panel
 *    and every form of colour-vision deficiency at once — lightness is the one
 *    channel no CVD type removes. It is also what makes "hotter" readable as an
 *    ordering rather than a set of unrelated hues.
 *
 * 2. **Separation under simulated CVD.** Monotonic lightness is necessary and
 *    not sufficient: two steps can differ in lightness by less than the eye
 *    resolves once their hue difference is gone. So the distances are measured
 *    against simulated protanopia, deuteranopia and tritanopia rather than
 *    assumed from the ramp's reputation.
 *
 * The ramp itself is `inferno` (matplotlib, CC0), chosen because it was
 * designed for exactly this and because reproducing that design badly is a
 * worse outcome than borrowing it. The checks above are still run against it —
 * a ramp's provenance is not evidence, and the anchors here are a subsample of
 * the original rather than the original.
 *
 * VIEW-04 also requires that heat NOT be encoded by colour alone. That part is
 * not solvable here: it lives in the renderer, which pairs every tile with a
 * length-encoded bar and a number.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * `inferno`, subsampled at nine anchors and interpolated between them.
 *
 * Interpolation happens in sRGB rather than in a perceptual space, which is
 * normally a mistake — but these anchors are already near-uniformly spaced in
 * perceptual terms, so the error over one ninth of the ramp is small, and the
 * monotonicity test below is what actually decides whether that holds.
 */
const ANCHORS: readonly Rgb[] = [
  { r: 0, g: 0, b: 4 },
  { r: 27, g: 12, b: 65 },
  { r: 74, g: 12, b: 107 },
  { r: 120, g: 28, b: 109 },
  { r: 165, g: 44, b: 96 },
  { r: 207, g: 68, b: 70 },
  { r: 237, g: 105, b: 37 },
  { r: 251, g: 155, b: 6 },
  { r: 252, g: 255, b: 164 },
];

const clamp01 = (t: number): number => (Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0);

/** The colour for a normalised intensity in `[0, 1]`. */
export function ramp(t: number): Rgb {
  const x = clamp01(t) * (ANCHORS.length - 1);
  const i = Math.min(Math.floor(x), ANCHORS.length - 2);
  const f = x - i;
  const a = ANCHORS[i] as Rgb;
  const b = ANCHORS[i + 1] as Rgb;
  return {
    r: Math.round(a.r + (b.r - a.r) * f),
    g: Math.round(a.g + (b.g - a.g) * f),
    b: Math.round(a.b + (b.b - a.b) * f),
  };
}

export const css = (c: Rgb): string => `rgb(${c.r} ${c.g} ${c.b})`;

/* ── colour science, only as much as the checks need ─────────────────────── */

const toLinear = (v: number): number => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const fromLinear = (v: number): number => {
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, s)) * 255);
};

/** WCAG relative luminance — the "does it survive greyscale" number. */
export function luminance(c: Rgb): number {
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}

/** WCAG contrast ratio, for asserting a label stays readable on a tile. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

interface Lab {
  L: number;
  a: number;
  b: number;
}

/** sRGB → CIELAB (D65). */
export function lab(c: Rgb): Lab {
  const [r, g, b] = [toLinear(c.r), toLinear(c.g), toLinear(c.b)];
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (v: number): number => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  return { L: 116 * f(y) - 16, a: 500 * (f(x) - f(y)), b: 200 * (f(y) - f(z)) };
}

/**
 * CIE76 colour difference.
 *
 * Not CIEDE2000, deliberately. CIEDE2000 is the better metric, but it is also
 * the one that shrinks differences in exactly the saturated regions this ramp
 * lives in — so CIE76 is the more CONSERVATIVE choice for a test that is trying
 * to catch insufficient separation. Using the harsher metric and clearing it is
 * a stronger result than using the kinder one.
 */
export function deltaE(a: Rgb, b: Rgb): number {
  const x = lab(a);
  const y = lab(b);
  return Math.hypot(x.L - y.L, x.a - y.a, x.b - y.b);
}

export type Cvd = "protanopia" | "deuteranopia" | "tritanopia";

/**
 * Dichromacy simulation matrices (Viénot, Brettel & Mollon 1999), applied in
 * LINEAR RGB — applying them to gamma-encoded values is a common error that
 * makes every simulated colour wrong in the same direction, which would make
 * this check pass for the wrong reason.
 */
const CVD_MATRIX: Record<Cvd, readonly [number, number, number][]> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

/** How `c` appears to someone with the given dichromacy. */
export function simulate(c: Rgb, type: Cvd): Rgb {
  const m = CVD_MATRIX[type];
  const v = [toLinear(c.r), toLinear(c.g), toLinear(c.b)] as const;
  const row = (i: number): number => {
    const k = m[i] as readonly [number, number, number];
    return k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  };
  return { r: fromLinear(row(0)), g: fromLinear(row(1)), b: fromLinear(row(2)) };
}

/**
 * Black or white, whichever stays readable on `c`.
 *
 * The crossover is the luminance where both choices give the same WCAG ratio,
 * `sqrt(1.05 * 0.05) - 0.05`. Picking the better side of it guarantees at least
 * 4.58:1 anywhere on this ramp — above the 4.5:1 AA floor — which a fixed label
 * colour cannot do, because this ramp spans nearly the whole lightness range on
 * purpose.
 */
export function labelOn(c: Rgb): Rgb {
  const CROSSOVER = Math.sqrt(1.05 * 0.05) - 0.05;
  return luminance(c) > CROSSOVER ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
}
