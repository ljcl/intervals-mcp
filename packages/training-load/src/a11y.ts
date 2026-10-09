import { formatShortDate } from "@intervals-mcp/data";
import {
  describeLoadScope,
  formatCurrentFitness,
  isPastWindow,
} from "./normalize";
import { type TrainingLoadData } from "./types";

/**
 * Narration spells the year out: "14 Sep 2025". Week keys are date-only ISO
 * strings and `formatShortDate` reads the day as written, so the narrated
 * day never shifts by the viewer's (or CI's) timezone.
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
  showLoad: boolean;
}

const ALL_VISIBLE: LoadVisibility = {
  showTrend: true,
  showWarnings: true,
  showLoad: true,
};

/**
 * Weekly volume bars with a rolling trend line, a weekly load line on its
 * own axis, and warning highlights. The trend, load line and warning clauses
 * drop out when those layers are toggled off; the total load and current
 * fitness stay, since the summary tiles above the chart keep showing them.
 */
export function buildLoadA11y(
  data: TrainingLoadData,
  visibility: LoadVisibility = ALL_VISIBLE,
): ChartA11y {
  const { weeks } = data;
  const title = "Weekly training volume and load";
  if (weeks.length === 0) return { title, desc: "No runs to display." };

  const first = weeks[0]!;
  const last = weeks[weeks.length - 1]!;
  let min = Infinity;
  let max = -Infinity;
  for (const week of weeks) {
    if (week.distanceKm < min) min = week.distanceKm;
    if (week.distanceKm > max) max = week.distanceKm;
  }
  // The solid load line stops at the last complete week: a few days of load
  // is not a low for the range to quote.
  const completeWeeks = weeks.filter((w) => !w.inProgress);
  const loads = (completeWeeks.length > 0 ? completeWeeks : weeks).map(
    (w) => w.load,
  );
  const minLoad = Math.min(...loads);
  const maxLoad = Math.max(...loads);

  const parts = [
    `${weeks.length} week${weeks.length === 1 ? "" : "s"} of running volume from ${fullDate(first.weekStarting)} to ${fullDate(last.weekStarting)}.`,
    `Weekly distance ranges from ${min} to ${max} km${visibility.showTrend ? "; a line shows the 3-week rolling average" : ""}.`,
  ];
  // A past window's last week is cut off at its end date, not in progress.
  const cutOff = isPastWindow(data) ? data.endDate : undefined;
  if (last.inProgress) {
    parts.push(
      cutOff
        ? `The week of ${fullDate(last.weekStarting)} is partial: the window ends on ${fullDate(cutOff)}, so its distance and load count only the days up to then.`
        : `The week of ${fullDate(last.weekStarting)} is still in progress, so its distance and load are only the days so far.`,
    );
  }

  if (visibility.showLoad) {
    const hollowPoint = cutOff
      ? "; a hollow point marks the partial week"
      : "; a hollow point marks the week in progress";
    parts.push(
      `A second line shows weekly training load on the right axis, from ${minLoad} to ${maxLoad}${completeWeeks.length > 0 && last.inProgress ? " across complete weeks" : ""}${last.inProgress ? hollowPoint : ""}.`,
    );
  }
  parts.push(
    `Total training load ${data.totals.load}, ${describeLoadScope(data)}.`,
  );
  if (data.current) {
    parts.push(
      `As of ${fullDate(data.current.date)}: ${formatCurrentFitness(data.current, data.source)}.`,
    );
  }

  if (visibility.showWarnings) {
    const flagged = weeks.filter((week) => week.warning);
    if (flagged.length > 0) {
      const names = flagged
        .map((week) => `week of ${fullDate(week.weekStarting)}`)
        .join(", ");
      parts.push(
        `${flagged.length} week${flagged.length === 1 ? " is" : "s are"} highlighted as a volume spike: ${names}.`,
      );
    } else {
      parts.push("No weeks are flagged as a volume spike.");
    }
  }

  return { title, desc: parts.join(" ") };
}
