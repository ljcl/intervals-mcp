import { isPlanned, planDays, signedTsb } from "./normalize";
import { type FitnessTrendData } from "./types";

/**
 * One-line summary of what the chart is showing, synced to the host so the
 * model can talk about the visible state without re-calling the data tool.
 */
export function buildFitnessTrendContextSummary(
  data: FitnessTrendData,
): string | null {
  const current = data.current;
  if (!current) return null;

  const parts = [
    `Fitness trend, last ${data.days} day${data.days === 1 ? "" : "s"}.`,
    `On ${current.date}: fitness (CTL) ${current.ctl}, fatigue (ATL) ${current.atl}, form (TSB) ${signedTsb(current.tsb)}.`,
  ];

  const plan = planDays(data);
  const landing = plan[plan.length - 1];
  if (data.taper && landing) {
    const taper = data.taper;
    parts.push(
      `Taper plan of ${taper.weeks.length} week${taper.weeks.length === 1 ? "" : "s"} to ${taper.targetDate}, targeting form ${signedTsb(taper.targetTsb)} and landing on ${signedTsb(taper.achievedTsb)}.`,
    );
    if (!taper.feasible && taper.note) parts.push(taper.note);
  } else if (landing && !isPlanned(data)) {
    parts.push(
      data.tsbPositiveDate
        ? `Rest projection to ${landing.date}; form turns positive on ${data.tsbPositiveDate}.`
        : `Rest projection to ${landing.date}, reaching form ${signedTsb(landing.tsb)}.`,
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

  return parts.join(" ");
}
