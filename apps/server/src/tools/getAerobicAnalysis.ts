import { z } from "zod";
import {
  type AerobicAnalysis,
  AerobicAnalysisError,
  type AerobicStreams,
  computeAerobicAnalysis,
  interpretDecoupling,
} from "../aerobicAnalysis";
import { formatSigned } from "../formatters";
import { gradeAdjustedSpeeds } from "../hillAnalysis";
import { getActivity, getSportSettings } from "../intervalsClient";
import {
  IntervalsStreamsUnavailableError,
  type IntervalsStreamType,
  loadIntervalsStreams,
} from "../intervalsStreams";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import { formatPaceSeconds } from "../utils/running";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { intervalsActivityIdInput } from "./_ids";
import { AerobicAnalysisOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-aerobic-analysis";

const description = `
Measures aerobic durability and efficiency for one activity: aerobic
decoupling (the drift in output per heartbeat from the first to the second
half of the moving time), the efficiency factor (metres per minute per beat
on the gap and pace bases, watts per beat on the power basis) and, on the
power basis, the intensity factor. Use it for long steady runs: "did my
aerobic system hold up?" or "was this easy run actually easy?".

To compare two runs' efficiency, use compare-activities; for pacing drift
over km splits, get-split-analysis.

Notes:
- Decoupling under +5% is excellent, +5 to +10% moderate, over +10% beyond
  current capacity for the duration; negative means the second half was
  more efficient.
- The gap basis corrects speed for grade the way get-split-analysis does,
  so an uphill-out, downhill-back course does not read as drift. With no
  elevation data it falls back to raw pace and warns.
- Without basis or includeBreakdown, an activity that carries intervals.icu's
  own decoupling and efficiency factor reports those, and basis is null:
  intervals.icu does not say which basis it used. Otherwise both numbers are
  computed from streams, and intervals.icu's values, if any, are in
  intervals_icu, apart from the computed ones.
- Stopped time (traffic lights, café stops) is excluded before the halves
  are split.
- On the power basis, an Apple Watch power stream is Apple's estimate, not a
  power meter reading; the response warns.
- Works for any endurance activity with heart rate.
`;

const inputSchema = z.object({
  id: intervalsActivityIdInput("The intervals.icu activity id to analyse."),
  basis: z
    .enum(["gap", "pace", "power"])
    .optional()
    .describe(
      'Output basis, computed from streams: "gap" is grade-adjusted speed (hills do not count as drift), "pace" raw velocity_smooth, "power" the watts stream. Omit it to take intervals.icu\'s own values when the activity has both, else "gap".',
    ),
  excludeWarmupMinutes: z
    .number()
    .min(0)
    .max(120)
    .optional()
    .describe(
      "Moving minutes to drop from the start before splitting halves. Defaults to the activity's icu_warmup_time, then the athlete's Run sport-settings warmup_time, then 5 minutes.",
    ),
  thresholdPower: z
    .number()
    .positive()
    .optional()
    .describe(
      "Threshold power (FTP) in watts for the intensity factor, power basis only. Defaults to the athlete's Run sport-settings ftp, then the activity's icu_ftp.",
    ),
  includeBreakdown: z
    .boolean()
    .default(false)
    .describe(
      "Compute from streams (on the gap basis unless basis is set) even when intervals.icu already reports both decoupling and efficiency factor; its values then stay in intervals_icu.",
    ),
});

type GetAerobicAnalysisInput = z.infer<typeof inputSchema>;
type Basis = "gap" | "pace" | "power";

const BASE_STREAM_TYPES: IntervalsStreamType[] = [
  "time",
  "heartrate",
  "velocity_smooth",
  "watts",
];
/** The gap basis also needs what grade is computed from. */
const GRADE_STREAM_TYPES: IntervalsStreamType[] = [
  "distance",
  "altitude",
  "grade_smooth",
];

const BASIS_LABELS: Record<Basis, string> = {
  gap: "grade-adjusted pace:HR (GAP:Hr)",
  pace: "pace:HR (Pa:Hr)",
  power: "power:HR (Pw:Hr)",
};

const EF_UNITS: Record<Basis, string> = {
  gap: "m/min per beat (grade-adjusted)",
  pace: "m/min per beat",
  power: "W/beat",
};

const round = (value: number, dp = 2) =>
  Math.round(value * 10 ** dp) / 10 ** dp;
const toMinutes = (seconds: number) => Math.round(seconds / 60);
/** Bare `m:ss`, no unit suffix; the structured field name (`*_min_per_km`)
 * carries the unit, `formatPaceSeconds` is the one home for the rendering. */
const paceMinPerKm = (metersPerSecond: number) =>
  metersPerSecond > 0 ? formatPaceSeconds(1000 / metersPerSecond) : null;

function halfOut(half: AerobicAnalysis["firstHalf"], basis: Basis) {
  const isSpeed = basis !== "power";
  return {
    avg_output: round(half.avgOutput),
    avg_pace_min_per_km: isSpeed ? paceMinPerKm(half.avgOutput) : null,
    avg_hr: round(half.avgHeartrate, 0),
    output_per_beat: round(half.ratio * (isSpeed ? 60 : 1), 3),
    minutes: toMinutes(half.seconds),
  };
}

export const getAerobicAnalysisTool = {
  name,
  title: "Aerobic analysis",
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: AerobicAnalysisOutputSchema,
  execute: async (
    {
      id,
      basis: requestedBasis,
      excludeWarmupMinutes,
      thresholdPower,
      includeBreakdown,
    }: GetAerobicAnalysisInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    try {
      progress(`Fetching activity ${id}`);
      const [activity, sportSettings] = await Promise.all([
        getActivity(apiKey, id),
        getSportSettings(apiKey, "Run").catch(() => null),
      ]);
      const type = activity.type ?? "Workout";
      const displayName = activity.name ?? type;

      const decouplingFromApi = activity.decoupling ?? null;
      const efficiencyFromApi = activity.icu_efficiency_factor ?? null;
      // intervals.icu's own pair is the headline only when the caller asked
      // for no basis and no breakdown: it never says which basis it used,
      // so it cannot answer a request for a specific one (#74).
      const useApiValues =
        requestedBasis == null &&
        !includeBreakdown &&
        decouplingFromApi != null &&
        efficiencyFromApi != null;

      let basis: Basis | null = useApiValues ? null : (requestedBasis ?? "gap");
      // Only the gap basis can fall back (to pace), so power is settled here.
      const resolvedThresholdPower =
        basis === "power"
          ? (thresholdPower ?? sportSettings?.ftp ?? activity.icu_ftp ?? null)
          : null;
      const warnings: string[] = [];
      let analysis: AerobicAnalysis | null = null;

      if (basis != null) {
        const streamTypes =
          basis === "gap"
            ? [...BASE_STREAM_TYPES, ...GRADE_STREAM_TYPES]
            : BASE_STREAM_TYPES;
        progress(`Fetching streams for "${displayName}"`);
        let streams: Awaited<ReturnType<typeof loadIntervalsStreams>>;
        try {
          streams = await loadIntervalsStreams(apiKey, id, streamTypes);
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

        let speed = streams.velocity_smooth;
        if (basis === "gap") {
          const gap = gradeAdjustedSpeeds({
            time: streams.time,
            distance: streams.distance ?? [],
            altitude: streams.altitude,
            grade_smooth: streams.grade_smooth,
            velocity_smooth: streams.velocity_smooth,
          });
          if (gap) {
            speed = gap.speeds;
            if (gap.warning) warnings.push(gap.warning);
          } else {
            basis = "pace";
            warnings.push(
              "No elevation data, so the grade-adjusted basis is unavailable: this uses raw pace, and hills count as drift.",
            );
          }
        }

        progress("Computing aerobic analysis", { important: true });
        const streamsForAnalysis: AerobicStreams = {
          time: streams.time,
          heartrate: streams.heartrate,
          watts: basis === "power" ? streams.watts : undefined,
          velocity_smooth: basis === "power" ? undefined : speed,
          moving: streams.moving,
        };
        const resolvedWarmupSeconds =
          excludeWarmupMinutes != null
            ? excludeWarmupMinutes * 60
            : (activity.icu_warmup_time ?? sportSettings?.warmup_time ?? 300);
        analysis = computeAerobicAnalysis(streamsForAnalysis, {
          excludeWarmupSeconds: resolvedWarmupSeconds,
          thresholdPower: resolvedThresholdPower,
        });
      }

      if (basis === "power" && resolvedThresholdPower == null) {
        warnings.push(
          "No threshold power is set on the athlete's Run sport settings or the activity; intensity factor cannot be computed.",
        );
      }
      const isAppleWatch = (activity.device_name ?? "").startsWith("Watch");
      if (basis === "power" && isAppleWatch) {
        warnings.push(
          `Recording device "${activity.device_name}" looks like an Apple Watch; power is Apple's own estimate, not a power meter reading.`,
        );
      }

      const source = analysis ? ("computed" as const) : "intervals.icu";
      const decouplingPct = analysis
        ? analysis.decouplingPct
        : (decouplingFromApi as number);
      const efficiencyFactor = analysis
        ? analysis.efficiencyFactor
        : (efficiencyFromApi as number);
      const interpretation = interpretDecoupling(decouplingPct);

      const structured = {
        activity_id: id,
        name: displayName,
        date: activity.start_date_local,
        type,
        basis,
        decoupling_pct: round(decouplingPct, 1),
        decoupling_source: source,
        interpretation,
        efficiency_factor: round(efficiencyFactor, 3),
        efficiency_factor_source: source,
        intensity_factor:
          analysis?.intensityFactor != null
            ? round(analysis.intensityFactor, 3)
            : null,
        threshold_power_w: resolvedThresholdPower,
        intervals_icu:
          decouplingFromApi != null || efficiencyFromApi != null
            ? {
                decoupling_pct:
                  decouplingFromApi != null
                    ? round(decouplingFromApi, 1)
                    : null,
                efficiency_factor:
                  efficiencyFromApi != null
                    ? round(efficiencyFromApi, 3)
                    : null,
              }
            : null,
        breakdown:
          analysis && basis
            ? {
                first_half: halfOut(analysis.firstHalf, basis),
                second_half: halfOut(analysis.secondHalf, basis),
                normalized_output: round(analysis.normalizedOutput),
                normalized_pace_min_per_km:
                  basis === "power"
                    ? null
                    : paceMinPerKm(analysis.normalizedOutput),
                moving_minutes: toMinutes(analysis.movingSeconds),
                excluded_stopped_minutes: toMinutes(
                  analysis.excludedStoppedSeconds,
                ),
                excluded_warmup_minutes: toMinutes(
                  analysis.excludedWarmupSeconds,
                ),
              }
            : null,
        units: {
          pace: "min/km" as const,
          power: "W" as const,
          efficiency_factor: basis ? EF_UNITS[basis] : "not reported",
        },
        warnings: [...(analysis?.warnings ?? []), ...warnings],
      };
      warnOnSchemaDrift(name, AerobicAnalysisOutputSchema, structured);

      const lines = [
        `Aerobic Analysis: ${structured.name} (${structured.date})`,
        basis
          ? `Basis: ${BASIS_LABELS[basis]}`
          : "Basis: not reported (intervals.icu's own values)",
        "",
        `Decoupling: ${formatSigned(structured.decoupling_pct, 1)}%: ${interpretation} [${source}]`,
      ];
      if (structured.breakdown) {
        const b = structured.breakdown;
        const outputStr = (h: typeof b.first_half) =>
          h.avg_pace_min_per_km
            ? `${h.avg_pace_min_per_km} /km`
            : `${h.avg_output} W`;
        lines.push(
          `  First half:  ${outputStr(b.first_half)} @ ${b.first_half.avg_hr} bpm`,
          `  Second half: ${outputStr(b.second_half)} @ ${b.second_half.avg_hr} bpm`,
          "",
          basis === "power"
            ? `Normalized power: ${b.normalized_output} W`
            : `Normalized ${basis === "gap" ? "grade-adjusted " : ""}pace: ${b.normalized_pace_min_per_km} /km`,
        );
      } else {
        lines.push("");
      }
      lines.push(
        basis
          ? `Efficiency factor: ${structured.efficiency_factor} ${structured.units.efficiency_factor} [${source}]`
          : `Efficiency factor: ${structured.efficiency_factor} [intervals.icu; unit not reported]`,
      );
      if (structured.intensity_factor != null) {
        lines.push(
          `Intensity factor: ${structured.intensity_factor} (threshold ${structured.threshold_power_w} W)`,
        );
      }
      if (structured.breakdown) {
        const b = structured.breakdown;
        const exclusions = [
          b.excluded_stopped_minutes > 0
            ? `${b.excluded_stopped_minutes} min stopped`
            : null,
          b.excluded_warmup_minutes > 0
            ? `${b.excluded_warmup_minutes} min warm-up`
            : null,
        ].filter(Boolean);
        lines.push(
          `Analysed ${b.moving_minutes} min of moving time${exclusions.length > 0 ? ` (excluded ${exclusions.join(", ")})` : ""}.`,
        );
        const icu = structured.intervals_icu;
        if (icu) {
          const parts = [
            icu.decoupling_pct != null
              ? `decoupling ${formatSigned(icu.decoupling_pct, 1)}%`
              : null,
            icu.efficiency_factor != null
              ? `efficiency factor ${icu.efficiency_factor}`
              : null,
          ].filter(Boolean);
          lines.push(
            `intervals.icu's own values (basis and unit not reported, so not comparable with the above): ${parts.join(", ")}.`,
          );
        }
      } else {
        lines.push(
          "Breakdown not computed (both values came from intervals.icu); pass a basis or includeBreakdown: true to compute them from streams.",
        );
      }
      lines.push(
        "Bands: <+5% excellent, +5-10% moderate, >+10% over capacity; negative = warmed into it.",
      );
      for (const warning of structured.warnings) {
        lines.push(`Warning: ${warning}`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: structured,
      };
    } catch (error) {
      if (error instanceof AerobicAnalysisError) {
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
              context: `compute aerobic analysis for activity ${id}`,
              notFound: `Activity ${id} was not found.`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
