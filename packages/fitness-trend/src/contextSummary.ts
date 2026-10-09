import { formatSignedTsb } from "@intervals-mcp/data";
import {
  isPastWindow,
  isPlanned,
  isPositiveToday,
  planDays,
} from "./normalize";
import { type FitnessTrendData } from "./types";

/**
 * One-line summary of what the chart is showing, synced to the host so the
 * model can talk about the visible state without re-calling the data tool.
 * `hiddenSeries` names the series turned off, by the values `set-scope`
 * accepts, so the model can say what the athlete is not looking at and
 * switch it back.
 */
export function buildFitnessTrendContextSummary(
  data: FitnessTrendData,
  hiddenSeries: readonly string[] = [],
): string | null {
  const current = data.current;
  if (!current) return null;

  const dayCount = `${data.days} day${data.days === 1 ? "" : "s"}`;
  // A past window (#80) names its last day; its note arrives in `warnings`.
  const pastEnd = isPastWindow(data) ? data.endDate : undefined;
  const parts = [
    pastEnd
      ? `Fitness trend, ${dayCount} to ${pastEnd}.`
      : `Fitness trend, last ${dayCount}.`,
    `On ${current.date}: fitness (CTL) ${current.ctl}, fatigue (ATL) ${current.atl}, form (TSB) ${formatSignedTsb(current.tsb)}.`,
  ];

  const plan = planDays(data);
  const landing = plan[plan.length - 1];
  if (data.taper && landing) {
    const taper = data.taper;
    parts.push(
      `Taper plan of ${taper.weeks.length} week${taper.weeks.length === 1 ? "" : "s"} to ${taper.targetDate}, targeting form ${formatSignedTsb(taper.targetTsb)} and landing on ${formatSignedTsb(taper.achievedTsb)}.`,
    );
    if (!taper.feasible && taper.note) parts.push(taper.note);
  } else if (landing && !isPlanned(data)) {
    parts.push(
      isPositiveToday(data)
        ? `Rest projection to ${landing.date}; form is already positive today (${data.tsbPositiveDate}).`
        : data.tsbPositiveDate
          ? `Rest projection to ${landing.date}; form turns positive on ${data.tsbPositiveDate}.`
          : `Rest projection to ${landing.date}, reaching form ${formatSignedTsb(landing.tsb)}.`,
    );
  }

  parts.push(
    data.flags.length > 0
      ? `Flags: ${data.flags.join(" ")}`
      : "No fatigue or ramp flags.",
  );

  if (data.activitiesMissingLoad > 0) {
    parts.push(
      `${data.activitiesMissingLoad} of ${data.activitiesIncluded} activities in the window have no training load recorded.`,
    );
  }

  if (data.source) {
    parts.push(
      data.runOnly
        ? "Scope: runs only, computed locally."
        : "Scope: whole body, from intervals.icu.",
    );
  }

  if (hiddenSeries.length > 0) {
    parts.push(`Hidden series: ${hiddenSeries.join(", ")}.`);
  }

  if (data.warnings && data.warnings.length > 0) {
    parts.push(`Notes: ${data.warnings.join(" ")}`);
  }

  return parts.join(" ");
}
