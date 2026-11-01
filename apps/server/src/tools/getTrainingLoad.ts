import { z } from "zod";
import { getTimeZone } from "../config";
import { RUN_ONLY_RUNWAY_DAYS } from "../fitnessTrend";
import { formatDuration, formatSigned } from "../formatters";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import {
  aggregateWeeks,
  baselineWeeks,
  getWeekStart,
  hrZoneRunsLeftOut,
  hrZoneSummary,
  selectRunWeeks,
  volumeTrend,
  type WeekBucket,
  weekDistanceKm,
  weekIsPartial,
  weekLongRun,
} from "../trainingLoad";
import { loadTrainingLoadInputs } from "../trainingLoadInputs";
import {
  dateInputSchema,
  resolveWindowEnd,
  todayLocal,
} from "../utils/localDate";
import { READ_ONLY } from "./_annotations";
import { prefixedErrorText, toolErrorText } from "./_errors";
import { RESPONSE_BUDGET_CHARS } from "./_responseBudget";
import { TrainingLoadOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-training-load";

const description = `
Returns weekly running volume (distance, time, elevation, run count) with a
trend and volume-spike warnings, each week's long run, time in HR zones
(easy/moderate/hard), weekly intervals.icu training load, and current
CTL/ATL/TSB. Use it for "how is my volume trending?", "am I running my
easy days easy?" or "how has my long run built?", or with newest for a past
block.

For the day-by-day CTL/ATL/TSB trend, a projection or a taper, use
get-fitness-trend. For plain totals (this week, month, year), use
get-athlete-stats; to show weekly volume as a chart, view-training-load.

Notes:
- Volume, warnings, long run and HR zones count runs only (Run, TrailRun,
  VirtualRun).
- Load and CTL/ATL/TSB are whole-body by default, from intervals.icu.
  runOnly sums run load only and computes CTL/ATL/TSB locally, labelled
  "computed"; it will not match intervals.icu.
- days is rounded up to whole weeks (Monday start, athlete's time zone), and
  the current week so far is added. Averages and the trend use complete
  weeks only.
- newest ends the window on a past date; CTL/ATL/TSB are then as of its
  last day with data, and a partial last week counts like the current one.
- Weeks with no runs count as zero weeks, a layoff still going on too.
- Zones 1-2 count as easy, 3 moderate, 4+ hard. Runs with no zone times, or
  a different zone count from the newest run's, are left out and counted; a
  week with none reports null, not 0%. The long run is the week's longest
  by distance, with its id and share of the week.
- A warning fires when a week's distance is over 1.5 times the average of
  the 4 complete weeks before it (needs 3, and the 4 weeks before the
  window count). It marks a sharp rise, not a measured injury risk. The
  current week is flagged only on the volume it has.
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
  newest: dateInputSchema
    .optional()
    .describe(
      "Last day of the window (YYYY-MM-DD), today or earlier. Default: " +
        "today. days counts back from it. A past Sunday ends the window " +
        "on a complete week; any other past date ends it on a partial week.",
    ),
});

type GetTrainingLoadInput = z.infer<typeof inputSchema>;

interface ActivitySummary {
  id: string;
  name: string;
  date: string;
  distance_km: number;
}

/** "easy 20% / moderate 30% / hard 50%", the shape both text lines print. */
const intensityText = (i: {
  easy_pct: number;
  moderate_pct: number;
  hard_pct: number;
}) => `easy ${i.easy_pct}% / moderate ${i.moderate_pct}% / hard ${i.hard_pct}%`;

/** The summary snake_cased for the wire: `hr_zone_s` and `intensity`, each null with no run HR data. */
function zoneFields(buckets: WeekBucket[]) {
  const zones = hrZoneSummary(buckets);
  return {
    hr_zone_s: zones?.seconds.map(Math.round) ?? null,
    intensity: zones && {
      easy_pct: zones.intensity.easyPct,
      moderate_pct: zones.intensity.moderatePct,
      hard_pct: zones.intensity.hardPct,
    },
  };
}

/** Room the text needs next to the JSON, used to size the run lists before it is built. */
const TEXT_BASE_CHARS = 1_500;
const TEXT_WEEK_CHARS = 200;

const localDay = (isoDateTime: string) => isoDateTime.split("T")[0]!;

const leftOutText = (n: number) =>
  n > 0
    ? ` (${plural(n, "run")} left out: no HR zone times, or a different zone count)`
    : "";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const getTrainingLoadTool = {
  name,
  title: "Training load",
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: TrainingLoadOutputSchema,
  execute: async (
    { days, runOnly, newest }: GetTrainingLoadInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    try {
      // Refused before any fetch: intervals.icu has no records after today.
      const end = resolveWindowEnd(newest, todayLocal(getTimeZone()));
      if ("error" in end) {
        return {
          content: [
            { type: "text" as const, text: prefixedErrorText(end.error) },
          ],
          isError: true,
        };
      }

      const {
        lookback,
        runs: runActivities,
        baselineRuns,
        loadActivities,
        current,
        source,
        activityTypesIncluded,
      } = await loadTrainingLoadInputs(
        apiKey,
        { days, runOnly, end },
        progress,
      );

      // The one shared weekly timeline (trainingLoad.ts's aggregateWeeks):
      // from the first week with a run or load to the window's last week, so
      // this tool and the training-load MCP App feed can never report
      // different weekly or total load for the same activities.
      const buckets = aggregateWeeks(
        runActivities,
        loadActivities,
        lookback.lastWeekStart,
      );

      // Individual run activities per week, for the `activities` list this
      // text tool carries that the app feed does not.
      const activitiesByWeek = new Map<string, ActivitySummary[]>();
      const dateById = new Map<string, string>();
      for (const activity of runActivities) {
        dateById.set(activity.id, localDay(activity.start_date_local));
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

      const sortedWeeks = buckets.map((bucket) => {
        const longRun = weekLongRun(bucket);
        return {
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
          ...zoneFields([bucket]),
          long_run_km: longRun?.km ?? null,
          long_run_id: longRun?.id ?? null,
          long_run_pct: longRun?.pct ?? null,
          activities: activitiesByWeek.get(bucket.weekStarting) ?? [],
        };
      });

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
      // week yet, the averages fall back to the partial week.
      const runWeeks = selectRunWeeks(
        buckets,
        lookback.partialWeekStart,
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

      // A past window's last week is not "in progress": it is cut off at
      // newest. Today's week is in progress even on a Sunday.
      const pastWindow = !lookback.endsToday;
      const warnings = pastWindow
        ? [
            `This window ends on ${end.endDate}, before today (${end.today}). ` +
              "It is a past block: CTL/ATL/TSB are as of its last day with data, not today.",
          ]
        : [];
      warnings.push(
        ...runWeeks.warnings.map(
          (w) => `Week of ${w.week_starting}: ${w.reason}`,
        ),
      );
      const partialWeek = sortedWeeks.find((w) =>
        weekIsPartial(w.week_starting, lookback.partialWeekStart),
      );
      if (partialWeek) {
        warnings.push(
          `Week of ${partialWeek.week_starting} is ` +
            (pastWindow
              ? `partial (${lookback.lastWeekDays} of 7 days, to ${lookback.endDate})`
              : `in progress (${lookback.lastWeekDays} of 7 days)`) +
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
        // The window read, whole weeks plus the partial last week, if any:
        // `days` is its length, so it can be longer than the requested days.
        period: {
          days: lookback.spanDays,
          start_date: lookback.startDate,
          end_date: lookback.endDate,
          ends_today: lookback.endsToday,
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
          ...zoneFields(buckets),
          hr_zone_runs_left_out: hrZoneRunsLeftOut(buckets),
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

      // A year of weeks outgrows RESPONSE_BUDGET_CHARS with a run list on
      // every week, so the oldest weeks' lists go first. Their totals and
      // long run id stay; list-activities has the runs.
      let excess =
        JSON.stringify(result).length +
        TEXT_BASE_CHARS +
        TEXT_WEEK_CHARS * sortedWeeks.length -
        RESPONSE_BUDGET_CHARS;
      let trimmedWeeks = 0;
      for (const week of sortedWeeks) {
        if (excess <= 0) break;
        if (week.activities.length === 0) continue;
        excess -= JSON.stringify(week.activities).length - 2;
        week.activities = [];
        trimmedWeeks += 1;
      }
      if (trimmedWeeks > 0) {
        warnings.push(
          `The run lists of the first ${plural(trimmedWeeks, "week")} are left out to keep the response small: their long_run_id still names each longest run. Use list-activities for the runs.`,
        );
      }

      // Format as readable text
      const weeksRead = plural(lookback.completeWeeks, "complete week");
      const lastWeekRead = !pastWindow
        ? " and this week so far"
        : lookback.partialWeekStart
          ? ` and a partial week of ${plural(lookback.lastWeekDays, "day")}`
          : "";
      let output = `Training Load Summary\n`;
      output += `${result.period.start_date} to ${result.period.end_date} (${weeksRead}${lastWeekRead}, CTL/ATL source: ${source})\n\n`;

      output += `Totals\n`;
      output += `  Runs: ${result.totals.runs}\n`;
      output += `  Distance: ${result.totals.distance_km} km\n`;
      // From the seconds total, in the same h:mm:ss form as the weekly lines.
      // Minutes split out of the rounded hours carried the rounding error
      // (#76).
      output += `  Time: ${formatDuration(result.totals.time_s)}\n`;
      output += `  Elevation: ${result.totals.elevation_m} m\n`;
      output += `  Load: ${result.totals.load} (${activityTypesIncluded.join(", ") || "none"})\n`;
      output += `  Run HR zones: ${
        result.totals.intensity
          ? intensityText(result.totals.intensity)
          : "no run has HR zone times"
      }${leftOutText(result.totals.hr_zone_runs_left_out)}\n\n`;

      if (current) {
        output += `${pastWindow ? "End of window" : "Current"} (as of ${current.date})\n`;
        output += `  Fitness (CTL): ${current.ctl}\n`;
        output += `  Fatigue (ATL): ${current.atl}\n`;
        output += `  Form (TSB): ${formatSigned(current.tsb)}\n\n`;
      }

      const averagedOver =
        runWeeks.complete.length > 0
          ? plural(runWeeks.complete.length, "complete week")
          : runWeeks.span.length > 0
            ? pastWindow
              ? "the partial week"
              : "this week so far"
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
          week === partialWeek
            ? ` (${pastWindow ? "partial" : "in progress"}, ${lookback.lastWeekDays} of 7 days)`
            : "";
        const longRunDate = dateById.get(week.long_run_id ?? "");
        output += `  Week of ${week.week_starting}${label}: ${week.runs} runs, ${week.distance_km} km, ${week.time_formatted}, load ${week.load}`;
        if (week.intensity) output += `, ${intensityText(week.intensity)}`;
        if (longRunDate) {
          output += `, long run ${week.long_run_km} km on ${longRunDate} (${week.long_run_pct}% of the week, ${week.long_run_id})`;
        }
        output += `\n`;
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
              context: `fetch training load for ${days} days${newest ? ` to ${newest}` : ""}`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
