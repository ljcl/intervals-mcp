import { formatShortDate } from "@intervals-mcp/data";
import { type WeekSummary } from "./types";

/**
 * Narration spells the year out: "14 Sep 2025". Week keys are date-only ISO
 * strings, which parse as UTC midnight; `formatShortDate` reads them in UTC
 * so the narrated day never shifts by the viewer's (or CI's) timezone.
 */
const fullDate = (iso: string) => formatShortDate(iso, "full");

/**
 * Screen-reader narration for the training-load chart. Recharts'
 * accessibilityLayer provides keyboard focus and arrow-key tooltip stepping,
 * but the SVG carries no accessible name or content summary of its own; this
 * builder feeds the chart's `title`/`desc` props (rendered as SVG
 * <title>/<desc>), mirroring cadence-trends' a11y.ts.
 */
export interface ChartA11y {
  title: string;
  desc: string;
}

/**
 * What the chart is currently drawing, so the narration matches what a
 * sighted user actually sees rather than everything fetched.
 */
export interface LoadVisibility {
  showTrend: boolean;
  showWarnings: boolean;
}

const ALL_VISIBLE: LoadVisibility = { showTrend: true, showWarnings: true };

/**
 * Weekly volume bars with a rolling trend line and warning highlights.
 * The trend and warning clauses drop out when those layers are toggled off.
 */
export function buildLoadA11y(
  weeks: WeekSummary[],
  visibility: LoadVisibility = ALL_VISIBLE,
): ChartA11y {
  const title = "Weekly training volume";
  if (weeks.length === 0) return { title, desc: "No runs to display." };

  const first = weeks[0]!;
  const last = weeks[weeks.length - 1]!;
  let min = Infinity;
  let max = -Infinity;
  for (const week of weeks) {
    if (week.distanceKm < min) min = week.distanceKm;
    if (week.distanceKm > max) max = week.distanceKm;
  }

  const parts = [
    `${weeks.length} week${weeks.length === 1 ? "" : "s"} of running volume from ${fullDate(first.weekStarting)} to ${fullDate(last.weekStarting)}.`,
    `Weekly distance ranges from ${min} to ${max} km${visibility.showTrend ? "; a line shows the 3-week rolling average" : ""}.`,
  ];

  if (visibility.showWarnings) {
    const flagged = weeks.filter((week) => week.warning);
    if (flagged.length > 0) {
      const names = flagged
        .map((week) => `week of ${fullDate(week.weekStarting)}`)
        .join(", ");
      parts.push(
        `${flagged.length} week${flagged.length === 1 ? " is" : "s are"} highlighted for injury risk: ${names}.`,
      );
    } else {
      parts.push("No weeks are flagged for injury risk.");
    }
  }

  return { title, desc: parts.join(" ") };
}
