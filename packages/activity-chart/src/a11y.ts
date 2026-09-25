import { formatPace, formatTime } from "@intervals-mcp/data";
import { METRIC_LABELS } from "./contextSummary";
import {
  type ActivityMeta,
  type ChartDataPoint,
  type DynamicsMetricKey,
  type MetricKey,
} from "./types";

/** Running-dynamics metrics: narrated as averages (see `describeDynamicsSeries`),
 * never as a min-max range: the typical value is what matters, not the spread. */
const DYNAMICS_KEYS = new Set<MetricKey>([
  "stanceTime",
  "verticalOscillation",
  "verticalRatio",
  "stepLength",
]);

function isDynamicsKey(key: MetricKey): key is DynamicsMetricKey {
  return DYNAMICS_KEYS.has(key);
}

/** Mean of a metric's non-null samples, or `null` if every sample is a gap. */
export function seriesAverage(
  data: ChartDataPoint[],
  key: MetricKey,
): number | null {
  let sum = 0;
  let count = 0;
  for (const point of data) {
    const value = point[key];
    if (value == null) continue;
    sum += value;
    count += 1;
  }
  return count === 0 ? null : sum / count;
}

export function describeDynamicsSeries(
  key: DynamicsMetricKey,
  average: number,
): string {
  switch (key) {
    case "stanceTime":
      return `Ground contact time averages ${Math.round(average)} ms.`;
    case "verticalOscillation":
      return `Vertical oscillation averages ${average.toFixed(1)} mm.`;
    case "verticalRatio":
      return `Vertical ratio averages ${average.toFixed(1)}%.`;
    case "stepLength":
      return `Step length averages ${Math.round(average)} mm.`;
  }
}

/**
 * Screen-reader narration for the activity chart. Recharts'
 * accessibilityLayer provides keyboard focus and arrow-key tooltip stepping,
 * but the SVG carries no accessible name or content summary of its own.
 * These strings feed the chart's `title`/`desc` props (rendered as SVG
 * <title>/<desc>), mirroring route-map's a11yDescription.ts: what the chart
 * shows, over what extent, and the value range of each visible series.
 */
export interface ChartA11yInput {
  meta: ActivityMeta;
  data: ChartDataPoint[];
  /** Metrics with data that are currently drawn, in render order. */
  visibleMetrics: MetricKey[];
  /** Laps drawn as shaded bands (zero-width swim rests already excluded). */
  lapCount?: number;
  smoothed?: boolean;
  /**
   * Metrics the activity recorded but this layout does not draw.
   * Grade is dropped on mobile because it crowds the altitude axis, which
   * silently made the same activity look like it had different data
   * depending on device. Naming the omission costs no pixels.
   */
  omittedMetrics?: MetricKey[];
}

function seriesRange(
  data: ChartDataPoint[],
  key: MetricKey,
): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const point of data) {
    const value = point[key];
    if (value == null) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min === Infinity ? null : { min, max };
}

function describeSeries(
  key: Exclude<MetricKey, DynamicsMetricKey>,
  range: { min: number; max: number },
  meta: ActivityMeta,
): string {
  switch (key) {
    case "heartrate":
      return `Heart rate ranges from ${Math.round(range.min)} to ${Math.round(range.max)} bpm.`;
    case "power":
      return `Power ranges from ${Math.round(range.min)} to ${Math.round(range.max)} W.`;
    case "pace":
      if (meta.isRunning || meta.isSwimming) {
        const unit = meta.isSwimming ? "per 100 m" : "min/km";
        // min is the fastest split; narrate fastest-to-slowest.
        return `Pace ranges between ${formatPace(range.min)} and ${formatPace(range.max)} ${unit}.`;
      }
      return `Speed ranges from ${range.min.toFixed(1)} to ${range.max.toFixed(1)} km/h.`;
    case "altitude":
      return `Altitude ranges from ${Math.round(range.min)} to ${Math.round(range.max)} m.`;
    case "cadence":
      return `Cadence ranges from ${Math.round(range.min)} to ${Math.round(range.max)} ${meta.isRunning ? "spm" : "rpm"}.`;
    case "grade":
      return `Grade ranges from ${range.min.toFixed(1)}% to ${range.max.toFixed(1)}%.`;
  }
}

export function buildChartA11yTitle(meta: ActivityMeta): string {
  return `Chart of ${meta.activityType} activity "${meta.name}"`;
}

export function buildChartA11yDescription(input: ChartA11yInput): string {
  const { meta, data, visibleMetrics, lapCount, smoothed, omittedMetrics } =
    input;
  const parts: string[] = [];

  const lastPoint = data[data.length - 1];
  if (meta.isSwimming && lastPoint?.distance !== undefined) {
    parts.push(`Chart over ${Math.round(lastPoint.distance)} m, by distance.`);
  } else if (lastPoint) {
    parts.push(`Chart over ${formatTime(lastPoint.time)}, by time.`);
  }

  const described = visibleMetrics
    .map((key) => {
      if (isDynamicsKey(key)) {
        const average = seriesAverage(data, key);
        return average === null ? null : describeDynamicsSeries(key, average);
      }
      const range = seriesRange(data, key);
      return range ? describeSeries(key, range, meta) : null;
    })
    .filter((text): text is string => text !== null);

  if (described.length === 0) {
    parts.push("No metrics are currently shown.");
  } else {
    parts.push(...described);
  }

  if (omittedMetrics?.length) {
    const names = omittedMetrics.map((key) => METRIC_LABELS[key] ?? key);
    parts.push(
      `${names.join(" and ")} ${names.length === 1 ? "was" : "were"} recorded but ${names.length === 1 ? "is" : "are"} not shown at this screen size.`,
    );
  }

  if (lapCount) {
    parts.push(`${lapCount} lap${lapCount === 1 ? "" : "s"} shaded as bands.`);
  }
  if (smoothed) {
    parts.push("Values are smoothed.");
  }

  return parts.join(" ");
}
