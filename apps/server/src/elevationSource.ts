/**
 * Which elevation stream an analysis reads: the one home of that choice.
 * intervals.icu keeps the recorded altitude (`altitude`, barometric on most
 * watches) and, when the activity has "Use elevation correction" on, a
 * corrected one from map data (`fixed_altitude`). Its own
 * `total_elevation_gain` and `grade_smooth` follow the corrected stream
 * (docs/api-notes.md), so hill, split and aerobic analysis read it too,
 * unless the caller asks for the recorded one.
 */
import { hasRealSample } from "./hillAnalysis";
import { type IntervalsActivity } from "./intervalsClient";
import { type IntervalsStreams } from "./intervalsStreams";

/** `corrected` is `fixed_altitude`; `barometric` is the recorded `altitude`. */
export type ElevationSource = "corrected" | "barometric";

export interface ResolvedElevation {
  /** The stream to analyse; undefined when the activity has no altitude. */
  altitude: (number | null)[] | undefined;
  /** Null when `altitude` is undefined or has no recorded sample. */
  source: ElevationSource | null;
  /** Why a request for corrected elevation got the recorded one; else null. */
  note: string | null;
}

/**
 * Picks the elevation stream. Corrected elevation needs all three: the
 * caller wants it, the activity has correction on, and `fixed_altitude` has
 * a recorded sample. Otherwise the recorded `altitude` is used, with a note
 * when the caller wanted corrected elevation and did not get it.
 */
export function resolveElevation(
  activity: Pick<IntervalsActivity, "use_elevation_correction">,
  streams: Pick<IntervalsStreams, "altitude" | "fixed_altitude">,
  useCorrected = true,
): ResolvedElevation {
  const correctionOn = activity.use_elevation_correction === true;
  const hasCorrected = hasRealSample(streams.fixed_altitude);
  if (useCorrected && correctionOn && hasCorrected) {
    return {
      altitude: streams.fixed_altitude,
      source: "corrected",
      note: null,
    };
  }
  const hasRecorded = hasRealSample(streams.altitude);
  let note: string | null = null;
  if (useCorrected && hasRecorded) {
    note = !correctionOn
      ? "Elevation correction is off for this activity in intervals.icu, so this uses the recorded altitude stream."
      : "Elevation correction is on, but the activity has no corrected altitude stream, so this uses the recorded altitude stream.";
  }
  return {
    altitude: streams.altitude,
    source: hasRecorded ? "barometric" : null,
    note,
  };
}

/**
 * The activity's own total ascent, or null when it does not describe the
 * stream the caller asked for: with correction on, intervals.icu's total
 * follows the corrected stream, so a caller that asked for the recorded
 * altitude gets a total summed from that stream.
 */
export function recordedGainFor(
  activity: Pick<
    IntervalsActivity,
    "use_elevation_correction" | "total_elevation_gain"
  >,
  useCorrected: boolean,
): number | null {
  if (!useCorrected && activity.use_elevation_correction === true) return null;
  return activity.total_elevation_gain ?? null;
}

/** The text tools' line for the elevation stream in use; none without one. */
export function elevationLines(
  elevation: Pick<ResolvedElevation, "source" | "note">,
): string[] {
  if (elevation.source == null) return [];
  const label =
    elevation.source === "corrected"
      ? "corrected (intervals.icu elevation correction)"
      : "barometric (recorded altitude)";
  return [
    `Elevation source: ${label}${elevation.note ? `. ${elevation.note}` : ""}`,
  ];
}
