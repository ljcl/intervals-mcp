import { z } from "zod";
import { ignoreWarnings } from "../activityIgnore";
import {
  type BothElevations,
  climbGainSensitivity,
  ELEVATION_SOURCE_CHOICES,
  elevationGainLine,
  elevationLines,
  type ResolvedElevation,
  resolveBothElevations,
  resolveElevation,
  streamGainM,
} from "../elevationSource";
import { formatSigned } from "../formatters";
import {
  computeHillAnalysis,
  gapModelLine,
  gapSourceOf,
  type HillAnalysis,
  HillAnalysisError,
  type HillSegment,
  type HillStreams,
  resolveGapModel,
} from "../hillAnalysis";
import { cadenceLabel, cadenceUnit } from "../intervalLaps";
import { getActivity } from "../intervalsClient";
import {
  type IntervalsStreams,
  IntervalsStreamsUnavailableError,
  loadIntervalsStreams,
} from "../intervalsStreams";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import {
  cadenceSpm,
  formatPaceSeconds,
  isIndoor,
  isPaceActivity,
} from "../utils/running";
import { READ_ONLY } from "./_annotations";
import { notARunText, noteToolFailure, toolErrorText } from "./_errors";
import { intervalsActivityIdInput } from "./_ids";
import { HillAnalysisOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-hill-analysis";

const description = `
Finds the sustained climbs (at least 2% for at least 200 m) and descents in
one activity, with each segment's length, grade, gain, moving and
grade-adjusted pace, HR, cadence and power. The headline is early-versus-late
climb drift: HR per unit of grade-adjusted speed on climbs in the first half
against the second half. Positive drift means the same climbing cost more
late in the run.

For per-km pacing on a hilly course, use get-split-analysis; for whole-run
aerobic durability, get-aerobic-analysis.

Notes:
- Grade comes from altitude over about 30 m, the same altitude each
  segment's grade and gain are read from, else from intervals.icu's smoothed
  grade stream; grade_source says which.
- Grade-adjusted pace is intervals.icu's own (the Strava model, as
  get-activity shows it) when the activity has it; gap_model says which
  model, and gap_note why a fallback happened. The fallback is the Minetti
  model on grade averaged over 100 m, where a noisy elevation track adds a
  warning.
- The altitude is intervals.icu's corrected elevation when the activity has
  elevation correction on, else the recorded (barometric) altitude;
  elevation_source says which, and elevation_note says why a fallback
  happened. elevationSource "both" adds elevation_comparison, each source's
  climbs, and warns when the sources disagree.
- With no elevation data (no grade and no real altitude samples), it
  returns an error rather than treating the run as flat.
- Works without power, and without HR (the drift then uses grade-adjusted
  pace only).
- Stopped time is excluded from segment pace.
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
      'Altitude to find climbs on. "corrected" (default) is intervals.icu\'s corrected elevation when the activity has elevation correction on, else the recorded altitude; "barometric" the recorded altitude; "both" each source\'s climbs side by side, or the barometric result with a note when there is no corrected stream.',
    ),
});

type GetHillAnalysisInput = z.infer<typeof inputSchema>;

const STREAM_TYPES = [
  "distance",
  "altitude",
  "fixed_altitude",
  "grade_smooth",
  "ga_velocity",
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

function segmentOut(segment: HillSegment, type: string) {
  return {
    start_km: segment.startKm,
    end_km: segment.endKm,
    length_m: segment.lengthM,
    elevation_change_m: segment.elevationChangeM,
    avg_grade_pct: segment.avgGradePct,
    moving_time_s: segment.movingTimeS,
    pace_sec_per_km: segment.paceSecPerKm,
    pace_min_per_km: paceMinPerKm(segment.paceSecPerKm),
    gap_pace_sec_per_km: segment.gapPaceSecPerKm,
    gap_pace_min_per_km: paceMinPerKm(segment.gapPaceSecPerKm),
    avg_hr: segment.avgHr,
    avg_cadence: cadenceSpm(segment.avgCadence, type),
    avg_watts: segment.avgWatts,
    hr_per_gap_speed: segment.hrPerGapSpeed,
  };
}

/**
 * `gaVelocity` is `resolveGapModel`'s choice for this altitude. The source
 * comparison leaves it out: it reports climbs and gain, no GAP.
 */
function hillStreamsFor(
  streams: IntervalsStreams,
  altitude: ResolvedElevation["altitude"],
  gaVelocity?: HillStreams["ga_velocity"],
): HillStreams {
  return {
    time: streams.time,
    distance: streams.distance ?? [],
    altitude,
    grade_smooth: streams.grade_smooth,
    ga_velocity: gaVelocity,
    heartrate: streams.heartrate,
    cadence: streams.cadence,
    watts: streams.watts,
    moving: streams.moving,
  };
}

/** One source's climbs for `elevation_comparison`. */
function sourceOut(analysis: HillAnalysis, gainM: number | null) {
  return {
    elevation_gain_m: gainM,
    climb_count: analysis.totals.climbCount,
    climb_gain_m: analysis.totals.climbGainM,
    climbs: analysis.climbs.map((c) => ({
      start_km: c.startKm,
      end_km: c.endKm,
      length_m: c.lengthM,
      avg_grade_pct: c.avgGradePct,
      elevation_change_m: c.elevationChangeM,
    })),
  };
}

/**
 * Each source's climbs side by side (elevationSource: "both"). The source
 * the headline used reuses its analysis; a source whose stream cannot be
 * analysed is null, as a missing one is.
 */
function hillComparison(
  both: BothElevations,
  streams: IntervalsStreams,
  primary: { altitude: ResolvedElevation["altitude"]; analysis: HillAnalysis },
) {
  const forSource = (resolved: ResolvedElevation | null) => {
    if (!resolved) return null;
    let analysis = primary.analysis;
    if (resolved.altitude !== primary.altitude) {
      try {
        analysis = computeHillAnalysis(
          hillStreamsFor(streams, resolved.altitude),
        );
      } catch (error) {
        if (error instanceof HillAnalysisError) return null;
        throw error;
      }
    }
    return sourceOut(analysis, streamGainM(resolved.altitude));
  };
  const corrected = forSource(both.corrected);
  const barometric = forSource(both.barometric);
  const sensitivity =
    corrected && barometric
      ? climbGainSensitivity(corrected.climb_gain_m, barometric.climb_gain_m)
      : null;
  return {
    corrected,
    barometric,
    climb_gain_difference_pct: sensitivity?.difference ?? null,
    note: both.note,
    sensitivity_warning: sensitivity?.warning ?? null,
  };
}

type HillComparison = ReturnType<typeof hillComparison>;

/** The text of `elevation_comparison`: each source's climbs. */
function comparisonLines(comparison: HillComparison): string[] {
  const lines = ["Climbs by elevation source:"];
  for (const source of ["corrected", "barometric"] as const) {
    const result = comparison[source];
    if (!result) {
      lines.push(`  ${source}: not available`);
      continue;
    }
    lines.push(
      `  ${source}: ${result.climb_count} ${result.climb_count === 1 ? "climb" : "climbs"}, +${result.climb_gain_m} m`,
    );
    for (const c of result.climbs) {
      lines.push(
        `    km ${c.start_km}-${c.end_km}, ${c.length_m} m @ ${c.avg_grade_pct}%, ${formatSigned(c.elevation_change_m)} m`,
      );
    }
  }
  if (comparison.note) lines.push(`  ${comparison.note}`);
  lines.push("");
  return lines;
}

function segmentLine(s: ReturnType<typeof segmentOut>): string {
  const parts = [
    `km ${s.start_km}-${s.end_km}`,
    `${s.length_m} m @ ${s.avg_grade_pct}%`,
    `${formatSigned(s.elevation_change_m)} m`,
    s.pace_min_per_km ? `pace ${s.pace_min_per_km} /km` : null,
    s.gap_pace_min_per_km ? `GAP ${s.gap_pace_min_per_km} /km` : null,
    s.avg_hr != null ? `${s.avg_hr} bpm` : null,
    s.avg_watts != null ? `${s.avg_watts} W` : null,
  ].filter(Boolean);
  return `  ${parts.join(", ")}`;
}

export const getHillAnalysisTool = {
  name,
  title: "Hill analysis",
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: HillAnalysisOutputSchema,
  execute: async (
    { id, elevationSource = "corrected" }: GetHillAnalysisInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    // Known after the activity read; the error text below names it.
    let indoor = false;
    try {
      progress(`Fetching activity ${id}`);
      const activity = await getActivity(apiKey, id);
      indoor = isIndoor(activity);
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
      let streams: Awaited<ReturnType<typeof loadIntervalsStreams>>;
      try {
        streams = await loadIntervalsStreams(apiKey, id, [...STREAM_TYPES]);
      } catch (error) {
        if (error instanceof IntervalsStreamsUnavailableError) {
          noteToolFailure(error);
          return {
            content: [
              {
                type: "text" as const,
                text: `❌ No data streams are recorded for "${displayName}" (activity ${id}): this looks like an activity with no GPS streams (e.g. Pilates, or a manual entry), so hill analysis has nothing to work with.`,
              },
            ],
            isError: true,
          };
        }
        throw error;
      }

      progress("Computing hill analysis", { important: true });
      const elevation = resolveElevation(
        activity,
        streams,
        elevationSource !== "barometric",
      );
      const gapModel = resolveGapModel(activity, streams, elevation.source);
      const analysis = computeHillAnalysis(
        hillStreamsFor(streams, elevation.altitude, gapModel.gaVelocity),
      );
      const comparison =
        elevationSource === "both"
          ? hillComparison(resolveBothElevations(activity, streams), streams, {
              altitude: elevation.altitude,
              analysis,
            })
          : null;
      const warnings = [
        ...analysis.warnings,
        ...(comparison?.sensitivity_warning
          ? [comparison.sensitivity_warning]
          : []),
        ...ignoreWarnings(activity, { hr: true, pace: true }),
      ];

      const structured = {
        activity_id: id,
        name: displayName,
        date: activity.start_date_local,
        type,
        grade_source: analysis.gradeSource,
        elevation_source: elevation.source,
        elevation_note: elevation.note,
        // One model for every GAP in this response (hillAnalysis.ts's
        // gapBasis): intervals.icu's own when the activity has it, the one
        // get-activity and get-activity-laps print, else Minetti from grade.
        gap_source: gapSourceOf(analysis.gapModel),
        gap_model: analysis.gapModel,
        gap_note: gapModel.note,
        drift: analysis.drift
          ? {
              basis: analysis.drift.basis,
              early_value: analysis.drift.earlyValue,
              late_value: analysis.drift.lateValue,
              drift_pct: analysis.drift.driftPct,
              early_climbs: analysis.drift.earlyClimbs,
              late_climbs: analysis.drift.lateClimbs,
            }
          : null,
        climbs: analysis.climbs.map((c) => segmentOut(c, type)),
        descents: analysis.descents.map((d) => segmentOut(d, type)),
        totals: {
          climb_count: analysis.totals.climbCount,
          descent_count: analysis.totals.descentCount,
          climb_distance_m: analysis.totals.climbDistanceM,
          climb_gain_m: analysis.totals.climbGainM,
        },
        elevation_comparison: comparison,
        units: {
          distance: "km" as const,
          length: "m" as const,
          elevation: "m" as const,
          pace: "min/km" as const,
          time: "s" as const,
          grade: "%" as const,
          hr: "bpm" as const,
          cadence: cadenceUnit(type),
          cadence_label: cadenceLabel(type),
          power: "W" as const,
        },
        warnings,
      };
      warnOnSchemaDrift(name, HillAnalysisOutputSchema, structured);

      const lines = [
        `Hill Analysis: ${structured.name} (${structured.date})`,
        `Grade source: ${structured.grade_source}`,
        ...elevationLines(elevation),
        gapModelLine({ model: analysis.gapModel, note: gapModel.note }),
        ...(comparison
          ? [
              elevationGainLine({
                corrected: comparison.corrected?.elevation_gain_m ?? null,
                barometric: comparison.barometric?.elevation_gain_m ?? null,
              }),
            ]
          : []),
        `${structured.totals.climb_count} climbs (${structured.totals.climb_distance_m} m, +${structured.totals.climb_gain_m} m), ${structured.totals.descent_count} descents`,
        "",
      ];

      if (structured.drift) {
        const d = structured.drift;
        const basisLabel =
          d.basis === "hr_per_gap"
            ? "HR per grade-adjusted speed"
            : "grade-adjusted pace (no HR)";
        lines.push(
          `Late-vs-early climb drift: ${formatSigned(d.drift_pct)}% (${basisLabel})`,
          `  Early climbs (${d.early_climbs}): ${d.early_value}, late climbs (${d.late_climbs}): ${d.late_value}`,
          d.drift_pct > 5
            ? `  Climbing cost noticeably more late in the run: late-race hill fatigue.`
            : d.drift_pct < -5
              ? `  Late climbs were cheaper: warmed into the run or paced conservatively early.`
              : `  Climb cost held steady across the run.`,
          "",
        );
      }

      if (structured.climbs.length > 0) {
        lines.push(`Climbs:`);
        for (const c of structured.climbs) {
          lines.push(segmentLine(c));
        }
        lines.push("");
      }

      if (comparison) lines.push(...comparisonLines(comparison));

      if (structured.descents.length > 0) {
        lines.push(`Descents:`);
        for (const d of structured.descents) {
          const cadence =
            d.avg_cadence != null
              ? `, cadence ${d.avg_cadence} ${structured.units.cadence_label}`
              : "";
          lines.push(`${segmentLine(d)}${cadence}`);
        }
        lines.push("");
      }

      for (const warning of structured.warnings) {
        lines.push(`Warning: ${warning}`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: structured,
      };
    } catch (error) {
      if (error instanceof HillAnalysisError) {
        noteToolFailure(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ ${error.message}${indoor ? " This run is indoors (intervals.icu's trainer flag), so it has no elevation data." : ""}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: toolErrorText(error, {
              context: `compute hill analysis for activity ${id}`,
              notFound: `Activity ${id} was not found.`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
