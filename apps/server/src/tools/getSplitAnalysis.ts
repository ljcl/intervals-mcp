import { z } from "zod";
import {
  ELEVATION_SOURCE_CHOICES,
  type ElevationSource,
  elevationGainLine,
  elevationLines,
  gapDeltaSensitivity,
  recordedGainFor,
  resolveBothElevations,
  resolveElevation,
  streamGainM,
} from "../elevationSource";
import { formatDuration, formatSigned } from "../formatters";
import { cadenceLabel, cadenceUnit } from "../intervalLaps";
import { getActivity, type IntervalsActivity } from "../intervalsClient";
import {
  IntervalsStreamsUnavailableError,
  loadIntervalsStreams,
} from "../intervalsStreams";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import {
  computeSplitAnalysis,
  type Split,
  type SplitAnalysis,
  SplitAnalysisError,
  type SplitStreams,
} from "../splitAnalysis";
import {
  cadenceSpm,
  formatPaceSeconds,
  isPaceActivity,
  paceFromDistanceTime,
} from "../utils/running";
import { READ_ONLY } from "./_annotations";
import { notARunText, noteToolFailure, toolErrorText } from "./_errors";
import { intervalsActivityIdInput } from "./_ids";
import { SplitAnalysisOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-split-analysis";

const description = `
Breaks one run into even 1 km splits (moving pace, grade-adjusted pace,
elevation, grade, HR, cadence, power) and gives a two-halves pacing verdict
twice, on the clock and grade-adjusted, with how many percentage points of
the change the terrain explains. Use it for "did I fade?" and pacing
discipline.

It ignores device laps: use get-activity-laps for those and
get-interval-analysis for workout reps. For climbs, use get-hill-analysis.
For the fastest 1 km or 5 km anywhere in the run, not on km marks, use
get-best-efforts with its id.

Notes:
- Halves are cut at the exact midpoint of recorded distance.
- Stopped time is excluded from pace. A trailing partial split is marked and
  left out of fastest and slowest.
- Grade comes from altitude, else intervals.icu's smoothed grade, averaged
  over 100 m for the grade adjustment. A noisy elevation track adds a
  warning. With no elevation data, the grade-adjusted figures are null and
  the verdict is on the clock only.
- The altitude is intervals.icu's corrected elevation when the activity has
  elevation correction on, else the recorded (barometric) one;
  elevation_source says which and elevation_note why. elevationSource
  "both" adds elevation_comparison and warns when the sources disagree.
- Elevation gain is intervals.icu's own total (as get-activity reports it),
  else summed from the altitude samples. That total follows corrected
  elevation, so a barometric call on a corrected activity sums the samples.
- An activity with no recorded streams (a manual entry) returns an error.
- Runs only (Run, TrailRun, VirtualRun): any other type returns an error
  pointing at get-activity.
`;

const inputSchema = z.object({
  id: intervalsActivityIdInput("The intervals.icu activity id."),
  elevationSource: z
    .enum(ELEVATION_SOURCE_CHOICES)
    .optional()
    .describe(
      'Altitude for grade, GAP and elevation. "corrected" (default) is intervals.icu\'s corrected elevation when the activity has elevation correction on, else the recorded altitude; "barometric" the recorded altitude; "both" each source\'s splits and verdict side by side, or the barometric result with a note when there is no corrected stream.',
    ),
});

type GetSplitAnalysisInput = z.infer<typeof inputSchema>;

const STREAM_TYPES = [
  "distance",
  "altitude",
  "fixed_altitude",
  "grade_smooth",
  "heartrate",
  // Not read for GAP (#298); the loader derives `moving` from it.
  "velocity_smooth",
  "cadence",
  "watts",
] as const;

/** Bare `m:ss`, no unit suffix; the structured field name (`*_min_per_km`)
 * carries the unit, `formatPaceSeconds` is the one home for the rendering. */
const paceMinPerKm = (secPerKm: number | null) =>
  secPerKm == null ? null : formatPaceSeconds(secPerKm);

function splitOut(split: Split, type: string) {
  return {
    split: split.index,
    start_m: split.startM,
    end_m: split.endM,
    distance_m: split.distanceM,
    partial: split.partial,
    moving_time_s: split.movingTimeS,
    elapsed_time_s: split.elapsedTimeS,
    pace_sec_per_km: split.paceSecPerKm,
    pace_min_per_km: paceMinPerKm(split.paceSecPerKm),
    gap_pace_sec_per_km: split.gapPaceSecPerKm,
    gap_pace_min_per_km: paceMinPerKm(split.gapPaceSecPerKm),
    elevation_change_m: split.elevationChangeM,
    avg_grade_pct: split.avgGradePct,
    avg_hr: split.avgHr,
    avg_cadence: cadenceSpm(split.avgCadence, type),
    avg_watts: split.avgWatts,
  };
}

/**
 * Which moving time the split paces use. The streams leave out every stop,
 * as the watch's own timer does; intervals.icu's moving_time follows its own
 * rule, so the two paces differ (docs/api-notes.md, "Moving time"). The
 * line names both when they differ, so neither reads as an error.
 */
function movingTimeLine(
  streamsS: number,
  intervalsIcuS: number | null,
  distanceM: number | null | undefined,
): string {
  const streams = `Moving time ${formatDuration(streamsS)} (streams: stops left out)`;
  if (intervalsIcuS == null || intervalsIcuS === streamsS) return streams;
  const paceText = paceFromDistanceTime(distanceM, intervalsIcuS);
  const pace = paceText ? `, ${paceText} /km` : "";
  return `${streams}; intervals.icu's own moving time is ${formatDuration(intervalsIcuS)}${pace}, which get-running-summary uses`;
}

type SplitOut = ReturnType<typeof splitOut>;

/** The optional columns of the split table. */
interface SplitColumns {
  gap: boolean;
  elevation: boolean;
  hr: boolean;
  watts: boolean;
}

/**
 * A column is in the table when any split has a value for it, and then
 * every row prints it, "n/a" when that split has none: rows with different
 * columns are hard to read down. GAP prints even when it equals the pace.
 */
function splitColumns(splits: SplitOut[]): SplitColumns {
  return {
    gap: splits.some((s) => s.gap_pace_min_per_km != null),
    elevation: splits.some((s) => s.elevation_change_m != null),
    hr: splits.some((s) => s.avg_hr != null),
    watts: splits.some((s) => s.avg_watts != null),
  };
}

function splitLine(s: SplitOut, columns: SplitColumns): string {
  const parts = [
    s.pace_min_per_km ? `${s.pace_min_per_km} /km` : "no pace",
    columns.gap
      ? `GAP ${s.gap_pace_min_per_km ? `${s.gap_pace_min_per_km} /km` : "n/a"}`
      : null,
    columns.elevation
      ? s.elevation_change_m != null
        ? `${formatSigned(s.elevation_change_m)} m`
        : "elevation n/a"
      : null,
    columns.hr ? (s.avg_hr != null ? `${s.avg_hr} bpm` : "HR n/a") : null,
    columns.watts
      ? s.avg_watts != null
        ? `${s.avg_watts} W`
        : "power n/a"
      : null,
  ].filter(Boolean);
  // "3." for a full split, "0.62 km (partial)" for the trailing remainder,
  // whose pace is extrapolated and should not read like the others.
  const label = s.partial
    ? `${(s.distance_m / 1000).toFixed(2)} km (partial)`
    : `${s.split}.`;
  return `  ${label.padEnd(4)} ${parts.join(", ")}`;
}

/** A split analysis plus which elevation stream it read. */
export interface LoadedSplitAnalysis extends SplitAnalysis {
  elevationSource: ElevationSource | null;
  elevationNote: string | null;
}

/** One source's splits and verdict for `elevation_comparison`. */
function sourceOut(analysis: SplitAnalysis, gainM: number | null) {
  return {
    elevation_gain_m: gainM,
    verdict: analysis.verdict
      ? {
          gap_shape: analysis.verdict.gapShape,
          gap_delta_pct: analysis.verdict.gapDeltaPct,
          terrain_pct: analysis.verdict.terrainPct,
          interpretation: analysis.verdict.interpretation,
        }
      : null,
    splits: analysis.splits.map((split) => ({
      split: split.index,
      partial: split.partial,
      gap_pace_sec_per_km: split.gapPaceSecPerKm,
      gap_pace_min_per_km: paceMinPerKm(split.gapPaceSecPerKm),
      elevation_change_m: split.elevationChangeM,
      avg_grade_pct: split.avgGradePct,
    })),
  };
}

type SplitSourceOut = ReturnType<typeof sourceOut>;

/**
 * Each source's splits side by side (elevationSource: "both"). The source
 * the headline used reuses its analysis; the stream read is the cached
 * superset, so the other source costs no request. A source the activity
 * does not have is null, with the note.
 */
async function splitComparison(
  apiKey: string,
  id: string,
  activity: Pick<
    IntervalsActivity,
    "total_elevation_gain" | "use_elevation_correction"
  >,
  primary: LoadedSplitAnalysis,
) {
  const streams = await loadIntervalsStreams(apiKey, id, [...STREAM_TYPES]);
  const both = resolveBothElevations(activity, streams);
  const forSource = async (source: ElevationSource) => {
    const resolved = both[source];
    if (!resolved) return null;
    const analysis =
      primary.elevationSource === source
        ? primary
        : await loadSplitAnalysis(apiKey, id, activity, source === "corrected");
    return sourceOut(analysis, streamGainM(resolved.altitude));
  };
  const corrected = await forSource("corrected");
  const barometric = await forSource("barometric");
  const sensitivity = gapDeltaSensitivity(
    corrected?.verdict?.gap_delta_pct ?? null,
    barometric?.verdict?.gap_delta_pct ?? null,
  );
  return {
    corrected,
    barometric,
    gap_delta_difference_pts: sensitivity?.difference ?? null,
    note: both.note,
    sensitivity_warning: sensitivity?.warning ?? null,
  };
}

type SplitComparison = Awaited<ReturnType<typeof splitComparison>>;

const verdictText = (result: SplitSourceOut | null) =>
  result?.verdict?.gap_shape
    ? `${result.verdict.gap_shape} (${formatSigned(result.verdict.gap_delta_pct ?? 0)}%)`
    : "n/a";

/** The text of `elevation_comparison`: one line per km, corrected first. */
function comparisonLines(comparison: SplitComparison): string[] {
  const { corrected, barometric } = comparison;
  const lines = [
    "By elevation source (corrected | barometric):",
    `  Grade-adjusted verdict: ${verdictText(corrected)} | ${verdictText(barometric)}`,
  ];
  const rows = Math.max(
    corrected?.splits.length ?? 0,
    barometric?.splits.length ?? 0,
  );
  const gap = (s: SplitSourceOut["splits"][number] | undefined) =>
    s?.gap_pace_min_per_km ?? "n/a";
  const elevation = (s: SplitSourceOut["splits"][number] | undefined) =>
    s?.elevation_change_m != null
      ? `${formatSigned(s.elevation_change_m)} m`
      : "n/a";
  for (let i = 0; i < rows; i++) {
    const c = corrected?.splits[i];
    const b = barometric?.splits[i];
    const label = (c ?? b)?.partial ? "end" : `${i + 1}.`;
    lines.push(
      `  ${label.padEnd(4)} GAP ${gap(c)} | ${gap(b)} /km, ${elevation(c)} | ${elevation(b)}`,
    );
  }
  if (comparison.note) lines.push(`  ${comparison.note}`);
  lines.push("");
  return lines;
}

/**
 * The split analysis of one activity: its streams through the shared
 * adapter, binned by `computeSplitAnalysis`. The one stream path for 1 km
 * splits, shared with compare-activities' per-km table. Elevation is the
 * corrected stream when the activity has one, unless `useCorrectedElevation`
 * is false (`resolveElevation`). Throws
 * `IntervalsStreamsUnavailableError` for an activity with no streams and
 * `SplitAnalysisError` for streams it cannot split.
 */
export async function loadSplitAnalysis(
  apiKey: string,
  id: string,
  activity: Pick<
    IntervalsActivity,
    "total_elevation_gain" | "use_elevation_correction"
  >,
  useCorrectedElevation = true,
): Promise<LoadedSplitAnalysis> {
  const streams = await loadIntervalsStreams(apiKey, id, [...STREAM_TYPES]);
  const elevation = resolveElevation(activity, streams, useCorrectedElevation);
  const splitStreams: SplitStreams = {
    time: streams.time,
    distance: streams.distance ?? [],
    altitude: elevation.altitude,
    grade_smooth: streams.grade_smooth,
    heartrate: streams.heartrate,
    cadence: streams.cadence,
    watts: streams.watts,
    moving: streams.moving,
  };
  const analysis = computeSplitAnalysis(splitStreams, {
    recordedElevationGainM: recordedGainFor(activity, useCorrectedElevation),
  });
  return {
    ...analysis,
    elevationSource: elevation.source,
    elevationNote: elevation.note,
  };
}

export const getSplitAnalysisTool = {
  name,
  title: "Split analysis",
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: SplitAnalysisOutputSchema,
  execute: async (
    { id, elevationSource = "corrected" }: GetSplitAnalysisInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    try {
      progress(`Fetching activity ${id}`);
      const activity = await getActivity(apiKey, id);
      const type = activity.type ?? "Workout";
      const displayName = activity.name ?? type;
      if (!isPaceActivity(type)) {
        return {
          content: [
            {
              type: "text" as const,
              text: notARunText(name, activity, id, type),
            },
          ],
          isError: true,
        };
      }

      progress(`Fetching streams for "${displayName}"`);
      let analysis: LoadedSplitAnalysis;
      try {
        analysis = await loadSplitAnalysis(
          apiKey,
          id,
          activity,
          elevationSource !== "barometric",
        );
      } catch (error) {
        if (error instanceof IntervalsStreamsUnavailableError) {
          noteToolFailure(error);
          return {
            content: [
              {
                type: "text" as const,
                text: `❌ No data streams are recorded for "${displayName}" (activity ${id}): this looks like an activity with no GPS streams (e.g. Pilates, or a manual entry), so split analysis has nothing to work with.`,
              },
            ],
            isError: true,
          };
        }
        throw error;
      }
      progress("Computing split analysis", { important: true });
      const comparison =
        elevationSource === "both"
          ? await splitComparison(apiKey, id, activity, analysis)
          : null;

      const structured = {
        activity_id: id,
        name: displayName,
        date: activity.start_date_local,
        type,
        grade_source: analysis.gradeSource,
        elevation_source: analysis.elevationSource,
        elevation_note: analysis.elevationNote,
        // GAP throughout this response is locally modelled from grade
        // (hillAnalysis.ts's gapFactor, imported by splitAnalysis.ts), not
        // intervals.icu's own gap field (see get-activity/compare-activities/
        // get-activity-laps' gap_source: "intervals.icu").
        gap_source: "model" as const,
        verdict: analysis.verdict
          ? {
              shape: analysis.verdict.shape,
              gap_shape: analysis.verdict.gapShape,
              first_half_pace_sec_per_km:
                analysis.verdict.firstHalfPaceSecPerKm,
              second_half_pace_sec_per_km:
                analysis.verdict.secondHalfPaceSecPerKm,
              first_half_pace_min_per_km: paceMinPerKm(
                analysis.verdict.firstHalfPaceSecPerKm,
              ),
              second_half_pace_min_per_km: paceMinPerKm(
                analysis.verdict.secondHalfPaceSecPerKm,
              ),
              first_half_gap_pace_sec_per_km:
                analysis.verdict.firstHalfGapPaceSecPerKm,
              second_half_gap_pace_sec_per_km:
                analysis.verdict.secondHalfGapPaceSecPerKm,
              delta_pct: analysis.verdict.deltaPct,
              gap_delta_pct: analysis.verdict.gapDeltaPct,
              terrain_pct: analysis.verdict.terrainPct,
              first_half_elevation_change_m:
                analysis.verdict.firstHalfElevationChangeM,
              second_half_elevation_change_m:
                analysis.verdict.secondHalfElevationChangeM,
              interpretation: analysis.verdict.interpretation,
            }
          : null,
        splits: analysis.splits.map((split) => splitOut(split, type)),
        fastest_split: analysis.fastestSplitIndex,
        slowest_split: analysis.slowestSplitIndex,
        totals: {
          distance_m: analysis.totals.distanceM,
          moving_time_s: analysis.totals.movingTimeS,
          moving_time_source: "streams" as const,
          intervals_icu_moving_time_s: activity.moving_time ?? null,
          elapsed_time_s: analysis.totals.elapsedTimeS,
          elevation_gain_m: analysis.totals.elevationGainM,
          elevation_gain_source: analysis.totals.elevationGainSource,
          avg_pace_sec_per_km: analysis.totals.avgPaceSecPerKm,
          avg_pace_min_per_km: paceMinPerKm(analysis.totals.avgPaceSecPerKm),
          avg_gap_pace_sec_per_km: analysis.totals.avgGapPaceSecPerKm,
        },
        elevation_comparison: comparison,
        units: {
          distance: "km" as const,
          elevation: "m" as const,
          pace: "min/km" as const,
          time: "s" as const,
          grade: "%" as const,
          hr: "bpm" as const,
          cadence: cadenceUnit(type),
          cadence_label: cadenceLabel(type),
          power: "W" as const,
        },
        warnings: comparison?.sensitivity_warning
          ? [...analysis.warnings, comparison.sensitivity_warning]
          : analysis.warnings,
      };
      warnOnSchemaDrift(name, SplitAnalysisOutputSchema, structured);

      const distanceLabel = (analysis.totals.distanceM / 1000).toFixed(2);
      const gain = structured.totals.elevation_gain_m;
      const lines = [
        `Split Analysis: ${structured.name} (${structured.date})`,
        `Grade source: ${structured.grade_source}`,
        ...elevationLines({
          source: analysis.elevationSource,
          note: analysis.elevationNote,
        }),
        ...(comparison
          ? [
              elevationGainLine({
                corrected: comparison.corrected?.elevation_gain_m ?? null,
                barometric: comparison.barometric?.elevation_gain_m ?? null,
              }),
            ]
          : []),
        `${distanceLabel} km, ${analysis.splits.length} splits, average ${structured.totals.avg_pace_min_per_km ? `${structured.totals.avg_pace_min_per_km} min/km` : "n/a"}${gain != null ? `, +${Math.round(gain)} m gain (${structured.totals.elevation_gain_source})` : ""}`,
        movingTimeLine(
          structured.totals.moving_time_s,
          structured.totals.intervals_icu_moving_time_s,
          activity.distance,
        ),
        "",
      ];

      const verdict = structured.verdict;
      if (verdict) {
        lines.push(
          verdict.gap_shape
            ? `Verdict: ${verdict.shape} split on the clock, ${verdict.gap_shape} grade-adjusted`
            : `Verdict: ${verdict.shape} split on the clock (no elevation data, so no grade-adjusted verdict)`,
          `  First half ${verdict.first_half_pace_min_per_km} min/km, second half ${verdict.second_half_pace_min_per_km} min/km (${formatSigned(verdict.delta_pct)}%)`,
        );
        if (verdict.gap_delta_pct != null) {
          lines.push(
            `  Grade-adjusted: ${formatSigned(verdict.gap_delta_pct)}% (terrain accounts for ${formatSigned(verdict.terrain_pct ?? 0)} points)`,
          );
        }
        lines.push(`  ${verdict.interpretation}`, "");
      }

      lines.push(`Splits (km):`);
      const columns = splitColumns(structured.splits);
      for (const split of structured.splits) {
        lines.push(splitLine(split, columns));
      }
      if (structured.fastest_split != null) {
        lines.push(
          "",
          `Fastest split ${structured.fastest_split}, slowest split ${structured.slowest_split}`,
        );
      }

      if (comparison) lines.push("", ...comparisonLines(comparison));
      if (structured.warnings.length > 0 && !comparison) lines.push("");
      for (const warning of structured.warnings) {
        lines.push(`Warning: ${warning}`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: structured,
      };
    } catch (error) {
      if (error instanceof SplitAnalysisError) {
        noteToolFailure(error);
        return {
          content: [{ type: "text" as const, text: `❌ ${error.message}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: toolErrorText(error, {
              context: `compute split analysis for activity ${id}`,
              notFound: `Activity ${id} was not found.`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
