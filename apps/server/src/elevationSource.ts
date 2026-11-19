/**
 * Which elevation stream an analysis reads: the one home of that choice.
 * intervals.icu keeps the recorded altitude (`altitude`, barometric on most
 * watches) and, when the activity has "Use elevation correction" on, a
 * corrected one from map data (`fixed_altitude`). Its own
 * `total_elevation_gain` and `grade_smooth` follow the corrected stream
 * (docs/api-notes.md), so hill, split and aerobic analysis read it too,
 * unless the caller asks for the recorded one.
 */
import { formatSigned } from "./formatters";
import { hasRealSample } from "./hillAnalysis";
import { type IntervalsActivity } from "./intervalsClient";
import { type IntervalsStreams } from "./intervalsStreams";
import { ascentFromAltitude } from "./splitAnalysis";

/** `corrected` is `fixed_altitude`; `barometric` is the recorded `altitude`. */
export type ElevationSource = "corrected" | "barometric";

/** The `elevationSource` input of the hill, split and aerobic tools:
 * one source, or `both` side by side. */
export const ELEVATION_SOURCE_CHOICES = [
  "corrected",
  "barometric",
  "both",
] as const;

/**
 * When a `both` call says the two sources disagree too much to trust the
 * result: the one place to tune the sensitivity warning. Each tool compares
 * the number its headline rests on.
 */
export const ELEVATION_SENSITIVITY = {
  /** get-aerobic-analysis: decoupling, percentage points. */
  decouplingPts: 5,
  /** get-split-analysis: the grade-adjusted second-half change, points. */
  gapDeltaPts: 3,
  /** get-hill-analysis: total climb gain, percent of the larger total... */
  climbGainPct: 25,
  /** ...and metres, so a few metres on a flat run do not warn. */
  climbGainMinM: 10,
} as const;

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

/**
 * The source of the activity's own `total_elevation_gain`, for a tool that
 * prints that total and reads no stream: intervals.icu's total follows the
 * corrected stream when the activity has correction on (docs/api-notes.md).
 * Null when the activity has no total.
 */
export function activityGainSource(
  activity: Pick<
    IntervalsActivity,
    "use_elevation_correction" | "total_elevation_gain"
  >,
): ElevationSource | null {
  if (activity.total_elevation_gain == null) return null;
  return activity.use_elevation_correction === true
    ? "corrected"
    : "barometric";
}

/** A source in a sentence: "corrected elevation" or "the recorded altitude". */
export function elevationSourcePhrase(source: ElevationSource): string {
  return source === "corrected"
    ? "corrected elevation"
    : "the recorded (barometric) altitude";
}

/**
 * The sentence for two runs whose elevation comes from different sources: a
 * corrected run against a barometric run is not a like-for-like climb
 * comparison (on one run the two sources gave 331 m and 230 m). Null when
 * they agree or either has none.
 */
