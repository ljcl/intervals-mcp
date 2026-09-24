import { z } from "zod";
import { formatDuration, round } from "../formatters";
import { getActivity, type IntervalsActivity } from "../intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import {
  cadenceSpm,
  formatPaceSeconds,
  gapPace,
  isPaceActivity,
  isRunningActivity,
  isStepCadenceActivity,
  paceFromDistanceTime,
} from "../utils/running";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { intervalsActivityIdInput } from "./_ids";
import { CompareActivitiesOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "compare-activities";

const description = `
Compares two intervals.icu running activities side-by-side.

This tool provides:
- Key metrics for both activities (pace, HR, cadence, load, running dynamics)
- Calculated differences (pace, heart rate, cadence, elevation)
- Efficiency analysis comparing pace relative to heart rate

Use Cases:
- Compare the same route on different days
- Track fitness progress over time
- Analyze performance in different conditions
- Compare race efforts

Parameters:
- activityId1 (required): First activity ID (typically the baseline/older activity)
- activityId2 (required): Second activity ID (typically the comparison/newer activity)

Notes:
- Both activities should be running activities for meaningful comparison
- Efficiency analysis requires heart rate data in both activities
- Positive differences mean activity 2 is higher/longer
- Negative pace difference means activity 2 is faster
`;

const inputSchema = z.object({
  activityId1: intervalsActivityIdInput(
    "First activity ID (baseline/older activity)",
  ),
  activityId2: intervalsActivityIdInput(
    "Second activity ID (comparison/newer activity)",
  ),
});

type CompareActivitiesInput = z.infer<typeof inputSchema>;

interface RunningDynamicsAvg {
  stance_time_ms: number | null;
  vertical_oscillation_mm: number | null;
  vertical_ratio_pct: number | null;
  step_length_mm: number | null;
  stride_m: number | null;
}

interface ActivitySummary {
  id: string;
  name: string;
  date: string;
  type: string;
  distance_km: number;
  moving_time: number;
  pace_min_per_km: string | null;
  gap_min_per_km: string | null;
  average_hr: number | null;
  max_hr: number | null;
  cadence_spm: number | null;
  elevation_gain_m: number;
  load: number | null;
  decoupling_pct: number | null;
  efficiency_factor: number | null;
  running_dynamics: RunningDynamicsAvg | null;
}

/** Cadence in steps/min, `null` for a non-step-cadence type (see {@link isStepCadenceActivity}). */
function activityCadenceSpm(
  rawCadence: number | null | undefined,
  type: string,
): number | null {
  if (!isStepCadenceActivity(type)) return null;
  const spm = cadenceSpm(rawCadence, type);
  return spm == null ? null : Math.round(spm);
}

/** Same shape as `get-activity`'s running dynamics: averages only, present for step-cadence types with device support. */
function buildRunningDynamics(
  a: IntervalsActivity,
  type: string,
): RunningDynamicsAvg | null {
  if (!isStepCadenceActivity(type) || a.average_stance_time == null)
    return null;
  return {
    stance_time_ms: round(a.average_stance_time),
    vertical_oscillation_mm:
      a.average_vertical_oscillation == null
        ? null
        : round(a.average_vertical_oscillation),
    vertical_ratio_pct:
      a.average_vertical_ratio == null
        ? null
        : round(a.average_vertical_ratio, 1),
    step_length_mm:
      a.average_step_length == null ? null : round(a.average_step_length),
    stride_m: a.average_stride == null ? null : round(a.average_stride, 2),
  };
}

function extractActivitySummary(activity: IntervalsActivity): ActivitySummary {
  const type = activity.type ?? "Workout";

  return {
    id: activity.id,
    name: activity.name ?? type,
    date:
      activity.start_date_local?.split("T")[0] ??
      activity.start_date?.split("T")[0] ??
      "",
    type,
    distance_km: round((activity.distance ?? 0) / 1000, 2),
    moving_time: activity.moving_time ?? 0,
    pace_min_per_km: isPaceActivity(type)
      ? paceFromDistanceTime(activity.distance, activity.moving_time)
      : null,
    gap_min_per_km: gapPace(activity.gap, type),
    average_hr: activity.average_heartrate ?? null,
    max_hr: activity.max_heartrate ?? null,
    cadence_spm: activityCadenceSpm(activity.average_cadence, type),
    elevation_gain_m: round(activity.total_elevation_gain ?? 0),
    load: activity.icu_training_load ?? null,
    decoupling_pct:
      activity.decoupling == null ? null : round(activity.decoupling, 1),
    efficiency_factor:
      activity.icu_efficiency_factor == null
        ? null
        : round(activity.icu_efficiency_factor, 2),
    running_dynamics: buildRunningDynamics(activity, type),
  };
}

/** Signed `m:ss` string for a pace delta in seconds/km, e.g. `-0:12` or `+0:05`. `0` renders with no sign. */
function signedPaceDelta(seconds: number): string {
  const sign = seconds < 0 ? "-" : seconds > 0 ? "+" : "";
  return `${sign}${formatPaceSeconds(Math.abs(seconds))}`;
}

/** Precise seconds-per-km from raw distance (m) and moving time (s), not from any rounded/formatted intermediate. */
function rawPaceSecondsPerKm(
  distanceM: number | null | undefined,
  movingTimeS: number | null | undefined,
): number | null {
  if (!distanceM || distanceM <= 0 || !movingTimeS || movingTimeS <= 0)
    return null;
  return (movingTimeS / distanceM) * 1000;
}

export type ComparisonResult = z.infer<typeof CompareActivitiesOutputSchema>;

/**
 * Pure aggregate comparison of two intervals.icu activities: per-side
 * summaries, activity2 − activity1 differences, and the pace/HR efficiency
 * analysis. Differences are derived from each activity's raw distance (m)
 * and moving time (s)/heart rate/cadence/elevation, never from the rounded
 * or formatted per-side fields, so a pace delta reflects the true difference
 * rather than compounding two independent roundings.
 *
 * Shared by this tool's text/structured output and the app-only
 * `get-compare-activities-data` feed behind `view-compare-activities`.
 */
export function buildComparison(
  activity1: IntervalsActivity,
  activity2: IntervalsActivity,
): ComparisonResult {
  const type1 = activity1.type ?? "Workout";
  const type2 = activity2.type ?? "Workout";

  const warnings: string[] = [];
  if (!isRunningActivity(type1)) {
    warnings.push(
      `Activity 1 (${activity1.name ?? type1}) is not a running activity (${type1})`,
    );
  }
  if (!isRunningActivity(type2)) {
    warnings.push(
      `Activity 2 (${activity2.name ?? type2}) is not a running activity (${type2})`,
    );
  }

  const summary1 = extractActivitySummary(activity1);
  const summary2 = extractActivitySummary(activity2);

  const distanceDiff = round(summary2.distance_km - summary1.distance_km, 2);

  const paceSec1 = isPaceActivity(type1)
    ? rawPaceSecondsPerKm(activity1.distance, activity1.moving_time)
    : null;
  const paceSec2 = isPaceActivity(type2)
    ? rawPaceSecondsPerKm(activity2.distance, activity2.moving_time)
    : null;

  let paceDiff: {
    seconds_per_km: number;
    min_per_km: string;
    interpretation: string;
  } | null = null;
  if (paceSec1 != null && paceSec2 != null) {
    const diffSeconds = Math.round(paceSec2 - paceSec1);
    paceDiff = {
      seconds_per_km: diffSeconds,
      min_per_km: signedPaceDelta(diffSeconds),
      interpretation:
        diffSeconds < -5 ? "faster" : diffSeconds > 5 ? "slower" : "same",
    };
  }

  const hrDiff =
    summary1.average_hr != null && summary2.average_hr != null
      ? Math.round(summary2.average_hr - summary1.average_hr)
      : null;

  const cadenceDiff =
    summary1.cadence_spm != null && summary2.cadence_spm != null
      ? Math.round(summary2.cadence_spm - summary1.cadence_spm)
      : null;

  const elevationDiff = Math.round(
    summary2.elevation_gain_m - summary1.elevation_gain_m,
  );

  // Efficiency: pace-relative-to-HR (lower is better), independent of
  // intervals.icu's own icu_efficiency_factor field carried on each side.
  let efficiency: ComparisonResult["efficiency"] = null;
  if (
    paceSec1 != null &&
    paceSec2 != null &&
    summary1.average_hr != null &&
    summary2.average_hr != null
  ) {
    const eff1 = (paceSec1 / 60 / summary1.average_hr) * 100;
    const eff2 = (paceSec2 / 60 / summary2.average_hr) * 100;
    const changePercent = Math.round(((eff2 - eff1) / eff1) * 1000) / 10;

    efficiency = {
      activity_1: Math.round(eff1 * 1000) / 1000,
      activity_2: Math.round(eff2 * 1000) / 1000,
      change_percent: changePercent,
      interpretation:
        changePercent < -3
          ? "improved"
          : changePercent > 3
            ? "declined"
            : "unchanged",
      note: "Lower efficiency number = faster pace at same heart rate = better fitness",
    };
  }

  return {
    units: {
      distance: "km",
      pace: "min/km",
      time: "s",
      hr: "bpm",
      elevation: "m",
      cadence: "spm",
    },
    activity_1: summary1,
    activity_2: summary2,
    differences: {
      distance_km: distanceDiff,
      pace: paceDiff,
      avg_hr: hrDiff,
      cadence_spm: cadenceDiff,
      elevation_gain_m: elevationDiff,
    },
    efficiency,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export const compareActivitiesTool = {
  name,
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: CompareActivitiesOutputSchema,
  execute: async (
    { activityId1, activityId2 }: CompareActivitiesInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    try {
      progress(`Comparing activities ${activityId1} and ${activityId2}`);

      const [activity1, activity2] = await Promise.all([
        getActivity(apiKey, activityId1),
        getActivity(apiKey, activityId2),
      ]);

      const result = buildComparison(activity1, activity2);
      const {
        activity_1: summary1,
        activity_2: summary2,
        differences,
        efficiency,
      } = result;
      const {
        distance_km: distanceDiff,
        pace: paceDiff,
        avg_hr: hrDiff,
        cadence_spm: cadenceDiff,
        elevation_gain_m: elevationDiff,
      } = differences;
      const warnings = result.warnings ?? [];

      const lines = [`Activity 1: ${summary1.name} [${summary1.id}]`];
      lines.push(`  ${summary1.date} | ${summary1.type}`);
      lines.push(
        `  ${summary1.distance_km} km in ${formatDuration(summary1.moving_time)}`,
      );
      if (summary1.pace_min_per_km)
        lines.push(`  Pace: ${summary1.pace_min_per_km} /km`);
      if (summary1.average_hr != null)
        lines.push(`  HR: ${summary1.average_hr} avg, ${summary1.max_hr} max`);
      if (summary1.cadence_spm != null)
        lines.push(`  Cadence: ${summary1.cadence_spm} spm`);
      lines.push(`  Elevation: ${summary1.elevation_gain_m} m`);

      lines.push(`Activity 2: ${summary2.name} [${summary2.id}]`);
      lines.push(`  ${summary2.date} | ${summary2.type}`);
      lines.push(
        `  ${summary2.distance_km} km in ${formatDuration(summary2.moving_time)}`,
      );
      if (summary2.pace_min_per_km)
        lines.push(`  Pace: ${summary2.pace_min_per_km} /km`);
      if (summary2.average_hr != null)
        lines.push(`  HR: ${summary2.average_hr} avg, ${summary2.max_hr} max`);
      if (summary2.cadence_spm != null)
        lines.push(`  Cadence: ${summary2.cadence_spm} spm`);
      lines.push(`  Elevation: ${summary2.elevation_gain_m} m`);

      lines.push("Differences (Activity 2 vs Activity 1):");
      lines.push(
        `  Distance: ${distanceDiff > 0 ? "+" : ""}${distanceDiff} km`,
      );
      if (paceDiff) {
        lines.push(
          `  Pace: ${paceDiff.min_per_km} /km (${paceDiff.seconds_per_km > 0 ? "+" : ""}${paceDiff.seconds_per_km} s/km, ${paceDiff.interpretation})`,
        );
      }
      if (hrDiff !== null)
        lines.push(`  Avg HR: ${hrDiff > 0 ? "+" : ""}${hrDiff} bpm`);
      if (cadenceDiff !== null)
        lines.push(
          `  Cadence: ${cadenceDiff > 0 ? "+" : ""}${cadenceDiff} spm`,
        );
      lines.push(
        `  Elevation: ${elevationDiff > 0 ? "+" : ""}${elevationDiff} m`,
      );

      if (efficiency) {
        lines.push("Efficiency Analysis:");
        lines.push(`  Activity 1: ${efficiency.activity_1}`);
        lines.push(`  Activity 2: ${efficiency.activity_2}`);
        lines.push(
          `  Change: ${efficiency.change_percent > 0 ? "+" : ""}${efficiency.change_percent}% (${efficiency.interpretation})`,
        );
        lines.push(`  ${efficiency.note}`);
      }

      if (warnings.length > 0) {
        lines.push("Warnings:");
        for (const w of warnings) lines.push(`  - ${w}`);
      }

      warnOnSchemaDrift(name, CompareActivitiesOutputSchema, result);

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: result,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: toolErrorText(error, {
              context: `compare activities ${activityId1} and ${activityId2}`,
              notFound:
                "One or both activities not found. Please verify the activity IDs.",
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
