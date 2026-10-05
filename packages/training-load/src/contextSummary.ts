import {
  countWarningWeeks,
  describeLoadScope,
  formatCurrentFitness,
} from "./normalize";
import { type TrainingLoadData } from "./types";

/**
 * One-line summary of what the chart is showing, synced to the host so the
 * model can talk about the visible state without re-calling the data tool.
 */
export function buildTrainingLoadContextSummary(
  data: TrainingLoadData,
): string | null {
  if (!data.days) return null;

  const parts = [
    data.startDate && data.endDate
      ? `Training load from ${data.startDate} to ${data.endDate}.`
      : `Training load, last ${data.days} day${data.days === 1 ? "" : "s"}.`,
    `${data.totals.runs} run${data.totals.runs === 1 ? "" : "s"}, ${data.totals.distanceKm} km over ${data.weeks.length} week${data.weeks.length === 1 ? "" : "s"}.`,
    data.runOnly
      ? `Total training load ${data.totals.load}, ${describeLoadScope(data)}.`
      : // Load covers every sport; volume and warnings never do, so say so.
        `Total training load ${data.totals.load}, ${describeLoadScope(data)}; runs, distance and volume-spike warnings count runs only.`,
  ];

  if (data.current) {
    parts.push(
      `As of ${data.current.date}: ${formatCurrentFitness(data.current, data.source)}.`,
    );
  }

  const inProgress = data.weeks.find((w) => w.inProgress);
  if (inProgress) {
    parts.push(
      `The week of ${inProgress.weekStarting} is still in progress, so its volume is only the days so far.`,
    );
  }

  const warningWeeks = countWarningWeeks(data.weeks);
  if (warningWeeks > 0) {
    const flagged = data.weeks
      .filter((w) => w.warning)
      .map((w) => `week of ${w.weekStarting}`)
      .join(", ");
    parts.push(`Volume-spike warnings on ${flagged}.`);
  } else {
    parts.push("No volume-spike warnings.");
  }

  return parts.join(" ");
}
