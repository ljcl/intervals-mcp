import { z } from "zod";
import { getActivity } from "../intervalsClient";
import {
  IntervalsStreamsUnavailableError,
  loadIntervalsStreams,
} from "../intervalsStreams";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import {
  computeSplitAnalysis,
  type Split,
  SplitAnalysisError,
  type SplitStreams,
} from "../splitAnalysis";
import {
  cadenceSpm,
  formatPaceSeconds,
  isStepCadenceActivity,
} from "../utils/running";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
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

Notes:
- Halves are cut at the exact midpoint of recorded distance.
- Stopped time is excluded from pace. A trailing partial split is marked and
  left out of fastest and slowest.
- Grade comes from intervals.icu's smoothed grade, else altitude. With
  neither, the terrain correction is unavailable and the response says so.
- An activity with no recorded streams (a manual entry) returns an error.
`;

const inputSchema = z.object({
  id: intervalsActivityIdInput("The intervals.icu activity id."),
});

type GetSplitAnalysisInput = z.infer<typeof inputSchema>;

const STREAM_TYPES = [
  "distance",
  "altitude",
  "grade_smooth",
  "heartrate",
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

function splitLine(s: ReturnType<typeof splitOut>): string {
  const parts = [
    s.pace_min_per_km ? `${s.pace_min_per_km} /km` : "no pace",
    s.gap_pace_min_per_km && s.gap_pace_min_per_km !== s.pace_min_per_km
      ? `GAP ${s.gap_pace_min_per_km} /km`
      : null,
    s.elevation_change_m != null
      ? `${s.elevation_change_m >= 0 ? "+" : ""}${s.elevation_change_m} m`
      : null,
    s.avg_hr != null ? `${s.avg_hr} bpm` : null,
    s.avg_watts != null ? `${s.avg_watts} W` : null,
  ].filter(Boolean);
  // "3." for a full split, "0.62 km (partial)" for the trailing remainder,
  // whose pace is extrapolated and should not read like the others.
  const label = s.partial
    ? `${(s.distance_m / 1000).toFixed(2)} km (partial)`
    : `${s.split}.`;
  return `  ${label.padEnd(4)} ${parts.join(", ")}`;
}

export const getSplitAnalysisTool = {
  name,
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: SplitAnalysisOutputSchema,
  execute: async (
    { id }: GetSplitAnalysisInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    try {
      progress(`Fetching activity ${id}`);
      const activity = await getActivity(apiKey, id);
      const type = activity.type ?? "Workout";
      const displayName = activity.name ?? type;

      progress(`Fetching streams for "${displayName}"`);
      let streams: Awaited<ReturnType<typeof loadIntervalsStreams>>;
      try {
        streams = await loadIntervalsStreams(apiKey, id, [...STREAM_TYPES]);
      } catch (error) {
        if (error instanceof IntervalsStreamsUnavailableError) {
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
      const splitStreams: SplitStreams = {
        time: streams.time,
        distance: streams.distance ?? [],
        altitude: streams.altitude,
        grade_smooth: streams.grade_smooth,
        heartrate: streams.heartrate,
        velocity_smooth: streams.velocity_smooth,
        cadence: streams.cadence,
        watts: streams.watts,
        moving: streams.moving,
      };
      const analysis = computeSplitAnalysis(splitStreams);

      const structured = {
        activity_id: id,
        name: displayName,
        date: activity.start_date_local,
        type,
        grade_source: analysis.gradeSource,
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
          elapsed_time_s: analysis.totals.elapsedTimeS,
          elevation_gain_m: analysis.totals.elevationGainM,
          avg_pace_sec_per_km: analysis.totals.avgPaceSecPerKm,
          avg_pace_min_per_km: paceMinPerKm(analysis.totals.avgPaceSecPerKm),
          avg_gap_pace_sec_per_km: analysis.totals.avgGapPaceSecPerKm,
        },
        units: {
          distance: "km" as const,
          elevation: "m" as const,
          pace: "min/km" as const,
          time: "s" as const,
          grade: "%" as const,
          hr: "bpm" as const,
          cadence: isStepCadenceActivity(type)
            ? ("spm" as const)
            : ("rpm" as const),
          power: "W" as const,
        },
        warnings: analysis.warnings,
      };
      warnOnSchemaDrift(name, SplitAnalysisOutputSchema, structured);

      const distanceLabel = (analysis.totals.distanceM / 1000).toFixed(2);
      const lines = [
        `Split Analysis: ${structured.name} (${structured.date})`,
        `Grade source: ${structured.grade_source}`,
        `${distanceLabel} km, ${analysis.splits.length} splits, average ${structured.totals.avg_pace_min_per_km ? `${structured.totals.avg_pace_min_per_km} min/km` : "n/a"}`,
        "",
      ];

      const verdict = structured.verdict;
      if (verdict) {
        const sign = (value: number) => (value >= 0 ? "+" : "");
        lines.push(
          `Verdict: ${verdict.shape} split on the clock, ${verdict.gap_shape} grade-adjusted`,
          `  First half ${verdict.first_half_pace_min_per_km} min/km, second half ${verdict.second_half_pace_min_per_km} min/km (${sign(verdict.delta_pct)}${verdict.delta_pct}%)`,
        );
        if (verdict.gap_delta_pct != null) {
          lines.push(
            `  Grade-adjusted: ${sign(verdict.gap_delta_pct)}${verdict.gap_delta_pct}% (terrain accounts for ${sign(verdict.terrain_pct ?? 0)}${verdict.terrain_pct} points)`,
          );
        }
        lines.push(`  ${verdict.interpretation}`, "");
      }

      lines.push(`Splits (km):`);
      for (const split of structured.splits) {
        lines.push(splitLine(split));
      }
      if (structured.fastest_split != null) {
        lines.push(
          "",
          `Fastest split ${structured.fastest_split}, slowest split ${structured.slowest_split}`,
        );
      }

      if (structured.warnings.length > 0) lines.push("");
      for (const warning of structured.warnings) {
        lines.push(`Warning: ${warning}`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: structured,
      };
    } catch (error) {
      if (error instanceof SplitAnalysisError) {
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
