import { overlayRunLabel, windowLabel } from "./normalize";
import {
  type OverlayRunStatus,
  type OverlayXMode,
  type RunSummary,
  type ViewId,
} from "./types";

export const VIEW_LABELS: Record<ViewId, string> = {
  trend: "trend timeline",
  scatter: "cadence vs pace scatter",
  zones: "pace zones",
  overlay: "per-run overlay",
};

/** How the summary heads the selected runs the overlay does not draw. */
const NOT_DRAWN_HEADINGS: ReadonlyArray<
  [Exclude<OverlayRunStatus, "drawn">, string]
> = [
  ["loading", "Still loading"],
  ["noStreams", "No recorded streams"],
  ["failed", "Failed to load"],
  ["hidden", "Hidden in the legend"],
];

export interface CadenceContextInput {
  /** The window the chart covers, in days. */
  days: number;
  activeView: ViewId;
  selectedRuns: RunSummary[];
  /** The overlay's x-axis; reported only while the overlay is showing. */
  overlayAxis?: OverlayXMode;
  /** Each selected run's place in the overlay, read only while the overlay
   * shows; a run missing from it counts as loading, as the overlay does. */
  overlayStatus?: ReadonlyMap<string, OverlayRunStatus>;
  /** Run-type activities in the window with no recorded cadence, left out
   * of the chart entirely; mentioned so the model knows the average isn't
   * silently missing them. */
  excludedNoCadence?: number;
  /** Runs with cadence but no recorded speed, excluded from pace-based
   * views (pace zones, scatter) only. */
  noPaceCount?: number;
}

export function buildCadenceContextSummary(
  input: CadenceContextInput,
): string | null {
  const {
    days,
    activeView,
    selectedRuns,
    overlayAxis,
    overlayStatus,
    excludedNoCadence,
    noPaceCount,
  } = input;
  if (!days) return null;

  const parts = [
    `Cadence trends, last ${windowLabel(days)}.`,
    `View: ${VIEW_LABELS[activeView] ?? activeView}.`,
  ];
  if (activeView === "overlay" && overlayAxis) {
    parts.push(`Overlay x-axis: ${overlayAxis}.`);
  }
  const withCadence = (runs: RunSummary[]) =>
    runs
      .map(
        (r) =>
          `${overlayRunLabel(r, selectedRuns)} (${Math.round(r.averageCadence)} spm)`,
      )
      .join(", ");
  if (selectedRuns.length && activeView === "overlay") {
    // Only a drawn run is compared on screen; the rest are named by why not.
    const statusOf = (r: RunSummary) => overlayStatus?.get(r.id) ?? "loading";
    const drawn = selectedRuns.filter((r) => statusOf(r) === "drawn");
    parts.push(
      drawn.length > 0
        ? `Comparing: ${withCadence(drawn)}.`
        : "No run is drawn in the overlay.",
    );
    for (const [status, heading] of NOT_DRAWN_HEADINGS) {
      const these = selectedRuns.filter((r) => statusOf(r) === status);
      if (these.length > 0) {
        parts.push(
          `${heading}: ${these.map((r) => overlayRunLabel(r, selectedRuns)).join(", ")}.`,
        );
      }
    }
  } else if (selectedRuns.length) {
    parts.push(`Comparing: ${withCadence(selectedRuns)}.`);
  } else {
    parts.push("No runs selected for comparison.");
  }
  if (excludedNoCadence) {
    parts.push(
      `${excludedNoCadence} run${excludedNoCadence === 1 ? "" : "s"} with no recorded cadence excluded.`,
    );
  }
  if (noPaceCount) {
    parts.push(
      `${noPaceCount} run${noPaceCount === 1 ? "" : "s"} with no recorded pace excluded from pace-based views.`,
    );
  }
  return parts.join(" ");
}
