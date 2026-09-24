/** Cold-to-hot ramp used by route-map's metric-coloured track. Fixed hex
 * stops (interpolation needs concrete colours, and these read on light and
 * dark backgrounds). Pure: no React, no DOM. */
const RAMP: Array<[number, number, number]> = [
  [37, 99, 235], // blue
  [22, 163, 74], // green
  [234, 179, 8], // yellow
  [220, 38, 38], // red
];

/** CSS gradient matching the ramp, for a scale legend bar. */
export const RAMP_GRADIENT_CSS = `linear-gradient(90deg, ${RAMP.map(
  ([r, g, b]) => `rgb(${r}, ${g}, ${b})`,
).join(", ")})`;

/** Map a normalized position 0..1 onto the ramp. Clamps out-of-range input. */
export function rampColor(t: number): string {
  const clamped = Math.min(1, Math.max(0, t));
  const scaled = clamped * (RAMP.length - 1);
  const lo = Math.min(RAMP.length - 2, Math.floor(scaled));
  const frac = scaled - lo;
  const [r1, g1, b1] = RAMP[lo]!;
  const [r2, g2, b2] = RAMP[lo + 1]!;
  const mix = (a: number, b: number) => Math.round(a + (b - a) * frac);
  return `rgb(${mix(r1, r2)}, ${mix(g1, g2)}, ${mix(b1, b2)})`;
}

/** Color domain from the 5th..95th percentiles, so an outlier doesn't flatten
 * the ramp across the rest of the data. */
export function percentileDomain(values: number[]): {
  min: number;
  max: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { min: at(0.05), max: at(0.95) };
}

/** Clamp + scale a value into 0..1 within [min,max]; 0.5 for a degenerate domain. */
export function normalizeValue(
  value: number,
  min: number,
  max: number,
): number {
  if (max - min < 1e-9) return 0.5;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** Ramp color for one raw value within a {min,max} domain. */
export function colorForValue(
  domain: { min: number; max: number },
  value: number,
): string {
  return rampColor(normalizeValue(value, domain.min, domain.max));
}
