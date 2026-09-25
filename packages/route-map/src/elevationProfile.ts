/**
 * Geometry for the elevation strip beneath the map: pure math from the
 * altitude/distance streams into SVG paths plus per-sample x positions so the
 * scrub marker can sync with the track. No React, unit-tested alongside
 * `normalize.ts`.
 */

export interface ElevationProfileOptions {
  /** Strip viewBox width (matches the map's, so x positions line up). */
  width: number;
  /** Strip viewBox height. */
  height: number;
  /** Headroom above the highest point. */
  padTop: number;
}

export interface ElevationProfile {
  /** Open polyline along the elevation samples; breaks (a new "M") at each
   * null gap. */
  linePath: string;
  /**
   * The same polyline as one or more independently closed subpaths (one per
   * contiguous non-null run), each dropped to the strip floor for its own
   * area fill. A gap must not be bridged by a single fill spanning the whole
   * strip, which would shade the missing stretch as if it were real data.
   */
  areaPath: string;
  /** X position per sample index (scrub sync with the track). */
  xs: number[];
  /** Y position per sample index. */
  ys: number[];
  /** Altitude domain in metres. */
  min: number;
  max: number;
}

/** Trim coordinates to 2 dp so the generated path strings stay compact. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Build the strip geometry. X spacing follows the cumulative distance stream
 * when one aligns with the altitude samples (so flat-speed sections don't
 * stretch), falling back to even index spacing. Returns null when there are
 * too few samples to draw a line.
 */
export function buildElevationProfile(
  altitude: ReadonlyArray<number | null>,
  distance: number[] | undefined,
  opts: ElevationProfileOptions,
): ElevationProfile | null {
  const n = altitude.length;
  if (n < 2) return null;

  const { width, height, padTop } = opts;

  let xs: number[];
  const d0 = distance?.[0] ?? 0;
  const dSpan = (distance?.[n - 1] ?? 0) - d0;
  if (distance && distance.length === n && dSpan > 0) {
    xs = distance.map((d) => ((d - d0) / dSpan) * width);
  } else {
    xs = altitude.map((_, i) => (i / (n - 1)) * width);
  }

  let min = Infinity;
  let max = -Infinity;
  for (const a of altitude) {
    if (a == null) continue;
    if (a < min) min = a;
    if (a > max) max = a;
  }
  // Every sample is a gap: nothing to draw.
  if (min === Infinity) return null;

  const span = max - min;
  const drawable = height - padTop;
  // `null` for a gap sample; a fallback midline value only for `ys`'s
  // scrub-marker placement, never fed into the drawn path below.
  const ys = altitude.map((a) =>
    a == null
      ? null
      : // A flat profile sits on a midline rather than collapsing to the floor.
        span > 1e-9
        ? padTop + ((max - a) / span) * drawable
        : height / 2,
  );

  // Break at gaps: group samples into contiguous non-null segments, each
  // drawn (and, for the area fill, closed) independently, so a gap neither
  // connects across as a fabricated line nor gets shaded as if it were real.
  let linePath = "";
  let areaPath = "";
  let segment: Array<{ x: number; y: number }> = [];

  const flushSegment = () => {
    if (segment.length === 0) return;
    const linePart = segment
      .map((p, j) => `${j === 0 ? "M" : "L"}${round(p.x)} ${round(p.y)}`)
      .join(" ");
    linePath += (linePath ? " " : "") + linePart;
    const first = segment[0]!;
    const last = segment[segment.length - 1]!;
    areaPath +=
      (areaPath ? " " : "") +
      `${linePart} L${round(last.x)} ${height} L${round(first.x)} ${height} Z`;
    segment = [];
  };

  for (let i = 0; i < n; i += 1) {
    const y = ys[i];
    if (y == null) {
      flushSegment();
      continue;
    }
    segment.push({ x: xs[i]!, y });
  }
  flushSegment();

  return {
    linePath,
    areaPath,
    xs,
    ys: ys.map((y) => y ?? height / 2),
    min,
    max,
  };
}

/** Index of the sample whose x position is closest to `x`. -1 when empty. */
export function nearestXIndex(xs: number[], x: number): number {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < xs.length; i++) {
    const dist = Math.abs(xs[i]! - x);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}