export function mixedElevationNote(
  source1: ElevationSource | null,
  source2: ElevationSource | null,
  what: string,
): string | null {
  if (source1 == null || source2 == null || source1 === source2) return null;
  return `Activity 1's ${what} is from ${elevationSourcePhrase(source1)} and activity 2's from ${elevationSourcePhrase(source2)}, so the two are not like for like.`;
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

/** Both elevation streams for a `both` call. A source is null when the
 * activity cannot give it; `note` says why, else it is null. */
export interface BothElevations {
  corrected: ResolvedElevation | null;
  barometric: ResolvedElevation | null;
  note: string | null;
}

/**
 * Resolves each source on its own (`resolveElevation`). Corrected is null
 * when the activity cannot give it (correction off, or no corrected
 * stream); barometric when the recorded altitude has no sample. A call
 * then reports the one source it has, with the note, and no error.
 */
export function resolveBothElevations(
  activity: Pick<IntervalsActivity, "use_elevation_correction">,
  streams: Pick<IntervalsStreams, "altitude" | "fixed_altitude">,
): BothElevations {
  const wanted = resolveElevation(activity, streams, true);
  const recorded = resolveElevation(activity, streams, false);
  const corrected = wanted.source === "corrected" ? wanted : null;
  const barometric = recorded.source === "barometric" ? recorded : null;
  let note: string | null = null;
  if (!corrected) {
    const why =
      activity.use_elevation_correction === true
        ? "the activity has no corrected altitude stream"
        : "elevation correction is off for this activity in intervals.icu";
    note = barometric
      ? `The corrected elevation stream is not available (${why}), so this shows the barometric result only.`
      : `The activity has no altitude stream (${why}, and no recorded altitude), so there is no elevation source to compare.`;
  }
  return { corrected, barometric, note };
}

/**
 * Total ascent of one altitude stream, in whole metres, by the rule the
 * split totals use (`ascentFromAltitude`). Both sources are summed the same
 * way, so a `both` call compares like with like. Null with no sample.
 */
export function streamGainM(
  altitude: (number | null)[] | undefined,
): number | null {
  const samples = (altitude ?? []).filter(
    (a): a is number => a != null && Number.isFinite(a),
  );
  return samples.length > 0 ? Math.round(ascentFromAltitude(samples)) : null;
}

/** The `both` header line, e.g. `Gain: corrected +78 m, barometric +79 m`. */
export function elevationGainLine(
  gains: Record<ElevationSource, number | null>,
): string {
  const part = (source: ElevationSource) => {
    const gain = gains[source];
    return gain == null ? `${source} n/a` : `${source} +${gain} m`;
  };
  return `Gain: ${part("corrected")}, ${part("barometric")} (summed from each altitude stream)`;
}

/** How far apart the two sources are, and the warning when too far. */
export interface ElevationSensitivity {
  difference: number;
  warning: string | null;
}

const distrust = (subject: string) =>
  `Do not trust the ${subject} for this run.`;

/** get-aerobic-analysis: decoupling under each source. */
export function decouplingSensitivity(
  correctedPct: number,
  barometricPct: number,
): ElevationSensitivity {
  const difference =
    Math.round(Math.abs(correctedPct - barometricPct) * 10) / 10;
  const limit = ELEVATION_SENSITIVITY.decouplingPts;
  return {
    difference,
    warning:
      difference > limit
        ? `Decoupling differs by ${difference} points between elevation sources (${formatSigned(correctedPct, 1)}% corrected, ${formatSigned(barometricPct, 1)}% barometric), more than ${limit}. ${distrust("GAP-based result")}`
        : null,
  };
}

/** get-split-analysis: the grade-adjusted half-to-half change under each
 * source. Null when either source has no grade-adjusted verdict. */
export function gapDeltaSensitivity(
  correctedPct: number | null,
  barometricPct: number | null,
): ElevationSensitivity | null {
  if (correctedPct == null || barometricPct == null) return null;
  const difference =
    Math.round(Math.abs(correctedPct - barometricPct) * 10) / 10;
  const limit = ELEVATION_SENSITIVITY.gapDeltaPts;
  return {
    difference,
    warning:
      difference > limit
        ? `The grade-adjusted second-half change differs by ${difference} points between elevation sources (${formatSigned(correctedPct, 1)}% corrected, ${formatSigned(barometricPct, 1)}% barometric), more than ${limit}. ${distrust("grade-adjusted verdict")}`
        : null,
  };
}

/** get-hill-analysis: total climb gain under each source, as a percent of
 * the larger total; it warns only when the metres apart also pass the
 * floor. */
export function climbGainSensitivity(
  correctedM: number,
  barometricM: number,
): ElevationSensitivity {
  const larger = Math.max(correctedM, barometricM);
  const difference =
    larger > 0
      ? Math.round((Math.abs(correctedM - barometricM) / larger) * 100)
      : 0;
  const limit = ELEVATION_SENSITIVITY.climbGainPct;
  const metres = Math.abs(correctedM - barometricM);
  return {
    difference,
    warning:
      difference > limit && metres >= ELEVATION_SENSITIVITY.climbGainMinM
        ? `Climb gain differs by ${difference}% between elevation sources (+${correctedM} m corrected, +${barometricM} m barometric), more than ${limit}%. ${distrust("climb list")}`
        : null,
  };
}
