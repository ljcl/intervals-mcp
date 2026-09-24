import {
  formatClock,
  formatPaceOrSpeed,
  formatShortDate,
  isRunning,
} from "@intervals-mcp/data";
import { type SummaryStat } from "@intervals-mcp/ui";
import {
  type ProgressSummary,
  type SegmentEffort,
  type SegmentProgressData,
} from "./types";

/** Efforts ranked this well get a highlight dot on the chart. */
export const TOP_RANK = 3;

/** Signed second delta as "-6s" / "+12s" / "same". */
export function formatSecondsDelta(delta: number): string {
  if (delta === 0) return "same";
  return `${delta > 0 ? "+" : ""}${Math.round(delta)}s`;
}

/**
 * Effort pace for run segments ("4'10 /km"), speed for everything else
 * ("28.4 km/h"). Shares `formatPaceOrSpeed` with activity-segments so the two
 * segment surfaces read alike — including the paused floor this copy had
 * drifted away from. Returns "—" when the effort recorded no usable
 * distance, or moved too slowly to call it a pace.
 */
export function formatEffortSpeed(
  paceSecondsPerKm: number | null,
  activityType: string | null,
): string {
  if (paceSecondsPerKm == null || paceSecondsPerKm <= 0) return "—";
  const running = activityType ? isRunning(activityType) : true;
  return formatPaceOrSpeed(1000 / paceSecondsPerKm, running);
}

/**
 * Cadence unit by sport: the server doubles run cadence to steps-per-minute
 * and leaves everything else as revolutions.
 */
export function cadenceUnit(activityType: string | null): string {
  return !activityType || isRunning(activityType) ? "spm" : "rpm";
}

/** Gold for the personal best, purple for the rest of the top three. */
export type EffortHighlight = "best" | "top" | null;

/** One point on the progress chart. */
export interface ChartRow {
  id: string;
  /** X-axis category label. */
  label: string;
  date: string;
  elapsedSeconds: number;
  averageHeartrate: number | null;
  paceSecondsPerKm: number | null;
  averageWatts: number | null;
  averageCadence: number | null;
  rank: number;
  prRank: number | null;
  komRank: number | null;
  /** Which achievement dot this point gets, if any. */
  highlight: EffortHighlight;
}

/**
 * The fastest effort, then the rest of the top three, then nothing. A top
 * three only means something once there are more than three efforts —
 * below that every dot would be highlighted, which says nothing at all.
 */
export function highlightForRank(
  rank: number,
  effortCount: number,
): EffortHighlight {
  if (rank === 1) return "best";
  return effortCount > TOP_RANK && rank <= TOP_RANK ? "top" : null;
}

/** True when the history crosses a calendar year, so labels need one. */
export function spansMultipleYears(efforts: SegmentEffort[]): boolean {
  if (efforts.length === 0) return false;
  const years = new Set(efforts.map((e) => new Date(e.date).getUTCFullYear()));
  return years.size > 1;
}

/**
 * Chart rows in chronological order, each carrying the highlight tier its
 * dot should be painted in — so the view's dot renderer reads one field
 * rather than re-deriving ranks per render.
 */
export function buildChartRows(efforts: SegmentEffort[]): ChartRow[] {
  const withYear = spansMultipleYears(efforts);
  return efforts.map((effort) => ({
    id: effort.id,
    label: formatShortDate(effort.date, withYear ? "short" : "none"),
    date: effort.date,
    elapsedSeconds: effort.elapsedSeconds,
    averageHeartrate: effort.averageHeartrate,
    paceSecondsPerKm: effort.paceSecondsPerKm,
    averageWatts: effort.deviceWatts ? effort.averageWatts : null,
    averageCadence: effort.averageCadence,
    rank: effort.rank,
    prRank: effort.prRank,
    komRank: effort.komRank,
    highlight: highlightForRank(effort.rank, efforts.length),
  }));
}

/** Most recent first — the order the effort list reads best in. */
export function newestFirst(efforts: SegmentEffort[]): SegmentEffort[] {
  return [...efforts].reverse();
}

/** Any effort carrying an average heart rate? Gates the HR series. */
export function hasHeartrate(efforts: SegmentEffort[]): boolean {
  return efforts.some((e) => e.averageHeartrate != null);
}

/**
 * SummaryBar stats. Time and heart-rate trends compare the recent half of
 * the history with the early half — that pairing is what makes "same time,
 * lower heart rate" legible; below four efforts there are no halves, so the
 * gap to the personal best stands in.
 */
export function buildSummaryStats(summary: ProgressSummary): SummaryStat[] {
  const stats: SummaryStat[] = [
    { label: "Efforts", value: `${summary.effortCount}` },
  ];
  if (summary.bestSeconds != null) {
    stats.push({ label: "Best", value: formatClock(summary.bestSeconds) });
  }
  if (summary.latestSeconds != null) {
    stats.push({ label: "Latest", value: formatClock(summary.latestSeconds) });
  }

  if (summary.avgSecondsDelta != null) {
    stats.push({
      label: "Time trend",
      value: formatSecondsDelta(summary.avgSecondsDelta),
      direction: trendDirection(summary.avgSecondsDelta),
    });
  } else if (summary.latestVsBestSeconds != null) {
    stats.push({
      label: "vs best",
      value: formatSecondsDelta(summary.latestVsBestSeconds),
      direction: summary.latestVsBestSeconds === 0 ? "up" : "flat",
    });
  }

  if (summary.avgHeartrateDelta != null) {
    stats.push({
      label: "HR trend",
      value:
        summary.avgHeartrateDelta === 0
          ? "same"
          : `${summary.avgHeartrateDelta > 0 ? "+" : ""}${summary.avgHeartrateDelta} bpm`,
      direction: trendDirection(summary.avgHeartrateDelta),
    });
  }

  return stats;
}

/** Lower is better for both time and heart rate, so a drop reads as "up". */
function trendDirection(delta: number): SummaryStat["direction"] {
  if (delta < 0) return "up";
  if (delta > 0) return "down";
  return "flat";
}

/** "800 m · 5.4% avg · Cat 3 · Sydney" — the header subtitle. */
export function buildSegmentSubtitle(
  segment: SegmentProgressData["segment"],
): string {
  const parts = [`${Math.round(segment.distanceMeters)} m`];
  if (segment.averageGrade != null) {
    parts.push(`${segment.averageGrade.toFixed(1)}% avg`);
  }
  if (segment.climbCategory != null && segment.climbCategory > 0) {
    parts.push(`Cat ${segment.climbCategory}`);
  }
  const place = segment.city ?? segment.state ?? segment.country;
  if (place) parts.push(place);
  return parts.join(" · ");
}
