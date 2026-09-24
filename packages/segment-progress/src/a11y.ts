import { formatClock, formatShortDate } from "@intervals-mcp/data";
import { formatSecondsDelta } from "./normalize";
import { type ProgressSummary, type SegmentSummary } from "./types";

/**
 * Screen-reader narration for the segment-progress chart. Recharts'
 * accessibilityLayer gives keyboard focus and arrow-key tooltip stepping, but
 * the SVG carries no accessible name or content summary; this builder feeds
 * the chart's `title`/`desc` props (rendered as SVG <title>/<desc>), per the
 * chart accessibility convention.
 */
export interface ChartA11y {
  title: string;
  desc: string;
}

/** Effort-time series over date, with the heart-rate overlay when shown. */
export function buildProgressA11y(
  segment: SegmentSummary,
  summary: ProgressSummary,
  showHeartrate: boolean,
): ChartA11y {
  const title = `Effort history on ${segment.name}`;
  if (summary.effortCount === 0 || summary.firstDate == null) {
    return { title, desc: "No efforts to display." };
  }

  const parts = [
    `${summary.effortCount} effort${summary.effortCount === 1 ? "" : "s"} on ${segment.name} from ${formatShortDate(summary.firstDate, "short")} to ${formatShortDate(summary.lastDate!, "short")}, plotted as elapsed time with faster efforts higher.`,
    `Personal best ${formatClock(summary.bestSeconds!)} on ${formatShortDate(summary.bestDate!, "short")}; most recent ${formatClock(summary.latestSeconds!)} on ${formatShortDate(summary.latestDate!, "short")}, ${formatSecondsDelta(summary.latestVsBestSeconds!)} against the best.`,
  ];

  if (summary.avgSecondsDelta != null) {
    const timeShift =
      summary.avgSecondsDelta === 0
        ? "the same average time"
        : `${formatSecondsDelta(summary.avgSecondsDelta)} average time`;
    parts.push(
      `The recent half of the history is ${timeShift} compared with the early half.`,
    );
  }

  if (showHeartrate && summary.heartrateEffortCount > 0) {
    const hrParts = [
      `A second line shows average heart rate on ${summary.heartrateEffortCount} of the efforts.`,
    ];
    if (summary.avgHeartrateDelta != null) {
      hrParts.push(
        summary.avgHeartrateDelta === 0
          ? "Average heart rate is unchanged between the two halves."
          : `Average heart rate is ${Math.abs(summary.avgHeartrateDelta)} bpm ${summary.avgHeartrateDelta < 0 ? "lower" : "higher"} in the recent half.`,
      );
    }
    parts.push(hrParts.join(" "));
  }

  return { title, desc: parts.join(" ") };
}
