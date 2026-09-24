import { z } from "zod";
import { formatDuration } from "../formatters";
import {
  computeIntervalAnalysis,
  IntervalAnalysisError,
  type IntervalLap,
  type IntervalStreams,
} from "../intervalAnalysis";
import { cadenceUnit } from "../intervalLaps";
import { getActivity, type IntervalsInterval } from "../intervalsClient";
import {
  IntervalsStreamsUnavailableError,
  loadIntervalsStreams,
} from "../intervalsStreams";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import { cadenceSpm, formatPaceSeconds } from "../utils/running";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { intervalsActivityIdInput } from "./_ids";
import { IntervalAnalysisOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-interval-analysis";

const description = `
Detects and analyses interval structure in one intervals.icu activity, with urban-stop-aware rest classification.

Naive rest-based interval detection false-positives on urban runs: traffic-light
stops read as recovery intervals. This tool classifies every stopped segment
(from the derived moving stream) before trusting it:
- Stop under 60 s with no fast effort before it → traffic light, excluded
- Stop up to 3 min after a fast effort → genuine interval recovery
- Stop over 5 min → café/regroup/kit stop, noted but excluded
- Anything else → unclassified, excluded (lowers confidence)

Work reps are reconstructed between recoveries (easy running is merged straight
through traffic lights) and reported with per-rep pace, HR, cadence, and power.
When the activity carries clean structured intervals.icu laps (icu_intervals)
those are preferred; they also catch jog-recovery sessions, which never stop
moving. Corrupted auto-laps (rain/sweat) fail a consistency check and fall
back to streams.

The response includes:
- A verdict (interval session or not) with confidence and a reasoning audit
  trail ("6 rests detected: 4 traffic lights, ...")
- Fade detection across reps (e.g. "rep 5 was 3% slower at 4 bpm higher HR than rep 1")
- An HR-distribution tiebreaker for "was this a workout at all"

Parameters:
- id (required): the intervals.icu activity id, exactly as returned by list-activities (e.g. "i189807578")

Notes:
- Stream-based detection only sees boundaries where you actually stopped;
  jog-recovery workouts need laps (intervals.icu's own WORK/RECOVERY split)
- Classification thresholds are documented above and deliberately conservative
`;

const inputSchema = z.object({
  id: intervalsActivityIdInput("The intervals.icu activity id to analyse."),
});

type GetIntervalAnalysisInput = z.infer<typeof inputSchema>;

const STREAM_TYPES = [
  "time",
  "distance",
  "heartrate",
  "velocity_smooth",
  "cadence",
  "watts",
] as const;

const formatPace = (secPerKm: number | null) =>
  secPerKm == null ? null : `${formatPaceSeconds(secPerKm)} /km`;

/**
 * Thin adapter from one `icu_intervals` entry to the module's lap input.
 * Deliberately reads raw fields directly (distance, moving_time,
 * average_speed, average_cadence) rather than going through
 * `mapIntervalsToLaps`: that mapper's `LapEntry.average_cadence` is already
 * doubled to steps/min for a step-cadence type (display-ready), while
 * `intervalAnalysis.ts` averages/fades cadence in its raw per-leg form and
 * expects the controller to convert once for display (`cadenceSpm` below,
 * matching `getHillAnalysis.ts`'s convention). Reusing the doubled value
 * here would double-convert it for the lap path only.
 */
function toIntervalLap(
  interval: IntervalsInterval,
  index: number,
): IntervalLap {
  return {
    lapIndex: index + 1,
    distanceM: interval.distance ?? 0,
    movingTimeS: interval.moving_time ?? 0,
    avgSpeedMs: interval.average_speed ?? null,
    avgHr: interval.average_heartrate ?? null,
    avgCadence: interval.average_cadence ?? null,
    avgWatts: interval.average_watts ?? null,
  };
}

export const getIntervalAnalysisTool = {
  name,
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: IntervalAnalysisOutputSchema,
  execute: async (
    { id }: GetIntervalAnalysisInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    try {
      progress(`Fetching activity ${id}`);
      const activity = await getActivity(apiKey, id, { intervals: true });
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
                text: `❌ No data streams are recorded for "${displayName}" (activity ${id}): manual activities have no recorded samples to analyse.`,
              },
            ],
            isError: true,
          };
        }
        throw error;
      }

      progress("Computing interval analysis", { important: true });
      const intervalStreams: IntervalStreams = {
        time: streams.time,
        distance: streams.distance ?? [],
        moving: streams.moving,
        heartrate: streams.heartrate,
        cadence: streams.cadence,
        watts: streams.watts,
      };
      const laps = (activity.icu_intervals ?? []).map(toIntervalLap);
      const analysis = computeIntervalAnalysis(intervalStreams, laps);
      const cadenceUnitLabel = cadenceUnit(type);

      const structured = {
        activity_id: id,
        name: displayName,
        date: activity.start_date_local,
        type,
        is_intervals: analysis.isIntervals,
        source: analysis.source,
        confidence: analysis.confidence,
        reasoning: analysis.reasoning,
        reps: analysis.reps.map((rep) => ({
          index: rep.index,
          start_km: rep.startKm,
          distance_m: rep.distanceM,
          moving_time_s: rep.movingTimeS,
          moving_time_formatted: formatDuration(rep.movingTimeS),
          pace_sec_per_km: rep.paceSecPerKm,
          pace_formatted: formatPace(rep.paceSecPerKm),
          avg_hr: rep.avgHr,
          avg_cadence: cadenceSpm(rep.avgCadence, type),
          avg_watts: rep.avgWatts,
        })),
        rests: analysis.rests.map((rest) => ({
          start_time_s: rest.startTimeS,
          at_km: rest.atKm,
          duration_s: rest.durationS,
          kind: rest.kind,
          reason: rest.reason,
        })),
        fade: analysis.fade
          ? {
              pace_drift_pct: analysis.fade.paceDriftPct,
              hr_drift_bpm: analysis.fade.hrDriftBpm,
              cadence_drift_pct: analysis.fade.cadenceDriftPct,
              summary: analysis.fade.summary,
            }
          : null,
        hr_signal: analysis.hrSignal
          ? {
              max_hr: analysis.hrSignal.maxHr,
              high_intensity_share_pct:
                Math.round(analysis.hrSignal.highIntensityShare * 1000) / 10,
              assessment: analysis.hrSignal.assessment,
            }
          : null,
        units: {
          distance: "km" as const,
          pace: "min/km" as const,
          time: "s" as const,
          hr: "bpm" as const,
          cadence: cadenceUnitLabel,
          power: "W" as const,
        },
        warnings: analysis.warnings,
      };
      warnOnSchemaDrift(name, IntervalAnalysisOutputSchema, structured);

      const lines = [
        `Interval Analysis: ${structured.name} (${structured.date})`,
        structured.is_intervals
          ? `Verdict: interval session — ${structured.reps.length} work reps (confidence: ${structured.confidence})`
          : `Verdict: not an interval session (confidence: ${structured.confidence})`,
        `Reasoning: ${structured.reasoning}`,
        "",
      ];

      if (structured.reps.length > 0) {
        lines.push("Reps:");
        for (const rep of structured.reps) {
          const parts = [
            `${rep.distance_m} m in ${rep.moving_time_formatted}`,
            rep.pace_formatted,
            rep.avg_hr != null ? `${rep.avg_hr} bpm` : null,
            rep.avg_cadence != null
              ? `${rep.avg_cadence} ${cadenceUnitLabel}`
              : null,
            rep.avg_watts != null ? `${rep.avg_watts} W` : null,
          ].filter(Boolean);
          lines.push(`  ${rep.index}. km ${rep.start_km}: ${parts.join(", ")}`);
        }
        lines.push("");
      }

      if (structured.fade) {
        lines.push(`Fade: ${structured.fade.summary}`, "");
      }

      if (structured.rests.length > 0) {
        lines.push("Rests:");
        for (const rest of structured.rests) {
          lines.push(`  km ${rest.at_km}: ${rest.reason}`);
        }
        lines.push("");
      }

      if (structured.hr_signal) {
        lines.push(
          `HR signal: ${structured.hr_signal.assessment} (${structured.hr_signal.high_intensity_share_pct}% of moving time at ≥88% of max ${structured.hr_signal.max_hr} bpm)`,
        );
      }

      for (const warning of structured.warnings) {
        lines.push(`Warning: ${warning}`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: structured,
      };
    } catch (error) {
      if (error instanceof IntervalAnalysisError) {
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
              context: `compute interval analysis for activity ${id}`,
              notFound: `Activity with ID ${id} not found.`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
