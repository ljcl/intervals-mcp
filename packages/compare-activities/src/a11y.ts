import { formatPace, formatTime } from "@intervals-mcp/data";
import { alignedKey, type PaceCategory } from "./align";
import { type AlignedPoint, type AxisKey, type MetricKey } from "./types";

/**
 * Screen-reader narration for the comparison chart. Recharts'
 * accessibilityLayer provides keyboard focus and arrow-key tooltip stepping,
 * but the SVG carries no accessible name or content summary of its own.
 * These strings feed the chart's `title`/`desc` props (rendered as SVG
 * <title>/<desc>), mirroring activity-chart's a11y.ts: which two activities
 * are overlaid, over what extent, and each visible line's value range.
 */
export interface CompareA11yInput {
  nameA: string;
  nameB: string;
  metric: MetricKey;
  axis: AxisKey;
  category: PaceCategory;
  /** Cadence unit switch: spm when both activities are runs, rpm otherwise. */
  bothRunning: boolean;
  data: AlignedPoint[];
  hidden: { a: boolean; b: boolean };
}

function sideRange(
  data: AlignedPoint[],
  side: "a" | "b",
  metric: MetricKey,
): { min: number; max: number } | null {
  const key = alignedKey(side, metric);
  let min = Infinity;
  let max = -Infinity;
  for (const point of data) {
    const value = point[key];
    if (value === undefined) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min === Infinity ? null : { min, max };
}

function formatRange(
  range: { min: number; max: number },
  metric: MetricKey,
  category: PaceCategory,
  bothRunning: boolean,
): string {
  switch (metric) {
    case "pace":
      if (category === "speed") {
        return `${range.min.toFixed(1)} to ${range.max.toFixed(1)} km/h`;
      }
      return `${formatPace(range.min)} to ${formatPace(range.max)} ${
        category === "swim" ? "per 100 m" : "min/km"
      }`;
    case "heartrate":
      return `${Math.round(range.min)} to ${Math.round(range.max)} bpm`;
    case "power":
      return `${Math.round(range.min)} to ${Math.round(range.max)} W`;
    case "cadence":
      return `${Math.round(range.min)} to ${Math.round(range.max)} ${bothRunning ? "spm" : "rpm"}`;
    case "altitude":
      return `${Math.round(range.min)} to ${Math.round(range.max)} m`;
  }
}

const METRIC_NAMES: Record<MetricKey, string> = {
  pace: "pace",
  heartrate: "heart rate",
  power: "power",
  cadence: "cadence",
  altitude: "altitude",
};

export function buildCompareA11yTitle(nameA: string, nameB: string): string {
  return `Comparison chart of "${nameA}" and "${nameB}"`;
}

export function buildCompareA11yDescription(input: CompareA11yInput): string {
  const { nameA, nameB, metric, axis, category, bothRunning, data, hidden } =
    input;
  const parts: string[] = [];

  const metricName =
    metric === "pace" && category === "speed" ? "speed" : METRIC_NAMES[metric];

  const lastX = data[data.length - 1]?.x;
  if (lastX !== undefined) {
    const extent =
      axis === "distance"
        ? `${(lastX / 1000).toFixed(1)} km, by distance`
        : `${formatTime(lastX)}, by time`;
    parts.push(`Overlay of ${metricName} over ${extent}.`);
  } else {
    parts.push(`Overlay of ${metricName}.`);
  }

  const sides: Array<{ side: "a" | "b"; name: string; isHidden: boolean }> = [
    { side: "a", name: nameA, isHidden: hidden.a },
    { side: "b", name: nameB, isHidden: hidden.b },
  ];
  for (const { side, name, isHidden } of sides) {
    if (isHidden) {
      parts.push(`"${name}" is hidden.`);
      continue;
    }
    const range = sideRange(data, side, metric);
    if (range) {
      parts.push(
        `"${name}" ranges from ${formatRange(range, metric, category, bothRunning)}.`,
      );
    }
  }

  return parts.join(" ");
}
