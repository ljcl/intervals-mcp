import { formatDurationShort, formatShortDate } from "@intervals-mcp/data";
import { type SummaryStat } from "@intervals-mcp/ui";
import { type TrainingLoadData, type WeekSummary } from "./types";

/**
 * Weekly totals arrive as fractional hours; the shared formatter takes
 * seconds. "27h 45m", "3h", "45m".
 */
export function formatHours(timeHours: number): string {
  return formatDurationShort(timeHours * 3600);
}

/** SummaryBar totals row: runs, distance, time, elevation. */
export function buildTotalsStats(
  totals: TrainingLoadData["totals"],
): SummaryStat[] {
  return [
    { label: "Runs", value: `${totals.runs}` },
    { label: "Distance", value: `${totals.distanceKm.toLocaleString()} km` },
    { label: "Time", value: formatHours(totals.timeHours) },
    {
      label: "Elevation",
      value: `${Math.round(totals.elevationM).toLocaleString()} m`,
    },
  ];
}

/** Count of weeks carrying at least one injury-risk warning. */
export function countWarningWeeks(weeks: WeekSummary[]): number {
  return weeks.filter((w) => w.warning).length;
}

/**
 * "12 weeks · 4 May – 20 Jul" — the header subtitle. Spans the weeks
 * actually charted rather than the requested `days` window, since gap weeks
 * are zero-filled but a short history still starts where it starts.
 */
export function buildLoadSubtitle(data: TrainingLoadData): string {
  const first = data.weeks[0];
  const last = data.weeks[data.weeks.length - 1];
  if (!first || !last) return `Last ${data.days} days`;

  const weekLabel = `${data.weeks.length} ${data.weeks.length === 1 ? "week" : "weeks"}`;
  const span =
    first.weekStarting === last.weekStarting
      ? formatShortDate(first.weekStarting)
      : `${formatShortDate(first.weekStarting)} – ${formatShortDate(last.weekStarting)}`;
  return `${weekLabel} · ${span}`;
}
