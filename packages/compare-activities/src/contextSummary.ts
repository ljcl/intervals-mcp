import { type AxisKey, type CompareData, type MetricKey } from "./types";

const METRIC_LABELS: Record<MetricKey, string> = {
  pace: "pace",
  heartrate: "heart rate",
  power: "power",
  cadence: "cadence",
  altitude: "altitude",
};

export interface CompareContextInput {
  compare: CompareData | null;
  metric: MetricKey | null;
  axis: AxisKey;
  /** Overrides the generic pace label for mixed pairs ("speed"). */
  paceLabel?: string;
}

/**
 * One-line view-state summary reported back to the host's model context so
 * the model knows what comparison the user is looking at.
 */
export function buildCompareContextSummary(
  input: CompareContextInput,
): string | null {
  const { compare, metric, axis } = input;
  if (!compare || !metric) return null;

  const labels = { ...METRIC_LABELS };
  if (input.paceLabel) labels.pace = input.paceLabel;

  const parts = [
    `Comparing "${compare.activity_1.name}" (${compare.activity_1.date}) with "${compare.activity_2.name}" (${compare.activity_2.date}).`,
    `Overlay: ${labels[metric]} vs ${axis}.`,
  ];

  const deltas: string[] = [];
  const { differences } = compare;
  if (differences.pace_delta_sec_per_km != null) {
    const s = differences.pace_delta_sec_per_km;
    deltas.push(
      `pace ${s > 0 ? "+" : ""}${s} s/km (${differences.pace_delta_interpretation})`,
    );
  }
  if (differences.avg_hr != null) {
    deltas.push(
      `avg HR ${differences.avg_hr > 0 ? "+" : ""}${differences.avg_hr} bpm`,
    );
  }
  if (deltas.length) parts.push(`Deltas (2 vs 1): ${deltas.join(", ")}.`);

  return parts.join(" ");
}
