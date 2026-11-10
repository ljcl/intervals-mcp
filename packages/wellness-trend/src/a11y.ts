import {
  formatValue,
  isWeekly,
  pointLabel,
  rangeLabel,
  type SeriesSpec,
  seriesStats,
} from "./normalize";
import { type WellnessTrendData } from "./types";

/**
 * SVG <title>/<desc> narration for one panel, per the chart accessibility
 * convention: what the panel plots, how many days carry a value (the rest
 * are gaps), its range, and its first and latest values.
 */
export function buildSeriesA11y(
  data: WellnessTrendData,
  spec: SeriesSpec,
): { title: string; desc: string } {
  const unit = isWeekly(data) ? "week" : "day";
  const title = `${spec.label} by ${unit}, ${rangeLabel(data)}`;
  const stats = seriesStats(data, spec.key);
  if (!stats) return { title, desc: `No ${spec.label} recorded.` };

  const total = data.points.length;
  const gaps =
    stats.count < total
      ? ` ${total - stats.count} with no record show as gaps.`
      : "";
  return {
    title,
    desc:
      `Line chart of ${spec.label} in ${spec.unit}` +
      (isWeekly(data) ? ", weekly averages (Monday start)" : "") +
      `. ${stats.count} of ${total} ${unit}s recorded.${gaps}` +
      ` Range ${formatValue(spec, stats.min)} to ${formatValue(spec, stats.max)}.` +
      ` First ${formatValue(spec, stats.first[spec.key] as number)} (${pointLabel(data, stats.first)}),` +
      ` latest ${formatValue(spec, stats.last[spec.key] as number)} (${pointLabel(data, stats.last)}).`,
  };
}
