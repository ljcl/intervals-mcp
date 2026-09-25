/**
 * Metric coloring for the route track. Pure data + color math, kept free of
 * React so it can be unit-tested next to `normalize.ts`. A metric series wraps
 * one stream (aligned with the track coordinates) with a clamped color domain
 * and a tooltip formatter; `buildTrackSegments` turns the projected points
 * plus a series into binned, same-color SVG path runs so the DOM stays at a
 * handful of `<path>` elements instead of one per GPS sample.
 */

import {
  formatSpeedAsKmh,
  formatSpeedAsPace,
  isRunning,
  normalizeValue,
  percentileDomain,
  rampColor,
} from "@intervals-mcp/data";
import { type Point } from "./normalize";
import { type RouteMapData } from "./types";

export { colorForValue, RAMP_GRADIENT_CSS } from "@intervals-mcp/data";

export type MetricKey =
  | "pace"
  | "heartrate"
  | "power"
  | "altitude"
  | "gradient";

export interface MetricSeries {
  key: MetricKey;
  /** Pill / tooltip label ("Pace" or "Speed" for the pace key). */
  label: string;
  /** Compact pill label for mobile, where five pills must share a card row. */
  shortLabel: string;
  /** Raw per-point values used for coloring, aligned with coordinates.
   * `null` is a genuine recording gap: the colored track breaks there
   * instead of drawing a fabricated color. */
  values: Array<number | null>;
  /** Color domain (percentile-clamped so outliers don't flatten the ramp). */
  min: number;
  max: number;
  /** Format a raw value for the scrub tooltip, unit included. */
  format: (value: number) => string;
}

/** Percentile color domain over only the non-null samples of a stream. A
 * stream with no non-null samples at all degrades to a degenerate [0, 0]
 * domain (`percentileDomain` never sees an empty array). */
function domainOf(values: ReadonlyArray<number | null>): {
  min: number;
  max: number;
} {
  const present = values.filter((v): v is number => v != null);
  return present.length > 0 ? percentileDomain(present) : { min: 0, max: 0 };
}

/**
 * Build the selectable metric series for an activity, in pill display order.
 * Only streams that are present and aligned with the coordinates qualify, so
 * stream-less activities yield an empty list (plain track).
 */
export function buildMetricSeries(data: RouteMapData): MetricSeries[] {
  const streams = data.streams;
  const pointCount = data.coordinates.length;
  if (!streams || pointCount === 0) return [];

  const aligned = (
    values: Array<number | null> | undefined,
  ): Array<number | null> | null =>
    values && values.length === pointCount ? values : null;

  const running = data.activityType ? isRunning(data.activityType) : false;
  const series: MetricSeries[] = [];

  const velocity = aligned(streams.velocity_smooth);
  if (velocity) {
    series.push({
      key: "pace",
      label: running ? "Pace" : "Speed",
      shortLabel: running ? "Pace" : "Speed",
      values: velocity,
      ...domainOf(velocity),
      format: running ? formatSpeedAsPace : formatSpeedAsKmh,
    });
  }

  const heartrate = aligned(streams.heartrate);
  if (heartrate) {
    series.push({
      key: "heartrate",
      label: "Heart rate",
      shortLabel: "HR",
      values: heartrate,
      ...domainOf(heartrate),
      format: (v) => `${Math.round(v)} bpm`,
    });
  }

  const watts = aligned(streams.watts);
  if (watts) {
    series.push({
      key: "power",
      label: "Power",
      shortLabel: "Power",
      values: watts,
      ...domainOf(watts),
      format: (v) => `${Math.round(v)} W`,
    });
  }

  const altitude = aligned(streams.altitude);
  if (altitude) {
    series.push({
      key: "altitude",
      label: "Elevation",
      shortLabel: "Elev",
      values: altitude,
      ...domainOf(altitude),
      format: (v) => `${Math.round(v)} m`,
    });
  }

  const grade = aligned(streams.grade_smooth);
  if (grade) {
    series.push({
      key: "gradient",
      label: "Gradient",
      shortLabel: "Grade",
      values: grade,
      ...domainOf(grade),
      format: (v) => `${v.toFixed(1)} %`,
    });
  }

  return series;
}

export interface TrackSegment {
  /** SVG path `d` string for one same-color run of the track. */
  path: string;
  color: string;
}

/** Distinct hues along the track; more bins means more paths in the DOM. */
const COLOR_BINS = 12;

/** Trim coordinates to 2 dp so the generated path strings stay compact. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * One run of consecutive track legs sharing a color bin, as an inclusive
 * index range over the track samples. Renderer-agnostic: the SVG view turns
 * runs into paths, the basemap view into GeoJSON line features.
 */
export interface ColorRun {
  /** Index of the run's first sample. */
  startIndex: number;
  /** Index of the run's last sample (inclusive; shared with the next run). */
  endIndex: number;
  color: string;
}

/**
 * Group consecutive same-color-bin legs into runs. Each leg is colored by the
 * midpoint of its endpoint values; adjacent runs share their boundary sample,
 * so there are no gaps between strokes. A leg with either endpoint `null`
 * (a recording gap) gets no bin at all and is skipped entirely: a break in
 * the colored track rather than a fabricated color.
 */
export function buildColorRuns(
  series: Pick<MetricSeries, "values" | "min" | "max">,
  sampleCount: number,
): ColorRun[] {
  const { values, min, max } = series;
  if (sampleCount < 2 || values.length !== sampleCount) return [];

  /** Color bin for the leg starting at `i`, or `null` when either endpoint
   * is a gap: never a valid bin index (0..COLOR_BINS - 1). */
  const binOf = (i: number): number | null => {
    const v0 = values[i];
    const v1 = values[i + 1];
    if (v0 == null || v1 == null) return null;
    const t = normalizeValue((v0 + v1) / 2, min, max);
    return Math.min(COLOR_BINS - 1, Math.floor(t * COLOR_BINS));
  };

  const runs: ColorRun[] = [];
  let runStart = 0;
  let runBin = binOf(0);
  for (let i = 1; i <= sampleCount - 1; i++) {
    const isLast = i === sampleCount - 1;
    const bin = isLast ? -1 : binOf(i);
    if (bin === runBin && !isLast) continue;
    if (runBin !== null) {
      runs.push({
        startIndex: runStart,
        endIndex: i,
        color: rampColor((runBin + 0.5) / COLOR_BINS),
      });
    }
    runStart = i;
    runBin = bin;
  }
  return runs;
}

/**
 * Split the projected track into runs of consecutive segments that fall into
 * the same color bin, each run emitted as a single path.
 */
export function buildTrackSegments(
  points: Point[],
  series: Pick<MetricSeries, "values" | "min" | "max">,
): TrackSegment[] {
  return buildColorRuns(series, points.length).map((run) => ({
    path: points
      .slice(run.startIndex, run.endIndex + 1)
      .map((p, j) => `${j === 0 ? "M" : "L"}${round(p.x)} ${round(p.y)}`)
      .join(" "),
    color: run.color,
  }));
}
