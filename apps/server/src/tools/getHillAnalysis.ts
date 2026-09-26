import { z } from "zod";
import {
  computeHillAnalysis,
  HillAnalysisError,
  type HillSegment,
  type HillStreams,
} from "../hillAnalysis";
import { getActivity } from "../intervalsClient";
import {
  IntervalsStreamsUnavailableError,
  loadIntervalsStreams,
} from "../intervalsStreams";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import {
  cadenceSpm,
  formatPaceSeconds,
  isStepCadenceActivity,
} from "../utils/running";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
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
- Grade comes from intervals.icu's smoothed grade stream, else from altitude
  over about 30 m; grade_source says which.
- Works without power, and without HR (the drift then uses grade-adjusted
  pace only).
- Stopped time is excluded from segment pace.
- An activity with no recorded streams (a manual entry) returns an error.
`;

const inputSchema = z.object({
  id: intervalsActivityIdInput("The intervals.icu activity id."),
});

type GetHillAnalysisInput = z.infer<typeof inputSchema>;

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

function segmentLine(s: ReturnType<typeof segmentOut>): string {
  const parts = [
    `km ${s.start_km}-${s.end_km}`,
    `${s.length_m} m @ ${s.avg_grade_pct}%`,
    `${s.elevation_change_m >= 0 ? "+" : ""}${s.elevation_change_m} m`,
    s.pace_min_per_km ? `pace ${s.pace_min_per_km} /km` : null,
    s.gap_pace_min_per_km ? `GAP ${s.gap_pace_min_per_km} /km` : null,
    s.avg_hr != null ? `${s.avg_hr} bpm` : null,
    s.avg_watts != null ? `${s.avg_watts} W` : null,
  ].filter(Boolean);
  return `  ${parts.join(", ")}`;
}

export const getHillAnalysisTool = {
  name,
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: HillAnalysisOutputSchema,
  execute: async (
    { id }: GetHillAnalysisInput,
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
                text: `❌ No data streams are recorded for "${displayName}" (activity ${id}): this looks like an activity with no GPS streams (e.g. Pilates, or a manual entry), so hill analysis has nothing to work with.`,
              },
            ],
            isError: true,
          };
        }
        throw error;
      }

      progress("Computing hill analysis", { important: true });
      const hillStreams: HillStreams = {
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
      const analysis = computeHillAnalysis(hillStreams);

      const structured = {
        activity_id: id,
        name: displayName,
        date: activity.start_date_local,
        type,
        grade_source: analysis.gradeSource,
        // GAP throughout this response is locally modelled from grade
        // (Minetti metabolic-cost curve, hillAnalysis.ts's gapFactor), not
        // intervals.icu's own gap field (see get-activity/compare-activities/
        // get-activity-laps' gap_source: "intervals.icu").
        gap_source: "model" as const,
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
        units: {
          distance: "km" as const,
          length: "m" as const,
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
      warnOnSchemaDrift(name, HillAnalysisOutputSchema, structured);

      const lines = [
        `Hill Analysis: ${structured.name} (${structured.date})`,
        `Grade source: ${structured.grade_source}`,
        `${structured.totals.climb_count} climbs (${structured.totals.climb_distance_m} m, +${structured.totals.climb_gain_m} m), ${structured.totals.descent_count} descents`,
        "",
      ];

      if (structured.drift) {
        const d = structured.drift;
        const basisLabel =
          d.basis === "hr_per_gap"
            ? "HR per grade-adjusted speed"
            : "grade-adjusted pace (no HR)";
        const sign = d.drift_pct >= 0 ? "+" : "";
        lines.push(
          `Late-vs-early climb drift: ${sign}${d.drift_pct}% (${basisLabel})`,
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

      if (structured.descents.length > 0) {
        const cadenceUnit = isStepCadenceActivity(type) ? "spm" : "rpm";
        lines.push(`Descents:`);
        for (const d of structured.descents) {
          const cadence =
            d.avg_cadence != null
              ? `, cadence ${d.avg_cadence} ${cadenceUnit}`
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
