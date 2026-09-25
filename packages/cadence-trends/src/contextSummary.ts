import { type RunSummary, type ViewId } from "./types";

const VIEW_LABELS: Record<ViewId, string> = {
  trend: "trend timeline",
  scatter: "cadence vs pace scatter",
  zones: "pace zones",
  overlay: "per-run overlay",
};

export interface CadenceContextInput {
  weeks: number;
  activeView: ViewId;
  selectedRuns: RunSummary[];
  /** Run-type activities in the window with no recorded cadence, left out
   * of the chart entirely; mentioned so the model knows the average isn't
   * silently missing them. */
  excludedNoCadence?: number;
}

export function buildCadenceContextSummary(
  input: CadenceContextInput,
): string | null {
  const { weeks, activeView, selectedRuns, excludedNoCadence } = input;
  if (!weeks) return null;

  const parts = [
    `Cadence trends, last ${weeks} week${weeks === 1 ? "" : "s"}.`,
    `View: ${VIEW_LABELS[activeView] ?? activeView}.`,
  ];
  if (selectedRuns.length) {
    const runs = selectedRuns
      .map((r) => `${r.name} (${Math.round(r.averageCadence)} spm)`)
      .join(", ");
    parts.push(`Comparing: ${runs}.`);
  } else {
    parts.push("No runs selected for comparison.");
  }
  if (excludedNoCadence) {
    parts.push(
      `${excludedNoCadence} run${excludedNoCadence === 1 ? "" : "s"} with no recorded cadence excluded.`,
    );
  }
  return parts.join(" ");
}
