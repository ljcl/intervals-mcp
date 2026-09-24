import { z } from "zod";
import {
  type AerobicAnalysis,
  AerobicAnalysisError,
  type AerobicStreams,
  computeAerobicAnalysis,
  interpretDecoupling,
} from "../aerobicAnalysis";
import { getActivity, getSportSettings } from "../intervalsClient";
import {
  IntervalsStreamsUnavailableError,
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
Computes aerobic decoupling and efficiency metrics for one intervals.icu activity, preferring intervals.icu's own computed values and falling back to computing them from streams.

Metrics:
- Aerobic decoupling: % drift of the output:HR ratio between the first and second half of the MOVING portion of the activity. Positive = the second half cost more heartbeats per unit of output (aerobic fatigue); negative = warmed into the effort.
- Efficiency factor (EF): normalized output per heartbeat (m/min per beat on the pace basis, W/beat on the power basis).
- Intensity factor (IF): normalized power / threshold power, power basis only.

Interpretation bands: <+5% excellent, +5-10% moderate, >+10% over capacity for the duration, negative = gradual warm-up or negative split.

Use Cases:
- Judge long-run durability ("did the aerobic system hold up in the back half?")
- Compare the same steady route over time as fitness changes
- Sanity-check whether an easy run was actually easy

Parameters:
- id (required): the intervals.icu activity id, exactly as returned by list-activities (e.g. "i189807578")
- basis (optional, default "pace"): "pace" analyses the speed:HR ratio from velocity_smooth; "power" analyses the power:HR ratio from the watts stream
- excludeWarmupMinutes (optional): moving minutes dropped from the start before splitting halves. Defaults to the activity's icu_warmup_time, then the athlete's Run sport-settings warmup_time, then 300 s (5 min)
- thresholdPower (optional, power basis only): threshold power in watts for the intensity factor. Defaults to the athlete's Run sport-settings ftp, then the activity's icu_ftp
- includeBreakdown (optional, default false): when intervals.icu already reports both decoupling and efficiency factor for the activity, streams are not fetched and no half-by-half breakdown is computed unless this is set to true

Notes:
- decoupling_pct and efficiency_factor each carry their own source: "intervals.icu" when the activity already has that field, "computed" from streams otherwise
- On the power basis, when the recording device looks like an Apple Watch, a warning notes that the power stream is Apple's own estimate, not a power meter reading
- Stopped time (traffic lights, café stops) is excluded via the derived moving stream before halves are split
- Works for any endurance activity with HR data, not just runs
`;

const inputSchema = z.object({
  id: intervalsActivityIdInput("The intervals.icu activity id to analyse."),
  basis: z
    .enum(["pace", "power"])
    .default("pace")
    .describe(
      'Output basis: "pace" (default) uses velocity_smooth; "power" uses the watts stream.',
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
      "Compute the half-by-half breakdown from streams even when intervals.icu already reports both decoupling and efficiency factor for the activity.",
    ),
});

type GetAerobicAnalysisInput = z.infer<typeof inputSchema>;

const STREAM_TYPES = ["time", "heartrate", "velocity_smooth", "watts"] as const;

const round = (value: number, dp = 2) =>
  Math.round(value * 10 ** dp) / 10 ** dp;
const toMinutes = (seconds: number) => Math.round(seconds / 60);
const signed = (value: number) =>
  `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
/** Bare `m:ss`, no unit suffix; the structured field name (`*_min_per_km`)
 * carries the unit, `formatPaceSeconds` is the one home for the rendering. */
const paceMinPerKm = (metersPerSecond: number) =>
  metersPerSecond > 0 ? formatPaceSeconds(1000 / metersPerSecond) : null;

function halfOut(half: AerobicAnalysis["firstHalf"], basis: "pace" | "power") {
  return {
    avg_output: round(half.avgOutput),
    avg_pace_min_per_km: basis === "pace" ? paceMinPerKm(half.avgOutput) : null,
    avg_hr: round(half.avgHeartrate, 0),
    output_per_beat: round(half.ratio * (basis === "pace" ? 60 : 1), 3),
    minutes: toMinutes(half.seconds),
  };
}

export const getAerobicAnalysisTool = {
  name,
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: AerobicAnalysisOutputSchema,
  execute: async (
    {
      id,
      basis,
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
      const decouplingSource: "intervals.icu" | "computed" =
        decouplingFromApi != null ? "intervals.icu" : "computed";
      const efficiencySource: "intervals.icu" | "computed" =
        efficiencyFromApi != null ? "intervals.icu" : "computed";
      const needsStreams =
        decouplingSource === "computed" ||
        efficiencySource === "computed" ||
        includeBreakdown;

      const resolvedThresholdPower =
        basis === "power"
          ? (thresholdPower ?? sportSettings?.ftp ?? activity.icu_ftp ?? null)
          : null;
      const resolvedWarmupSeconds =
        excludeWarmupMinutes != null
          ? excludeWarmupMinutes * 60
          : (activity.icu_warmup_time ?? sportSettings?.warmup_time ?? 300);

      const extraWarnings: string[] = [];
      if (basis === "power" && resolvedThresholdPower == null) {
        extraWarnings.push(
          "No threshold power is set on the athlete's Run sport settings or the activity; intensity factor cannot be computed.",
        );
      }
      const isAppleWatch = (activity.device_name ?? "").startsWith("Watch");
      if (basis === "power" && isAppleWatch) {
        extraWarnings.push(
          `Recording device "${activity.device_name}" looks like an Apple Watch; power is Apple's own estimate, not a power meter reading.`,
        );
      }

      let analysis: AerobicAnalysis | null = null;

      if (needsStreams) {
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

        progress("Computing aerobic analysis", { important: true });
        const streamsForAnalysis: AerobicStreams = {
          time: streams.time,
          heartrate: streams.heartrate,
          watts: basis === "power" ? streams.watts : undefined,
          velocity_smooth:
            basis === "pace" ? streams.velocity_smooth : undefined,
          moving: streams.moving,
        };
        analysis = computeAerobicAnalysis(streamsForAnalysis, {
          excludeWarmupSeconds: resolvedWarmupSeconds,
          thresholdPower: resolvedThresholdPower,
        });
      }

      const decouplingPct =
        decouplingSource === "intervals.icu"
          ? (decouplingFromApi as number)
          : (analysis as AerobicAnalysis).decouplingPct;
      const efficiencyFactor =
        efficiencySource === "intervals.icu"
          ? (efficiencyFromApi as number)
          : (analysis as AerobicAnalysis).efficiencyFactor;
      const interpretation = interpretDecoupling(decouplingPct);

      const structured = {
        activity_id: id,
        name: displayName,
        date: activity.start_date_local,
        type,
        basis,
        decoupling_pct: round(decouplingPct, 1),
        decoupling_source: decouplingSource,
        interpretation,
        efficiency_factor: round(efficiencyFactor, 3),
        efficiency_factor_source: efficiencySource,
        intensity_factor:
          analysis?.intensityFactor != null
            ? round(analysis.intensityFactor, 3)
            : null,
        threshold_power_w: resolvedThresholdPower,
        breakdown: analysis
          ? {
              first_half: halfOut(analysis.firstHalf, basis),
              second_half: halfOut(analysis.secondHalf, basis),
              normalized_output: round(analysis.normalizedOutput),
              normalized_pace_min_per_km:
                basis === "pace"
                  ? paceMinPerKm(analysis.normalizedOutput)
                  : null,
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
          efficiency_factor: basis === "pace" ? "m/min per beat" : "W/beat",
        },
        warnings: [...(analysis?.warnings ?? []), ...extraWarnings],
      };
      warnOnSchemaDrift(name, AerobicAnalysisOutputSchema, structured);

      const basisLabel =
        basis === "power" ? "power:HR (Pw:Hr)" : "pace:HR (Pa:Hr)";
      const lines = [
        `Aerobic Analysis: ${structured.name} (${structured.date})`,
        `Basis: ${basisLabel}`,
        "",
        `Decoupling: ${signed(structured.decoupling_pct)}: ${interpretation} [${decouplingSource}]`,
      ];
      if (structured.breakdown) {
        const b = structured.breakdown;
        const outputStr = (h: typeof b.first_half) =>
          basis === "pace" && h.avg_pace_min_per_km
            ? `${h.avg_pace_min_per_km} /km`
            : `${h.avg_output} W`;
        lines.push(
          `  First half:  ${outputStr(b.first_half)} @ ${b.first_half.avg_hr} bpm`,
          `  Second half: ${outputStr(b.second_half)} @ ${b.second_half.avg_hr} bpm`,
          "",
          basis === "power"
            ? `Normalized power: ${b.normalized_output} W`
            : `Normalized pace: ${b.normalized_pace_min_per_km} /km`,
        );
      } else {
        lines.push("");
      }
      lines.push(
        `Efficiency factor: ${structured.efficiency_factor} ${structured.units.efficiency_factor} [${efficiencySource}]`,
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
      } else {
        lines.push(
          "Breakdown not computed (both metrics came from intervals.icu); pass includeBreakdown: true for the half-by-half figures.",
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
              notFound: `Activity with ID ${id} not found.`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
