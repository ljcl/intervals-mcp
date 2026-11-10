import { chartedSeries, formatValue, seriesStats } from "./normalize";
import { type WellnessTrendData } from "./types";

/**
 * One-line summary of what the chart is showing, synced to the host so the
 * model can talk about the visible state without re-calling the data tool.
 */
export function buildWellnessContextSummary(
  data: WellnessTrendData,
): string | null {
  const series = chartedSeries(data);
  if (series.length === 0) return null;

  const parts = [
    `Wellness trend chart ${data.oldest} to ${data.newest} (${data.granularity === "weekly" ? "weekly averages" : "daily"}).`,
  ];
  for (const spec of series) {
    const stats = seriesStats(data, spec.key)!;
    parts.push(
      `${spec.label}: latest ${formatValue(spec, stats.last[spec.key] as number)} on ${stats.last.date}, range ${stats.min} to ${stats.max}.`,
    );
  }
  return parts.join(" ");
}
