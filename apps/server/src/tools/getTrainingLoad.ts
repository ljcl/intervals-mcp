import { z } from "zod";
import { getTimeZone } from "../config";
import {
  buildRunOnlyFitnessTrend,
  RUN_ONLY_RUNWAY_DAYS,
  RUN_TYPES,
} from "../fitnessTrend";
import { loadWellnessFitnessSeries } from "../fitnessTrendWellness";
import { formatDuration } from "../formatters";
import { type IntervalsActivity, listActivities } from "../intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import { computeWeekWarnings, getWeekStart } from "../trainingLoad";
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

interface WeekData {
  runs: number;
  distance_m: number;
  time_seconds: number;
  elevation_m: number;
  load: number;
  load_by_type: Record<string, number>;
  activities: Array<{
    id: string;
    name: string;
    date: string;
    distance_km: number;
  }>;
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

      let allActivities: IntervalsActivity[];
      let windowActivities: IntervalsActivity[];
      let current: {
        date: string;
        ctl: number;
        atl: number;
        tsb: number;
      } | null;
      let source: "intervals.icu" | "computed";
      let activityTypesIncluded: string[];

      if (runOnly) {
        const runwayDays = days + RUN_ONLY_RUNWAY_DAYS;
        const runwayStart = addDays(endDate, -(runwayDays - 1));

        progress(`Listing activities ${runwayStart} to ${endDate}…`, {
          important: true,
        });
        allActivities = await listActivities(apiKey, {
          oldest: runwayStart,
          newest: endDate,
        });
        const runActivities = allActivities.filter((a) =>
          RUN_TYPES.includes(a.type ?? ""),
        );
        windowActivities = runActivities.filter((a) => {
          const date = localDay(a.start_date_local);
          return date >= windowStart && date <= endDate;
        });

        const { trend } = buildRunOnlyFitnessTrend(runActivities, {
          endDate,
          days,
          runwayDays,
        });
        current = trend.current
          ? {
              date: trend.current.date,
              ctl: trend.current.ctl,
              atl: trend.current.atl,
              tsb: trend.current.tsb,
            }
          : null;
        source = "computed";
        activityTypesIncluded = [...RUN_TYPES];
      } else {
        progress("Listing activities…", { important: true });
        allActivities = await listActivities(apiKey, {
          oldest: windowStart,
          newest: endDate,
        });
        windowActivities = allActivities;

        progress(`Fetching wellness ${windowStart} to ${endDate}…`);
        const { series } = await loadWellnessFitnessSeries(apiKey, {
          oldest: windowStart,
          newest: endDate,
        });
        const last = series[series.length - 1];
        current = last
          ? { date: last.date, ctl: last.ctl, atl: last.atl, tsb: last.tsb }
          : null;
        source = "intervals.icu";
        activityTypesIncluded = Array.from(
          new Set(
            windowActivities
              .filter(
                (a) => a.icu_training_load != null && a.icu_training_load !== 0,
              )
              .map((a) => a.type ?? "Unknown"),
          ),
        ).sort();
      }

      // Volume/warnings are always run-based; load sums whichever types are
      // included (run-only above, or every type here for whole-body).
      const runActivities = windowActivities.filter((a) =>
        RUN_TYPES.includes(a.type ?? ""),
      );
      const loadActivities = runOnly ? runActivities : windowActivities;

      // Group by week
      const weeks = new Map<string, WeekData>();

      for (const activity of runActivities) {
        const weekKey = getWeekStart(activity.start_date_local);

        if (!weeks.has(weekKey)) {
          weeks.set(weekKey, {
            runs: 0,
            distance_m: 0,
            time_seconds: 0,
            elevation_m: 0,
            load: 0,
            load_by_type: {},
            activities: [],
          });
        }

        const week = weeks.get(weekKey)!;
        week.runs += 1;
        week.distance_m += activity.distance || 0;
        week.time_seconds += activity.moving_time || 0;
        week.elevation_m += activity.total_elevation_gain || 0;
        week.activities.push({
          id: activity.id,
          name: activity.name ?? "",
          date: localDay(activity.start_date_local),
          distance_km: Math.round((activity.distance || 0) / 10) / 100,
        });
      }

      for (const activity of loadActivities) {
        const weekKey = getWeekStart(activity.start_date_local);
        // A load activity's week can be outside the run-derived weeks map
        // (e.g. a cross-training-only week for whole-body load); create it.
        if (!weeks.has(weekKey)) {
          weeks.set(weekKey, {
            runs: 0,
            distance_m: 0,
            time_seconds: 0,
            elevation_m: 0,
            load: 0,
            load_by_type: {},
            activities: [],
          });
        }
        const week = weeks.get(weekKey)!;
        const load = activity.icu_training_load ?? 0;
        const type = activity.type ?? "Unknown";
        week.load += load;
        week.load_by_type[type] = (week.load_by_type[type] ?? 0) + load;
      }

      // Sort weeks chronologically and format
      const sortedWeeks = Array.from(weeks.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([weekStart, data]) => ({
          week_starting: weekStart,
          runs: data.runs,
          distance_km: Math.round(data.distance_m / 10) / 100,
          time_hours: Math.round((data.time_seconds / 3600) * 100) / 100,
          time_formatted: formatDuration(data.time_seconds),
          elevation_m: Math.round(data.elevation_m),
          load: Math.round(data.load),
          load_by_type: Object.fromEntries(
            Object.entries(data.load_by_type).map(([type, load]) => [
              type,
              Math.round(load),
            ]),
          ),
          activities: data.activities,
        }));

      // Calculate totals
      const totalRuns = sortedWeeks.reduce((sum, w) => sum + w.runs, 0);
      const totalDistanceKm = sortedWeeks.reduce(
        (sum, w) => sum + w.distance_km,
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
      const numWeeks = sortedWeeks.length || 1;

      // Calculate trend (compare last 2 weeks to previous 2 weeks), off
      // run-only distance always.
      let trend = "insufficient data";
      if (sortedWeeks.length >= 4) {
        const recentDistance =
          sortedWeeks[sortedWeeks.length - 1]!.distance_km +
          sortedWeeks[sortedWeeks.length - 2]!.distance_km;
        const previousDistance =
          sortedWeeks[sortedWeeks.length - 3]!.distance_km +
          sortedWeeks[sortedWeeks.length - 4]!.distance_km;

        if (previousDistance > 0) {
          const change =
            ((recentDistance - previousDistance) / previousDistance) * 100;
          if (change > 15) trend = "increasing significantly";
          else if (change > 5) trend = "increasing";
          else if (change < -15) trend = "decreasing significantly";
          else if (change < -5) trend = "decreasing";
          else trend = "stable";
        }
      } else if (sortedWeeks.length >= 2) {
        trend = "limited data - need 4+ weeks for trend";
      }

      // Generate warnings, always run-based, over run-only weeks (not the
      // whole-body cross-training weeks that only carry load).
      const runWeeks = sortedWeeks.filter((w) => w.runs > 0);
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
          elevation: "m" as const,
        },
      };

      // Format as readable text
      let output = `Training Load Summary\n`;
      output += `${result.period.start_date} to ${result.period.end_date} (${days} days, load source: ${source})\n\n`;

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
