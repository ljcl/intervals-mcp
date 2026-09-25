import { isRunning, isSwimming, smooth } from "@intervals-mcp/data";
import {
  type ActivityStreamData,
  type AlignedPoint,
  type AxisKey,
  type MetricKey,
} from "./types";

/**
 * Unit family for the pace metric. Pace (min/km, min/100m) is only meaningful
 * when BOTH activities are in the same pace sport; any mixed pair falls back
 * to speed (km/h) so the two lines share one y-axis unit.
 */
export type PaceCategory = "run" | "swim" | "speed";

export function paceCategory(typeA: string, typeB: string): PaceCategory {
  if (isRunning(typeA) && isRunning(typeB)) return "run";
  if (isSwimming(typeA) && isSwimming(typeB)) return "swim";
  return "speed";
}

export function paceMetricLabel(category: PaceCategory): string {
  return category === "speed" ? "Speed" : "Pace";
}

export function paceMetricUnit(category: PaceCategory): string {
  return category === "run" ? "min/km" : category === "swim" ? "/100m" : "km/h";
}

/** Per-sample metric values, index-aligned with the `time`/`distance` axes.
 * `null` is a genuine gap in the recording (kept, not fabricated). */
export interface MetricSeries {
  time: number[];
  distance?: number[];
  values: Partial<Record<MetricKey, Array<number | null>>>;
}

/**
 * Convert one activity's raw streams into chartable metric arrays:
 * - velocity_smooth → pace (min/km or min/100m, capped to avoid stopped
 *   spikes) or speed (km/h), per the shared pace category
 * - cadence doubled for running (Strava reports strides/min for runs)
 * - all-zero altitude dropped (common for treadmill/trainer activities)
 */
export function toMetricSeries(
  data: ActivityStreamData,
  category: PaceCategory,
): MetricSeries {
  const { streams } = data;
  const time = streams.time ?? [];
  const len = time.length;
  const series: MetricSeries = { time, values: {} };
  if (len === 0) return series;

  if (streams.distance?.length === len) {
    series.distance = streams.distance;
  }

  if (streams.velocity_smooth?.length === len) {
    series.values.pace = streams.velocity_smooth.map((mps) => {
      // A missing speed sample is a gap, not a "stopped" reading, so it
      // must not be capped into a fake pace/speed spike.
      if (mps == null) return null;
      if (category === "run") {
        return mps > 0 ? Math.min(1000 / mps / 60, 15) : 15;
      }
      if (category === "swim") {
        return mps > 0 ? Math.min(100 / mps / 60, 5) : 5;
      }
      return mps * 3.6;
    });
  }

  if (streams.heartrate?.length === len) {
    series.values.heartrate = streams.heartrate;
  }
  if (streams.watts?.length === len) {
    series.values.power = streams.watts;
  }
  if (streams.cadence?.length === len) {
    const doubled = isRunning(data.activityType);
    // A null sample must stay null: never become 0 via `null * 2`.
    series.values.cadence = streams.cadence.map((c) =>
      c == null ? null : doubled ? c * 2 : c,
    );
  }
  if (
    streams.altitude?.length === len &&
    streams.altitude.some((a) => a != null && a !== 0)
  ) {
    series.values.altitude = streams.altitude;
  }

  return series;
}

const METRIC_ORDER: MetricKey[] = [
  "pace",
  "heartrate",
  "power",
  "cadence",
  "altitude",
];

/** Metrics present in BOTH activities — a diff needs both sides. */
export function sharedMetrics(a: MetricSeries, b: MetricSeries): MetricKey[] {
  return METRIC_ORDER.filter(
    (key) =>
      a.values[key]?.some((v) => v != null) &&
      b.values[key]?.some((v) => v != null),
  );
}

/** Axes both activities can be aligned on (time always; distance if recorded). */
export function sharedAxes(a: MetricSeries, b: MetricSeries): AxisKey[] {
  const axes: AxisKey[] = [];
  if (a.distance && b.distance) axes.push("distance");
  if (a.time.length > 0 && b.time.length > 0) axes.push("time");
  return axes;
}

/**
 * Linear interpolation over a monotonically non-decreasing x array. Returns
 * undefined outside the sampled domain (so a shorter activity's line ends
 * instead of extrapolating) or when a bracketing value is missing,
 * including a real recorded gap (`null`), which must not be interpolated
 * across into a fabricated value.
 */
function interpolate(
  xs: number[],
  vs: Array<number | null | undefined>,
  x: number,
): number | undefined {
  const len = xs.length;
  if (len === 0 || x < xs[0]! || x > xs[len - 1]!) return undefined;

  let lo = 0;
  let hi = len - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= x) lo = mid;
    else hi = mid;
  }

  const v0 = vs[lo];
  const v1 = vs[hi];
  if (v0 == null || v1 == null) return undefined;
  const dx = xs[hi]! - xs[lo]!;
  if (dx <= 0) return v0;
  return v0 + ((v1 - v0) * (x - xs[lo]!)) / dx;
}

const ALIGNED_KEYS = [
  "aPace",
  "bPace",
  "aHeartrate",
  "bHeartrate",
  "aPower",
  "bPower",
  "aCadence",
  "bCadence",
  "aAltitude",
  "bAltitude",
] as const;

export function alignedKey(
  side: "a" | "b",
  metric: MetricKey,
): keyof AlignedPoint {
  const suffix = metric.charAt(0).toUpperCase() + metric.slice(1);
  return `${side}${suffix}` as keyof AlignedPoint;
}

/** Grid density: plenty for a ~700px plot, light enough for mobile. */
const DEFAULT_POINT_COUNT = 240;

/** Smoothing window (in grid points) applied after resampling. */
const SMOOTH_WINDOW = 5;

/**
 * Resample both activities onto one uniform x grid spanning the longer of
 * the two, so Recharts renders them as two lines with a genuinely shared
 * axis and the tooltip can show a per-point delta. Values are lightly
 * smoothed after resampling — two raw per-second traces overlaid are
 * unreadably noisy.
 */
export function alignSeries(
  a: MetricSeries,
  b: MetricSeries,
  axis: AxisKey,
  pointCount = DEFAULT_POINT_COUNT,
): AlignedPoint[] {
  const xA = axis === "distance" ? a.distance : a.time;
  const xB = axis === "distance" ? b.distance : b.time;
  if (!xA?.length || !xB?.length) return [];

  const maxX = Math.max(xA[xA.length - 1]!, xB[xB.length - 1]!);
  if (maxX <= 0) return [];
  const step = maxX / (pointCount - 1);

  const points: AlignedPoint[] = [];
  for (let i = 0; i < pointCount; i += 1) {
    const x = i * step;
    const point: AlignedPoint = { x };
    for (const metric of METRIC_ORDER) {
      const vA = a.values[metric];
      if (vA) {
        const v = interpolate(xA, vA, x);
        if (v !== undefined) point[alignedKey("a", metric)] = v;
      }
      const vB = b.values[metric];
      if (vB) {
        const v = interpolate(xB, vB, x);
        if (v !== undefined) point[alignedKey("b", metric)] = v;
      }
    }
    points.push(point);
  }

  return smooth(points, ALIGNED_KEYS, SMOOTH_WINDOW);
}
