import { z } from "zod";
import {
  type ActivityWeather,
  buildActivityWeather,
  formatWeatherLine,
  loadActivityWeather,
  weatherDifference,
  weatherNote,
} from "../activityWeather";
import { speedEfficiencyFactor } from "../aerobicAnalysis";
import { formatDuration, formatSigned, round } from "../formatters";
import { getActivity, type IntervalsActivity } from "../intervalsClient";
import { IntervalsStreamsUnavailableError } from "../intervalsStreams";
import {
  compareKmSplits,
  formatKmComparison,
  type KmComparison,
} from "../kmComparison";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import { type SplitAnalysis, SplitAnalysisError } from "../splitAnalysis";
import {
  activityCadenceSpm,
  buildRunningDynamics,
  formatPaceSeconds,
  gapPace,
  isPaceActivity,
  isRunningActivity,
  paceFromDistanceTime,
  type RunningDynamicsAvg,
  sportSpeed,
} from "../utils/running";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { intervalsActivityIdInput } from "./_ids";
import { loadSplitAnalysis } from "./getSplitAnalysis";
import { CompareActivitiesOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "compare-activities";

const description = `
Compares two running activities side by side: pace, HR, cadence, load and
running dynamics for each, the differences (activity 2 minus activity 1), and
an efficiency factor per run (metres per minute per heartbeat, higher is
better, grade-adjusted when both runs have GAP). Use it for the same route on
two days, progress over time, or two races.

A per-km table pairs the runs at the same distance (pace, HR and
efficiency difference) with a verdict: constant offset (the gap is there
from km 1: conditions or recovery) or growing drift (it grows: fatigue).
For one run's aerobic durability, use get-aerobic-analysis.

Notes:
- Pass the older or baseline run as activityId1. A positive difference means
  activity 2 is higher or longer; a negative pace difference means it was
  faster.
- The efficiency comparison needs heart rate in both runs. A change beyond
  3% reads as improved or declined.
- Weather per run (temperature, and humidity and dew point from the FIT
  file) with the difference; a note when the dew point differs by more than
  5 °C, as heat and humidity raise HR.
- A non-running activity on either side gives a warning, not an error. A
  swim side shows pace per 100 m and another sport speed in km/h; the pace
  difference, efficiency and per-km table are for runs only.
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
  /** The activity's own `moving_time`, which the pace and the pace delta use. */
  moving_time_source: "intervals.icu";
  pace_min_per_km: string | null;
  /** From `sportSpeed`: swims only. */
  pace_min_per_100m: string | null;
  /** From `sportSpeed`: every type that is neither a run nor a swim. */
  speed_kmh: number | null;
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
  weather: ActivityWeather | null;
}

function extractActivitySummary(
  activity: IntervalsActivity,
  weather: ActivityWeather | null,
): ActivitySummary {
  const type = activity.type ?? "Workout";
  const speed = sportSpeed(type, activity.distance, activity.moving_time);

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
    moving_time_source: "intervals.icu",
    pace_min_per_km: isPaceActivity(type)
      ? paceFromDistanceTime(activity.distance, activity.moving_time)
      : null,
    pace_min_per_100m: speed.pace_min_per_100m,
    speed_kmh: speed.speed_kmh,
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
    weather,
  };
}

/** One side's HR text line: the average, plus the max only when the activity recorded one. */
function formatHrLine(summary: ActivitySummary): string | null {
  if (summary.average_hr == null) return null;
  const max = summary.max_hr == null ? "" : `, ${summary.max_hr} max`;
  return `  HR: ${summary.average_hr} avg${max}`;
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
 * What {@link loadComparison} reads beyond the two activities: each one's
 * weather (with its FIT file's humidity) and 1 km splits. Left out, a side
 * has only the weather on its activity record and there is no per-km table.
 */
export interface ComparisonExtras {
  weather1?: ActivityWeather | null;
  weather2?: ActivityWeather | null;
  splits1?: SideSplits;
  splits2?: SideSplits;
}

/** One side's splits, or why it has none. */
export type SideSplits =
  | { analysis: SplitAnalysis; note?: undefined }
  | { analysis: null; note: string };

/**
 * The per-km table, or why there is none. Both sides need splits; the
 * efficiency is grade-adjusted only when both have elevation data.
 */
function kmComparisonOf(
  splits1: SideSplits | undefined,
  splits2: SideSplits | undefined,
): { comparison: KmComparison | null; note: string | null } {
  if (!splits1 || !splits2)
    return { comparison: null, note: "the streams were not read" };
  // A side that is not a run is the reason, ahead of the run beside it.
  const sides = [splits1, splits2];
  const notRun = sides.findIndex((side) => side.note === NOT_A_RUN);
  if (notRun !== -1)
    return { comparison: null, note: `activity ${notRun + 1} ${NOT_A_RUN}` };
  if (!splits1.analysis)
    return { comparison: null, note: `activity 1 ${splits1.note}` };
  if (!splits2.analysis)
    return { comparison: null, note: `activity 2 ${splits2.note}` };
  const comparison = compareKmSplits(
    splits1.analysis.splits,
    splits2.analysis.splits,
    splits1.analysis.gradeSource !== "none" &&
      splits2.analysis.gradeSource !== "none",
  );
  return comparison
    ? { comparison, note: null }
    : { comparison: null, note: "the runs share no full km" };
}

const NOT_A_RUN = "is not a run";

/** A side whose streams are not read, because one of the two is not a run. */
function unreadSplits(activity: IntervalsActivity): SideSplits {
  return isPaceActivity(activity.type ?? "")
    ? { analysis: null, note: "was not read" }
    : { analysis: null, note: NOT_A_RUN };
}

/**
 * One side's 1 km splits through get-split-analysis' own path, or why there
 * are none: no streams, or streams it cannot split. Any other failure (a
 * rate limit, a 5xx) propagates, as the stream loader requires.
 */
async function loadSideSplits(
  apiKey: string,
  id: string,
  activity: IntervalsActivity,
): Promise<SideSplits> {
  try {
    return { analysis: await loadSplitAnalysis(apiKey, id, activity) };
  } catch (error) {
    if (error instanceof IntervalsStreamsUnavailableError)
      return { analysis: null, note: "has no streams" };
    if (error instanceof SplitAnalysisError)
      return { analysis: null, note: `has no splits (${error.message})` };
    throw error;
  }
}

/**
 * Reads both activities, their weather and their splits, and builds the
 * comparison. The one loader for compare-activities and the compare app's
 * data tool, so the two can never disagree. Each activity is read with
 * `intervals: true`, the same URL as the app's stream overlay reads, and the
 * streams through the shared adapter, so a chat that uses them together
 * reads each once.
 */
export async function loadComparison(
  apiKey: string,
  id1: string,
  id2: string,
  progress: ReportProgress = NO_PROGRESS,
): Promise<ComparisonResult> {
  const [activity1, activity2] = await Promise.all([
    getActivity(apiKey, id1, { intervals: true }),
    getActivity(apiKey, id2, { intervals: true }),
  ]);
  progress("Reading weather and streams for both activities");
  // The per-km table needs two runs: with a non-run on either side, neither
  // side's streams are read.
  const bothRuns =
    isPaceActivity(activity1.type ?? "") &&
    isPaceActivity(activity2.type ?? "");
  const [weather1, weather2, splits1, splits2] = await Promise.all([
    loadActivityWeather(apiKey, id1, activity1),
    loadActivityWeather(apiKey, id2, activity2),
    bothRuns ? loadSideSplits(apiKey, id1, activity1) : unreadSplits(activity1),
    bothRuns ? loadSideSplits(apiKey, id2, activity2) : unreadSplits(activity2),
  ]);
  return buildComparison(activity1, activity2, {
    weather1,
    weather2,
    splits1,
    splits2,
  });
}

/**
 * Pure aggregate comparison of two intervals.icu activities: per-side
 * summaries, activity2 − activity1 differences, and the efficiency-factor
 * comparison. The pace delta comes from each activity's raw distance (m) and
 * moving time (s), never from the formatted per-side paces, so it reflects
 * the true difference rather than compounding two roundings. The distance,
 * HR, cadence and elevation differences subtract the per-side summaries.
 *
 * Shared by this tool's text/structured output and the app-only
 * `get-compare-activities-data` feed behind `view-compare-activities`.
 */
export function buildComparison(
  activity1: IntervalsActivity,
  activity2: IntervalsActivity,
  extras: ComparisonExtras = {},
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

  const summary1 = extractActivitySummary(
    activity1,
    extras.weather1 !== undefined
      ? extras.weather1
      : buildActivityWeather(activity1, null),
  );
  const summary2 = extractActivitySummary(
    activity2,
    extras.weather2 !== undefined
      ? extras.weather2
      : buildActivityWeather(activity2, null),
  );
  const weatherDiff = weatherDifference(summary1.weather, summary2.weather);
  const km = kmComparisonOf(extras.splits1, extras.splits2);

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
      swim_pace: "min/100m",
      speed: "km/h",
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
      weather: weatherDiff,
    },
    weather_note: weatherNote(weatherDiff),
    km_comparison: km.comparison,
    km_comparison_note: km.note,
    efficiency,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/** The weather differences line, or null when no value is on both sides. */
function formatWeatherDifferenceLine(
  result: Pick<ComparisonResult, "activity_1" | "activity_2" | "differences">,
): string | null {
  const w1 = result.activity_1.weather;
  const w2 = result.activity_2.weather;
  const d = result.differences.weather;
  const parts: string[] = [];
  if (d.temperature_c != null)
    parts.push(
      `${w1?.temperature_c} to ${w2?.temperature_c} °C (${formatSigned(d.temperature_c, 1)})`,
    );
  if (d.dew_point_c != null)
    parts.push(
      `dew point ${w1?.dew_point_c} to ${w2?.dew_point_c} °C (${formatSigned(d.dew_point_c, 1)})`,
    );
  if (d.humidity_pct != null)
    parts.push(
      `humidity ${w1?.humidity_pct} to ${w2?.humidity_pct}% (${formatSigned(d.humidity_pct)})`,
    );
  return parts.length > 0 ? `  Weather: ${parts.join(", ")}` : null;
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
      const result = await loadComparison(
        apiKey,
        activityId1,
        activityId2,
        progress,
      );
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
      lines.push(
        `  ${summary1.distance_km} km in ${summary1.moving_time} moving (${summary1.moving_time_source})`,
      );
      if (summary1.pace_min_per_km)
        lines.push(`  Pace: ${summary1.pace_min_per_km} /km`);
      if (summary1.pace_min_per_100m)
        lines.push(`  Pace: ${summary1.pace_min_per_100m} /100m`);
      if (summary1.speed_kmh != null)
        lines.push(`  Speed: ${summary1.speed_kmh} km/h`);
      const hrLine1 = formatHrLine(summary1);
      if (hrLine1) lines.push(hrLine1);
      if (summary1.cadence_spm != null)
        lines.push(`  Cadence: ${summary1.cadence_spm} spm`);
      lines.push(`  Elevation: ${summary1.elevation_gain_m} m`);
      const weatherLine1 = formatWeatherLine(summary1.weather);
      if (weatherLine1) lines.push(`  ${weatherLine1}`);

      lines.push(`Activity 2: ${summary2.name} [${summary2.id}]`);
      lines.push(`  ${summary2.date} | ${summary2.type}`);
      lines.push(
        `  ${summary2.distance_km} km in ${summary2.moving_time} moving (${summary2.moving_time_source})`,
      );
      if (summary2.pace_min_per_km)
        lines.push(`  Pace: ${summary2.pace_min_per_km} /km`);
      if (summary2.pace_min_per_100m)
        lines.push(`  Pace: ${summary2.pace_min_per_100m} /100m`);
      if (summary2.speed_kmh != null)
        lines.push(`  Speed: ${summary2.speed_kmh} km/h`);
      const hrLine2 = formatHrLine(summary2);
      if (hrLine2) lines.push(hrLine2);
      if (summary2.cadence_spm != null)
        lines.push(`  Cadence: ${summary2.cadence_spm} spm`);
      lines.push(`  Elevation: ${summary2.elevation_gain_m} m`);
      const weatherLine2 = formatWeatherLine(summary2.weather);
      if (weatherLine2) lines.push(`  ${weatherLine2}`);

      lines.push("Differences (Activity 2 vs Activity 1):");
      lines.push(`  Distance: ${formatSigned(distanceDiff)} km`);
      if (paceDeltaSecPerKm != null) {
        lines.push(
          `  Pace: ${paceDeltaMinPerKm} /km (${formatSigned(paceDeltaSecPerKm)} s/km, ${paceDeltaInterpretation})`,
        );
      }
      if (hrDiff !== null) lines.push(`  Avg HR: ${formatSigned(hrDiff)} bpm`);
      if (cadenceDiff !== null)
        lines.push(`  Cadence: ${formatSigned(cadenceDiff)} spm`);
      lines.push(`  Elevation: ${formatSigned(elevationDiff)} m`);
      const weatherDiffLine = formatWeatherDifferenceLine(result);
      if (weatherDiffLine) lines.push(weatherDiffLine);
      if (result.weather_note)
        lines.push(`Weather note: ${result.weather_note}`);

      if (efficiency) {
        lines.push("Efficiency Analysis:");
        lines.push(`  Activity 1: ${efficiency.activity_1} m/min per beat`);
        lines.push(`  Activity 2: ${efficiency.activity_2} m/min per beat`);
        lines.push(
          `  Change: ${formatSigned(efficiency.change_percent)}% (${efficiency.interpretation})`,
        );
        lines.push(`  ${efficiency.note}`);
      }

      if (result.km_comparison) {
        lines.push(...formatKmComparison(result.km_comparison));
      } else if (result.km_comparison_note) {
        lines.push(`No per-km table: ${result.km_comparison_note}.`);
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
