import { z } from "zod";
import { getTimeZone } from "../config";
import { RUN_ONLY_RUNWAY_DAYS } from "../fitnessTrend";
import { formatDuration } from "../formatters";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import {
  aggregateWeeks,
  computeWeekWarnings,
  getWeekStart,
} from "../trainingLoad";
import { loadTrainingLoadInputs } from "../trainingLoadInputs";
import { addDays, todayLocal } from "../utils/localDate";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { TrainingLoadOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-training-load";

const description = `
Retrieves training load summary for a specified time period, from intervals.icu.

This tool aggregates activities to provide:
- Weekly run volume (distance, time, elevation, run count), always Run/TrailRun/VirtualRun
- Injury-risk warnings for sudden volume increases
- Weekly intervals.icu training load (sum of icu_training_load), and the
  activity types it was summed over
- Current CTL (fitness) / ATL (fatigue) / TSB (form)

Load and current CTL/ATL/TSB can be computed two ways:
- Whole-body (default): load sums every activity type; CTL/ATL/TSB are read
  straight off intervals.icu's own daily wellness record (today or the most
  recent day with a recorded value)
- Run-only (runOnly: true): load sums Run/TrailRun/VirtualRun only; CTL/ATL/TSB
  are computed locally from that same run load, zero-seeded well before the
  window so the 42-day CTL average has settled. Labeled "computed" and will
  not exactly match intervals.icu's own (whole-body) fitness page

Weekly volume and injury-risk warnings are always run-based (Run, TrailRun,
VirtualRun), regardless of runOnly.

Use Cases:
- Monitor weekly training volume and load together
- Track training consistency over time
- Identify potential overtraining risks
- Check current fitness/fatigue/form alongside recent volume

Parameters:
- days (optional): Number of days to analyze (default: 28, i.e., 4 weeks)
- runOnly (optional, default false): sum load and compute CTL/ATL/TSB from
  Run/TrailRun/VirtualRun training load only, instead of whole-body

Notes:
- Trend is calculated by comparing recent 2 weeks vs previous 2 weeks
- Warnings are generated for >30% week-over-week volume increases
- Weeks start Monday in the athlete's configured time zone
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

/**
 * Prose warnings from the shared per-week rules, so this tool and the
 * training-load MCP App feed (`get-training-load-data`) stay consistent.
 */
function generateWarnings(
  weeklyBreakdown: Array<{ week_starting: string; distance_km: number }>,
): string[] {
  return computeWeekWarnings(weeklyBreakdown).map(
    (w) => `Week of ${w.week_starting}: ${w.reason}`,
  );
}

const localDay = (isoDateTime: string) => isoDateTime.split("T")[0]!;

export const getTrainingLoadTool = {
  name,
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
      const tz = getTimeZone();
      const endDate = todayLocal(tz);
      const windowStart = addDays(endDate, -(days - 1));

      const {
        runs: runActivities,
        loadActivities,
        current,
        source,
        activityTypesIncluded,
      } = await loadTrainingLoadInputs(apiKey, { days, runOnly }, progress);

      // The one shared weekly timeline (trainingLoad.ts's aggregateWeeks):
      // the union of run weeks and load weeks, so this tool and the
      // training-load MCP App feed can never report different weekly or
      // total load for the same activities.
      const buckets = aggregateWeeks(runActivities, loadActivities);

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
        distance_km: Math.round(bucket.distanceM / 10) / 100,
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

      // Weekly averages and the trend verdict are run-based (volume is
      // run-based), computed over weeks that actually had a run rather than
      // the full calendar span `sortedWeeks` covers: whole-body's shared
      // timeline also includes load-only weeks (e.g. a bike-only week before
      // or after the run window), which would otherwise dilute the run
      // averages and shift the trend comparison only for runOnly: false.
      const runWeeks = sortedWeeks.filter((w) => w.runs > 0);
      const numWeeks = runWeeks.length || 1;

      // Calculate trend (compare last 2 run weeks to previous 2 run weeks).
      let trend = "insufficient data";
      if (runWeeks.length >= 4) {
        const recentDistance =
          runWeeks[runWeeks.length - 1]!.distance_km +
          runWeeks[runWeeks.length - 2]!.distance_km;
        const previousDistance =
          runWeeks[runWeeks.length - 3]!.distance_km +
          runWeeks[runWeeks.length - 4]!.distance_km;

        if (previousDistance > 0) {
          const change =
            ((recentDistance - previousDistance) / previousDistance) * 100;
          if (change > 15) trend = "increasing significantly";
          else if (change > 5) trend = "increasing";
          else if (change < -15) trend = "decreasing significantly";
          else if (change < -5) trend = "decreasing";
          else trend = "stable";
        }
      } else if (runWeeks.length >= 2) {
        trend = "limited data - need 4+ weeks for trend";
      }

      // Generate warnings, always run-based, over run-only weeks (not the
      // whole-body cross-training weeks that only carry load).
      const warnings = generateWarnings(runWeeks);
      warnings.push(
        "Weekly volume and injury-risk warnings are computed from " +
          "Run/TrailRun/VirtualRun activities only.",
      );
      if (runOnly) {
        warnings.push(
          `Run-only CTL/ATL is computed locally from Run/TrailRun/VirtualRun ` +
            `training load, zero-seeded ${RUN_ONLY_RUNWAY_DAYS} days before ` +
            `the window so the 42-day CTL average has settled; it will not ` +
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
        period: {
          days,
          start_date: windowStart,
          end_date: endDate,
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
          runs_per_week: Math.round((totalRuns / numWeeks) * 10) / 10,
          distance_km_per_week:
            Math.round((totalDistanceKm / numWeeks) * 100) / 100,
          time_hours_per_week:
            Math.round((totalTimeHours / numWeeks) * 100) / 100,
        },
        trend,
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
      output += `${result.period.start_date} to ${result.period.end_date} (${days} days, CTL/ATL source: ${source})\n\n`;

      output += `Totals\n`;
      output += `  Runs: ${result.totals.runs}\n`;
      output += `  Distance: ${result.totals.distance_km} km\n`;
      output += `  Time: ${Math.floor(result.totals.time_hours)}h ${Math.round((result.totals.time_hours % 1) * 60)}m\n`;
      output += `  Elevation: ${result.totals.elevation_m} m\n`;
      output += `  Load: ${result.totals.load} (${activityTypesIncluded.join(", ") || "none"})\n\n`;

      if (current) {
        output += `Current (as of ${current.date})\n`;
        output += `  Fitness (CTL): ${current.ctl}\n`;
        output += `  Fatigue (ATL): ${current.atl}\n`;
        output += `  Form (TSB): ${current.tsb >= 0 ? "+" : ""}${current.tsb}\n\n`;
      }

      output += `Weekly Averages\n`;
      output += `  Runs/week: ${result.averages.runs_per_week}\n`;
      output += `  Distance/week: ${result.averages.distance_km_per_week} km\n`;
      output += `  Time/week: ${result.averages.time_hours_per_week} hours\n\n`;

      output += `Trend: ${result.trend}\n\n`;

      if (result.warnings.length > 0) {
        output += `Warnings\n`;
        for (const warning of result.warnings) {
          output += `  - ${warning}\n`;
        }
        output += `\n`;
      }

      output += `Weekly Breakdown\n`;
      for (const week of result.weekly_breakdown) {
        output += `  Week of ${week.week_starting}: ${week.runs} runs, ${week.distance_km} km, ${week.time_formatted}, load ${week.load}\n`;
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
