import { formatClock, formatShortDate } from "@intervals-mcp/data";
import { formatSecondsDelta } from "./normalize";
import { type SegmentProgressData } from "./types";

/**
 * One-line summary of what the view is showing, synced to the host so the
 * model can talk about the visible state — including which effort is
 * selected — without re-calling the data tool.
 */
export function buildSegmentProgressContextSummary(
  data: SegmentProgressData,
  selectedEffortId?: string | null,
): string | null {
  const { segment, summary } = data;
  if (!segment.name) return null;

  if (summary.effortCount === 0) {
    return `Segment progress for ${segment.name}: no efforts in the selected range.`;
  }

  const parts = [
    `Segment progress for ${segment.name}: ${summary.effortCount} effort${summary.effortCount === 1 ? "" : "s"} from ${formatShortDate(summary.firstDate!, "short")} to ${formatShortDate(summary.lastDate!, "short")}.`,
    `Best ${formatClock(summary.bestSeconds!)} on ${formatShortDate(summary.bestDate!, "short")}, latest ${formatClock(summary.latestSeconds!)} (${formatSecondsDelta(summary.latestVsBestSeconds!)} vs best).`,
  ];

  if (summary.avgSecondsDelta != null) {
    const hr =
      summary.avgHeartrateDelta == null
        ? ""
        : `, ${summary.avgHeartrateDelta === 0 ? "same" : `${summary.avgHeartrateDelta > 0 ? "+" : ""}${summary.avgHeartrateDelta} bpm`} average heart rate`;
    parts.push(
      `Recent half vs early half: ${formatSecondsDelta(summary.avgSecondsDelta)} average time${hr}.`,
    );
  }

  const selected = selectedEffortId
    ? data.efforts.find((e) => e.id === selectedEffortId)
    : undefined;
  if (selected) {
    const activity = selected.activityId
      ? ` from activity ${selected.activityId}`
      : "";
    parts.push(
      `Effort open in the list: ${formatShortDate(selected.date, "short")}, ${formatClock(selected.elapsedSeconds)}${activity}.`,
    );
  }

  return parts.join(" ");
}
