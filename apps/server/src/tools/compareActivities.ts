import { z } from "zod";
import { speedEfficiencyFactor } from "../aerobicAnalysis";
import { formatDuration, round } from "../formatters";
import { getActivity, type IntervalsActivity } from "../intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import {
  activityCadenceSpm,
  buildRunningDynamics,
  formatPaceSeconds,
  gapPace,
  isPaceActivity,
  isRunningActivity,
  paceFromDistanceTime,
  type RunningDynamicsAvg,
} from "../utils/running";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { intervalsActivityIdInput } from "./_ids";
import { CompareActivitiesOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "compare-activities";

const description = `
Compares two running activities side by side: pace, HR, cadence, load and
running dynamics for each, the differences (activity 2 minus activity 1), and
an efficiency factor per run (metres per minute per heartbeat, higher is
better, grade-adjusted when both runs have GAP). Use it for the same route on
two days, progress over time, or two races.

To see where in the runs the difference happened, use
view-compare-activities. For one run's aerobic durability, use
get-aerobic-analysis.

Notes:
- Pass the older or baseline run as activityId1. A positive difference means
  activity 2 is higher or longer; a negative pace difference means it was
  faster.
- The efficiency comparison needs heart rate in both runs. A change beyond
  3% reads as improved or declined.
- A non-running activity on either side gives a warning, not an error.
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

interface ActivitySummary {
  id: string;
  name: string;
  date: string;
  type: string;
  distance_km: number;
  moving_time: string;
  moving_time_s: number;
  pace_min_per_km: string | null;
  gap_min_per_km: string | null;
  /** GAP here is always intervals.icu's own `gap` field, distinct from
   * get-hill-analysis/get-split-analysis's locally-modelled GAP. */
  gap_source: "intervals.icu";
  average_hr: number | null;
  max_hr: number | null;
  cadence_spm: number | null;
  elevation_gain_m: number;
  load: number | null;
  decoupling_pct: number | null;
  efficiency_factor: number | null;
  running_dynamics: RunningDynamicsAvg | null;
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
    moving_time: formatDuration(activity.moving_time ?? 0),
    moving_time_s: activity.moving_time ?? 0,
    pace_min_per_km: isPaceActivity(type)
      ? paceFromDistanceTime(activity.distance, activity.moving_time)
      : null,
    gap_min_per_km: gapPace(activity.gap, type),
    gap_source: "intervals.icu",
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
 * summaries, activity2 − activity1 differences, and the efficiency-factor
 * comparison. Differences are derived from each activity's raw distance (m)
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

  let paceDeltaSecPerKm: number | null = null;
  let paceDeltaMinPerKm: string | null = null;
  let paceDeltaInterpretation: string | null = null;
  if (paceSec1 != null && paceSec2 != null) {
    const diffSeconds = Math.round(paceSec2 - paceSec1);
    paceDeltaSecPerKm = diffSeconds;
    paceDeltaMinPerKm = signedPaceDelta(diffSeconds);
    paceDeltaInterpretation =
      diffSeconds < -5 ? "faster" : diffSeconds > 5 ? "slower" : "same";
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

  // Efficiency factor, the same speedEfficiencyFactor get-aerobic-analysis
  // reports: metres per minute per beat, higher is better. Grade-adjusted
  // speed (intervals.icu's gap) only when both runs have it, so a hillier
  // route does not read as lost fitness and both sides share one basis.
  // Independent of intervals.icu's own icu_efficiency_factor on each side.
  let efficiency: ComparisonResult["efficiency"] = null;
  const hr1 = summary1.average_hr;
  const hr2 = summary2.average_hr;
  if (
    paceSec1 != null &&
    paceSec2 != null &&
    hr1 != null &&
    hr1 > 0 &&
    hr2 != null &&
    hr2 > 0
  ) {
    const gap1 = activity1.gap ?? 0;
    const gap2 = activity2.gap ?? 0;
    const gradeAdjusted = gap1 > 0 && gap2 > 0;
    const eff1 = speedEfficiencyFactor(
      gradeAdjusted ? gap1 : 1000 / paceSec1,
      hr1,
    );
    const eff2 = speedEfficiencyFactor(
      gradeAdjusted ? gap2 : 1000 / paceSec2,
      hr2,
    );
    const changePercent = Math.round(((eff2 - eff1) / eff1) * 1000) / 10;

    efficiency = {
      activity_1: Math.round(eff1 * 1000) / 1000,
      activity_2: Math.round(eff2 * 1000) / 1000,
      change_percent: changePercent,
      interpretation:
        changePercent > 3
          ? "improved"
          : changePercent < -3
            ? "declined"
            : "unchanged",
      note: gradeAdjusted
        ? "Efficiency factor in metres per minute per heartbeat, from grade-adjusted pace (intervals.icu gap) on both runs. Higher is better. Same unit as the pace-basis efficiency factor of get-aerobic-analysis."
        : "Efficiency factor in metres per minute per heartbeat, from moving pace, because at least one run has no grade-adjusted pace. Hills count against the hillier run. Higher is better. Same unit as the pace-basis efficiency factor of get-aerobic-analysis.",
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
      pace_delta_sec_per_km: paceDeltaSecPerKm,
      pace_delta_min_per_km: paceDeltaMinPerKm,
      pace_delta_interpretation: paceDeltaInterpretation,
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
  title: "Compare two activities",
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
        pace_delta_sec_per_km: paceDeltaSecPerKm,
        pace_delta_min_per_km: paceDeltaMinPerKm,
        pace_delta_interpretation: paceDeltaInterpretation,
        avg_hr: hrDiff,
        cadence_spm: cadenceDiff,
        elevation_gain_m: elevationDiff,
      } = differences;
      const warnings = result.warnings ?? [];

      const lines = [`Activity 1: ${summary1.name} [${summary1.id}]`];
      lines.push(`  ${summary1.date} | ${summary1.type}`);
      lines.push(`  ${summary1.distance_km} km in ${summary1.moving_time}`);
      if (summary1.pace_min_per_km)
        lines.push(`  Pace: ${summary1.pace_min_per_km} /km`);
      if (summary1.average_hr != null)
        lines.push(`  HR: ${summary1.average_hr} avg, ${summary1.max_hr} max`);
      if (summary1.cadence_spm != null)
        lines.push(`  Cadence: ${summary1.cadence_spm} spm`);
      lines.push(`  Elevation: ${summary1.elevation_gain_m} m`);

      lines.push(`Activity 2: ${summary2.name} [${summary2.id}]`);
      lines.push(`  ${summary2.date} | ${summary2.type}`);
      lines.push(`  ${summary2.distance_km} km in ${summary2.moving_time}`);
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
      if (paceDeltaSecPerKm != null) {
        lines.push(
          `  Pace: ${paceDeltaMinPerKm} /km (${paceDeltaSecPerKm > 0 ? "+" : ""}${paceDeltaSecPerKm} s/km, ${paceDeltaInterpretation})`,
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
        lines.push(`  Activity 1: ${efficiency.activity_1} m/min per beat`);
        lines.push(`  Activity 2: ${efficiency.activity_2} m/min per beat`);
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
