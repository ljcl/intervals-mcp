import { z } from "zod";
import { RUN_ONLY_RUNWAY_DAYS } from "../fitnessTrend";
import { formatDuration, formatSigned } from "../formatters";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import {
  aggregateWeeks,
  baselineWeeks,
  getWeekStart,
  selectRunWeeks,
  volumeTrend,
  weekDistanceKm,
  weekInProgress,
} from "../trainingLoad";
import { loadTrainingLoadInputs } from "../trainingLoadInputs";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { TrainingLoadOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-training-load";

const description = `
Returns weekly running volume (distance, time, elevation, run count) with a
trend and volume-spike warnings, weekly intervals.icu training load, and
current CTL/ATL/TSB. Use it for "how is my training volume trending?" or
"am I ramping up too fast?".

For the day-by-day CTL/ATL/TSB trend, a projection or a taper plan, use
get-fitness-trend. For plain totals (this week, month, year to date), use
get-athlete-stats; to show weekly volume as a chart, view-training-load.

Notes:
- Weekly volume and warnings always count runs only (Run, TrailRun,
  VirtualRun).
- Training load and CTL/ATL/TSB are whole-body by default, read from
  intervals.icu. runOnly sums run load only and computes CTL/ATL/TSB locally,
  labelled "computed"; it will not match intervals.icu's fitness page.
- days is rounded up to whole weeks (Monday start, athlete's time zone), and
  the current week so far is added: days 28 gives 4 complete weeks plus this
  week. Averages and the trend use complete weeks only; the trend compares
  the last 2 with the 2 before.
- Weeks with no runs count as zero weeks, a layoff still going on included.
- A warning fires when a week's distance is over 1.5 times the average of
  the 4 complete weeks before it (the acute:chronic ratio; needs 3 of them,
  and the 4 weeks before the window count). So a normal week after a
  recovery or taper week does not fire. It marks a sharp rise on recent
  volume, not a measured injury risk: the evidence for ratio thresholds is
  weak. The current week is flagged only on the volume it already has.
`;

const inputSchema = z.object({
  days: z
    .number()
    .int()
    .positive()
    .max(365)
    .default(28)
    .describe(
      "Number of days to look back (default: 28 for 4 weeks, max: 365)",
    ),
  runOnly: z
    .boolean()
    .default(false)
    .describe(
      "Sum load and compute CTL/ATL/TSB from Run/TrailRun/VirtualRun " +
        "training load only, computed locally (intervals.icu has no " +
        "per-sport CTL/ATL). Default false reads whole-body load and " +
        "CTL/ATL directly from intervals.icu. Weekly volume and warnings " +
        "are always run-based either way.",
    ),
});

type GetTrainingLoadInput = z.infer<typeof inputSchema>;

interface ActivitySummary {
  id: string;
  name: string;
  date: string;
  distance_km: number;
}

const localDay = (isoDateTime: string) => isoDateTime.split("T")[0]!;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const getTrainingLoadTool = {
  name,
  title: "Training load",
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: TrainingLoadOutputSchema,
  execute: async (
    { days, runOnly }: GetTrainingLoadInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    try {
      const {
        lookback,
        runs: runActivities,
        baselineRuns,
        loadActivities,
        current,
        source,
        activityTypesIncluded,
      } = await loadTrainingLoadInputs(apiKey, { days, runOnly }, progress);

      // The one shared weekly timeline (trainingLoad.ts's aggregateWeeks):
      // from the first week with a run or load to the current week, so this
      // tool and the training-load MCP App feed can never report different
      // weekly or total load for the same activities.
      const buckets = aggregateWeeks(
        runActivities,
        loadActivities,
        lookback.currentWeekStart,
      );

      // Individual run activities per week, for the `activities` list this
      // text tool carries that the app feed does not.
      const activitiesByWeek = new Map<string, ActivitySummary[]>();
      for (const activity of runActivities) {
        const weekKey = getWeekStart(activity.start_date_local);
        const list = activitiesByWeek.get(weekKey) ?? [];
        list.push({
          id: activity.id,
          name: activity.name ?? "",
          date: localDay(activity.start_date_local),
          distance_km: Math.round((activity.distance || 0) / 10) / 100,
        });
        activitiesByWeek.set(weekKey, list);
      }

      const sortedWeeks = buckets.map((bucket) => ({
        week_starting: bucket.weekStarting,
        runs: bucket.runs,
        distance_km: weekDistanceKm(bucket),
        time_s: Math.round(bucket.timeS),
        time_hours: Math.round((bucket.timeS / 3600) * 100) / 100,
        time_formatted: formatDuration(bucket.timeS),
        elevation_m: Math.round(bucket.elevationM),
        load: Math.round(bucket.load),
        load_by_type: Object.fromEntries(
          Object.entries(bucket.loadByType).map(([type, load]) => [
            type,
            Math.round(load),
          ]),
        ),
        activities: activitiesByWeek.get(bucket.weekStarting) ?? [],
      }));

      // Calculate totals
      const totalRuns = sortedWeeks.reduce((sum, w) => sum + w.runs, 0);
      const totalDistanceKm = sortedWeeks.reduce(
        (sum, w) => sum + w.distance_km,
        0,
      );
      const totalTimeSeconds = sortedWeeks.reduce(
        (sum, w) => sum + w.time_s,
        0,
      );
      const totalTimeHours = sortedWeeks.reduce(
        (sum, w) => sum + w.time_hours,
        0,
      );
      const totalElevation = sortedWeeks.reduce(
        (sum, w) => sum + w.elevation_m,
        0,
      );
      const totalLoad = sortedWeeks.reduce((sum, w) => sum + w.load, 0);

      // Averages, the trend verdict and the volume-spike warnings are
      // run-based, over the weeks selectRunWeeks picks: the same call the
      // app feed makes, so the two surfaces can never disagree (#43). The
      // runs before the window are only the warnings' baseline (#60).
      // Averages and the trend read complete weeks only. With no complete
      // week yet, the averages fall back to the week in progress.
      const runWeeks = selectRunWeeks(
        buckets,
        lookback.currentWeekStart,
        baselineWeeks(baselineRuns, lookback),
      );
      const averageWeeks =
        runWeeks.complete.length > 0 ? runWeeks.complete : runWeeks.span;
      const numWeeks = averageWeeks.length || 1;
      const averaged = new Set(averageWeeks.map((b) => b.weekStarting));
      const averageRows = sortedWeeks.filter((w) =>
        averaged.has(w.week_starting),
      );
      const sumOf = (pick: (w: (typeof sortedWeeks)[number]) => number) =>
        averageRows.reduce((sum, w) => sum + pick(w), 0);

      const trend = volumeTrend(runWeeks.complete);
      const [earlier1, earlier2, recent1, recent2] = trend.weeks;
      const trendBasis =
        trend.weeks.length === 4
          ? ` (weeks of ${recent1} and ${recent2} vs ${earlier1} and ${earlier2})`
          : "";

      const warnings = runWeeks.warnings.map(
        (w) => `Week of ${w.week_starting}: ${w.reason}`,
      );
      const inProgressWeek = sortedWeeks.find((w) =>
        weekInProgress(w.week_starting, lookback.currentWeekStart),
      );
      if (inProgressWeek) {
        warnings.push(
          `Week of ${inProgressWeek.week_starting} is in progress ` +
            `(${lookback.currentWeekDays} of 7 days)` +
            (runWeeks.complete.length > 0
              ? ": averages and the trend leave it out."
              : "."),
        );
      }
      warnings.push(
        "Weekly volume and volume-spike warnings are computed from " +
          "Run/TrailRun/VirtualRun activities only.",
      );
      if (runOnly) {
        warnings.push(
          `Run-only CTL/ATL is computed locally from Run/TrailRun/VirtualRun ` +
            `training load, zero-seeded ${days + RUN_ONLY_RUNWAY_DAYS} days ` +
            `back so the 42-day CTL average has settled; it will not ` +
            `exactly match intervals.icu's own (whole-body) fitness page.`,
        );
      } else {
        warnings.push(
          "Some activity types (e.g. strength/weight training) may count " +
            "toward fatigue (ATL) only, not fitness (CTL), depending on this " +
            "athlete's intervals.icu settings.",
        );
      }

      const result = {
        // The window read, whole weeks plus this week so far: `days` is its
        // length, so it can be longer than the requested days.
        period: {
          days: lookback.spanDays,
          start_date: lookback.startDate,
          end_date: lookback.endDate,
        },
        run_only: runOnly,
        source,
        current,
        activity_types_included: activityTypesIncluded,
        totals: {
          runs: totalRuns,
          distance_km: Math.round(totalDistanceKm * 100) / 100,
          time_s: totalTimeSeconds,
          time_hours: Math.round(totalTimeHours * 100) / 100,
          elevation_m: totalElevation,
          load: totalLoad,
        },
        averages: {
          runs_per_week:
            Math.round((sumOf((w) => w.runs) / numWeeks) * 10) / 10,
          distance_km_per_week:
            Math.round((sumOf((w) => w.distance_km) / numWeeks) * 100) / 100,
          time_hours_per_week:
            Math.round((sumOf((w) => w.time_hours) / numWeeks) * 100) / 100,
        },
        trend: trend.label,
        weekly_breakdown: sortedWeeks,
        warnings,
        units: {
          load: "intervals.icu training load" as const,
          distance: "km" as const,
          time: "s" as const,
          time_hours: "h" as const,
          elevation: "m" as const,
        },
      };

      // Format as readable text
      let output = `Training Load Summary\n`;
      output += `${result.period.start_date} to ${result.period.end_date} (${plural(lookback.completeWeeks, "complete week")} and this week so far, CTL/ATL source: ${source})\n\n`;

      output += `Totals\n`;
      output += `  Runs: ${result.totals.runs}\n`;
      output += `  Distance: ${result.totals.distance_km} km\n`;
      // From the seconds total, in the same h:mm:ss form as the weekly lines.
      // Minutes split out of the rounded hours carried the rounding error
      // (#76).
      output += `  Time: ${formatDuration(result.totals.time_s)}\n`;
      output += `  Elevation: ${result.totals.elevation_m} m\n`;
      output += `  Load: ${result.totals.load} (${activityTypesIncluded.join(", ") || "none"})\n\n`;

      if (current) {
        output += `Current (as of ${current.date})\n`;
        output += `  Fitness (CTL): ${current.ctl}\n`;
        output += `  Fatigue (ATL): ${current.atl}\n`;
        output += `  Form (TSB): ${formatSigned(current.tsb)}\n\n`;
      }

      const averagedOver =
        runWeeks.complete.length > 0
          ? plural(runWeeks.complete.length, "complete week")
          : runWeeks.span.length > 0
            ? "this week so far"
            : "no runs";
      output += `Weekly Averages (${averagedOver})\n`;
      output += `  Runs/week: ${result.averages.runs_per_week}\n`;
      output += `  Distance/week: ${result.averages.distance_km_per_week} km\n`;
      output += `  Time/week: ${result.averages.time_hours_per_week} hours\n\n`;

      output += `Trend: ${result.trend}${trendBasis}\n\n`;

      if (result.warnings.length > 0) {
        output += `Warnings\n`;
        for (const warning of result.warnings) {
          output += `  - ${warning}\n`;
        }
        output += `\n`;
      }

      output += `Weekly Breakdown\n`;
      for (const week of result.weekly_breakdown) {
        const label =
          week === inProgressWeek
            ? ` (in progress, ${lookback.currentWeekDays} of 7 days)`
            : "";
        output += `  Week of ${week.week_starting}${label}: ${week.runs} runs, ${week.distance_km} km, ${week.time_formatted}, load ${week.load}\n`;
      }

      warnOnSchemaDrift(name, TrainingLoadOutputSchema, result);

      return {
        content: [{ type: "text" as const, text: output }],
        structuredContent: result,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: toolErrorText(error, {
              context: `fetch training load for ${days} days`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
