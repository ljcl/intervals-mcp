import { z } from "zod";
import { getTimeZone } from "../config";
import {
  buildFitnessTrend,
  computeFlags,
  type FitnessTrendDay,
  type FitnessTrendLoadDay,
  type PlannedLoad,
  type TaperWeek,
  trendBands,
} from "../fitnessTrend";
import {
  getWellness,
  type IntervalsActivity,
  listActivities,
} from "../intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import { addDays, todayLocal } from "../utils/localDate";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { FitnessTrendOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-fitness-trend";

/** Run types intervals.icu has no dedicated per-sport CTL/ATL for. */
const RUN_TYPES: readonly string[] = ["Run", "TrailRun", "VirtualRun"];

/**
 * How far before the requested window a run-only computation starts summing
 * load. intervals.icu has no per-sport CTL/ATL, so the run-only series is
 * built locally, zero-seeded, and needs enough runway for the 42-day CTL
 * average to settle before the displayed window starts.
 */
const RUN_ONLY_RUNWAY_DAYS = 150;

/** Fields pulled from wellness, enough to reproduce intervals.icu's own CTL/ATL exactly. */
const WELLNESS_FIELDS = ["id", "ctl", "atl", "ctlLoad", "atlLoad"];

const description = `
Computes the fitness/fatigue/form trend (CTL, ATL, TSB) from intervals.icu.

Two ways to compute it:
- Whole-body (default): reads CTL/ATL straight from intervals.icu's own daily
  wellness record, the same numbers the intervals.icu fitness page shows.
  Training load per day is whatever intervals.icu itself counted across all
  logged activity types (pace/HR/power load blended per its sport settings).
  Some activity types may count toward fatigue (ATL) only, not fitness (CTL),
  depending on this athlete's intervals.icu settings; see the response note.
- Run-only (runOnly: true): intervals.icu has no per-sport CTL/ATL, so this is
  computed locally from the daily sum of icu_training_load across
  Run/TrailRun/VirtualRun activities, zero-seeded well before the requested
  window so the 42-day CTL average has settled. Labeled "computed" and will
  not exactly match the whole-body numbers or intervals.icu's own fitness page.

- CTL ("fitness"): 42-day exponentially weighted average of daily load
- ATL ("fatigue"): 7-day exponentially weighted average of daily load
- TSB ("form"): CTL − ATL. Negative = carrying fatigue, positive = fresh

Use Cases:
- "When does my form (TSB) return positive, and does it align with my next quality day?"
- Judge whether a training block is digging too deep (sustained very negative TSB)
- Compare whole-body fitness/fatigue against a running-only view of the same window
- Plan a taper: "my race is on 2026-09-13 — what should the next three weeks
  look like so I arrive at TSB +10 instead of overcooked or detrained?"
  (pass targetDate, and targetTsb if you want something other than +10)
- Project forward with a specific plan instead of assuming rest (plannedLoads)

Parameters:
- days (optional): lookback window to display (default 90, max 365)
- runOnly (optional, default false): compute CTL/ATL/TSB from running load
  only instead of intervals.icu's whole-body wellness CTL/ATL
- projectDays (optional, max 60): also project TSB forward, answering "when
  do I return to fresh if I rest?" (default 0, or the length of plannedLoads
  when that is given)
- plannedLoads (optional): future training load to project with instead of
  assuming rest. Array of { date: YYYY-MM-DD, load }, dates after today;
  any date inside the projection window that is not listed counts as rest
  (zero load)
- targetDate (optional, YYYY-MM-DD): solve a load taper landing on targetTsb
  on this date. Returns a week-by-week load plan (each week stepped down
  toward the date, compared to what the athlete has recently been averaging)
  plus the daily CTL/ATL/TSB it produces. Reduced load, not rest
- targetTsb (optional, default 10): form to arrive at on targetDate. +5 to +15
  is the usual race window; higher means fresher but more fitness shed

Notes:
- A taper that even complete rest cannot reach in time is reported as such,
  with the form rest would actually land on — the tool does not invent a plan
- The taper plan is prescriptive load, not recorded load: it says how much
  training load to spend, not which sessions to spend it in
- Each value is stamped with the local calendar date it was computed for
`;

const plannedLoadEntrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
    error: "Invalid planned load date. Use YYYY-MM-DD.",
  }),
  load: z.number().nonnegative(),
});

const inputSchema = z.object({
  days: z
    .number()
    .int()
    .positive()
    .max(365)
    .default(90)
    .describe("Days to look back and display (default 90, max 365)"),
  runOnly: z
    .boolean()
    .default(false)
    .describe(
      "Compute CTL/ATL/TSB from Run/TrailRun/VirtualRun training load only, " +
        "computed locally (intervals.icu has no per-sport CTL/ATL). Default " +
        "false reads whole-body CTL/ATL directly from intervals.icu wellness.",
    ),
  projectDays: z
    .number()
    .int()
    .min(0)
    .max(60)
    .optional()
    .describe(
      "Project TSB this many days past today (default 0, or the length of plannedLoads if given)",
    ),
  plannedLoads: z
    .array(plannedLoadEntrySchema)
    .max(60)
    .optional()
    .describe(
      "Planned future training load to project with instead of rest: " +
        "[{ date: YYYY-MM-DD, load }], dates after today. Dates inside the " +
        "projection window that are not listed count as rest (zero).",
    ),
  targetDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, {
      error: "Invalid target date. Use YYYY-MM-DD.",
    })
    .optional()
    .describe(
      "Race or peak date (YYYY-MM-DD) to solve a load taper for. Omit for no taper plan.",
    ),
  targetTsb: z
    .number()
    .min(-40)
    .max(40)
    .default(10)
    .describe(
      "Form (TSB) to arrive at on targetDate (default +10; +5 to +15 is the usual race window)",
    ),
});

type GetFitnessTrendInput = z.infer<typeof inputSchema>;

/** Beyond this the solved plan is a training block, not a taper. */
const LONG_PLAN_DAYS = 28;

const signed = (value: number) => `${value >= 0 ? "+" : ""}${value}`;

function formatDay(day: FitnessTrendDay): string {
  return `  ${day.date}: load ${day.load}, CTL ${day.ctl}, ATL ${day.atl}, TSB ${signed(day.tsb)}`;
}

/** One line per planned week: what to spend, and how that compares to recent. */
function formatTaperWeek(week: TaperWeek): string {
  const span =
    week.days === 1 ? week.start_date : `${week.start_date} → ${week.end_date}`;
  const recent =
    week.pct_of_recent === null
      ? ""
      : ` — ${week.pct_of_recent}% of recent weekly load`;
  return `  Week ${week.week} (${span}): ${week.daily_load}/day, ${week.week_load} total${recent}`;
}

const localDay = (isoDateTime: string) => isoDateTime.split("T")[0]!;

/**
 * Sums `icu_training_load` per local date for the given activities, keyed by
 * `start_date_local`.
 */
function dailyLoadByDate(activities: IntervalsActivity[]): Map<string, number> {
  const loads = new Map<string, number>();
  for (const activity of activities) {
    const date = localDay(activity.start_date_local);
    loads.set(date, (loads.get(date) ?? 0) + (activity.icu_training_load ?? 0));
  }
  return loads;
}

export const getFitnessTrendTool = {
  name,
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: FitnessTrendOutputSchema,
  execute: async (
    {
      days,
      runOnly,
      projectDays,
      plannedLoads,
      targetDate,
      targetTsb,
    }: GetFitnessTrendInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    const resolvedProjectDays =
      projectDays ?? (plannedLoads ? plannedLoads.length : 0);

    try {
      const tz = getTimeZone();
      const endDate = todayLocal(tz);
      const windowStart = addDays(endDate, -(days - 1));

      let series: FitnessTrendLoadDay[];
      let seed: { ctl: number; atl: number } | undefined;
      let source: "intervals.icu" | "computed";
      let activityTypesIncluded: string[];
      let activitiesIncluded: number;
      let activitiesMissingLoad: number;
      const warnings: string[] = [];

      if (runOnly) {
        const runwayDays = days + RUN_ONLY_RUNWAY_DAYS;
        const runwayStart = addDays(endDate, -(runwayDays - 1));

        progress(`Listing activities ${runwayStart} to ${endDate}…`, {
          important: true,
        });
        const activities = await listActivities(apiKey, {
          oldest: runwayStart,
          newest: endDate,
        });
        const runActivities = activities.filter((a) =>
          RUN_TYPES.includes(a.type ?? ""),
        );
        const loadByDate = dailyLoadByDate(runActivities);

        series = Array.from({ length: runwayDays }, (_, i) => {
          const date = addDays(runwayStart, i);
          const load = loadByDate.get(date) ?? 0;
          return { date, ctlLoad: load, atlLoad: load };
        });

        source = "computed";
        activityTypesIncluded = [...RUN_TYPES];
        const inWindow = runActivities.filter((a) => {
          const date = localDay(a.start_date_local);
          return date >= windowStart && date <= endDate;
        });
        activitiesIncluded = inWindow.length;
        activitiesMissingLoad = inWindow.filter(
          (a) => a.icu_training_load == null,
        ).length;

        warnings.push(
          `Run-only CTL/ATL is computed locally from Run/TrailRun/VirtualRun ` +
            `training load, zero-seeded ${RUN_ONLY_RUNWAY_DAYS} days before ` +
            `the window (from ${runwayStart}) so the 42-day CTL average has ` +
            `settled by ${windowStart}; it will not exactly match intervals.icu's ` +
            `own (whole-body) fitness page.`,
        );
      } else {
        const seedDate = addDays(windowStart, -1);

        progress(`Fetching wellness ${seedDate} to ${endDate}…`, {
          important: true,
        });
        const wellness = await getWellness(
          apiKey,
          { oldest: seedDate, newest: endDate },
          { fields: WELLNESS_FIELDS },
        );
        const byDate = new Map(wellness.map((w) => [w.id, w]));

        const seedRow = byDate.get(seedDate);
        seed = { ctl: seedRow?.ctl ?? 0, atl: seedRow?.atl ?? 0 };

        series = Array.from({ length: days }, (_, i) => {
          const date = addDays(windowStart, i);
          const w = byDate.get(date);
          return { date, ctlLoad: w?.ctlLoad ?? 0, atlLoad: w?.atlLoad ?? 0 };
        });

        progress(`Listing activities ${windowStart} to ${endDate}…`);
        const activities = await listActivities(apiKey, {
          oldest: windowStart,
          newest: endDate,
        });
        const typesWithLoad = new Set(
          activities
            .filter((a) => a.icu_training_load != null)
            .map((a) => a.type ?? "Unknown"),
        );
        activityTypesIncluded = Array.from(typesWithLoad).sort();
        source = "intervals.icu";
        activitiesIncluded = activities.length;
        activitiesMissingLoad = activities.filter(
          (a) => a.icu_training_load == null,
        ).length;

        warnings.push(
          "Some activity types (e.g. strength/weight training) may count " +
            "toward fatigue (ATL) only, not fitness (CTL), depending on this " +
            "athlete's intervals.icu settings.",
        );
        if (activitiesMissingLoad > 0) {
          warnings.push(
            `${activitiesMissingLoad} of ${activitiesIncluded} activities in ` +
              "the window have no training load recorded (informational only, " +
              "since whole-body CTL/ATL comes from intervals.icu's own " +
              "wellness data, not summed here).",
          );
        }
      }

      const trend = buildFitnessTrend(
        { days: series, seed },
        {
          projectDays: resolvedProjectDays,
          plannedLoads: plannedLoads as PlannedLoad[] | undefined,
          taper: targetDate ? { targetDate, targetTsb } : undefined,
        },
      );

      // Run-only builds a long runway series to settle CTL; trim the display
      // (and the bands/flags read off it) back to the requested window.
      const displaySeries = runOnly ? trend.days.slice(-days) : trend.days;
      const bands = runOnly ? trendBands(displaySeries) : trend.bands;
      const flags = runOnly ? computeFlags(displaySeries) : trend.flags;

      if (activitiesIncluded === 0) {
        warnings.push(
          runOnly
            ? "No matching run activities in the window."
            : "No activities in the window.",
        );
      }
      if (trend.taper && trend.taper.days.length > LONG_PLAN_DAYS) {
        warnings.push(
          `${trend.taper.days.length} days is a training block rather than a taper; the plan still steps down each week, so treat its early weeks as maintenance load.`,
        );
      }

      // 7-day deltas for a quick direction read.
      const current = trend.current;
      const weekAgo =
        displaySeries.length >= 8
          ? displaySeries[displaySeries.length - 8]!
          : null;
      const trendSummary =
        current && weekAgo
          ? {
              ctl_7d_delta: Math.round((current.ctl - weekAgo.ctl) * 10) / 10,
              tsb_7d_delta: Math.round((current.tsb - weekAgo.tsb) * 10) / 10,
            }
          : null;

      const result = {
        period: {
          days,
          start_date: displaySeries[0]?.date ?? "",
          end_date: current?.date ?? "",
        },
        source,
        current: current
          ? {
              date: current.date,
              ctl: current.ctl,
              atl: current.atl,
              tsb: current.tsb,
            }
          : null,
        trend: trendSummary,
        flags,
        bands,
        warnings,
        daily: displaySeries,
        projection: trend.projection,
        tsb_positive_date: trend.tsbPositiveDate,
        taper: trend.taper,
        activity_types_included: activityTypesIncluded,
        activities_included: activitiesIncluded,
        activities_missing_load: activitiesMissingLoad,
        units: {
          load: "training load (intervals.icu units, unitless)",
        },
      };

      let output = `📈 **Fitness Trend (CTL/ATL/TSB)**\n`;
      output += `📅 ${result.period.start_date} to ${result.period.end_date} (${days} days, source: ${source})\n\n`;

      if (current) {
        output += `**Current (${current.date})**\n`;
        output += `  Fitness (CTL): ${current.ctl}\n`;
        output += `  Fatigue (ATL): ${current.atl}\n`;
        output += `  Form (TSB): ${signed(current.tsb)}\n\n`;
      }

      if (trendSummary) {
        output += `**Last 7 days**: CTL ${signed(trendSummary.ctl_7d_delta)}, TSB ${signed(trendSummary.tsb_7d_delta)}\n\n`;
      }

      if (flags.length > 0) {
        output += `**⚠️ Flags**\n`;
        for (const flag of flags) {
          output += `  - ${flag}\n`;
        }
        output += `\n`;
      }

      if (resolvedProjectDays > 0) {
        output += `**Projection (${resolvedProjectDays} days${plannedLoads ? ", planned load" : ", zero load"})**\n`;
        output += trend.tsbPositiveDate
          ? `  TSB returns positive on ${trend.tsbPositiveDate}\n`
          : `  TSB stays negative for the whole projection\n`;
        const last = trend.projection[trend.projection.length - 1];
        if (last) {
          output += `  End of projection (${last.date}): CTL ${last.ctl}, TSB ${signed(last.tsb)}\n`;
        }
        output += `\n`;
      }

      const taper = trend.taper;
      if (taper) {
        output += `**Taper plan to ${taper.target_date} (target TSB ${signed(taper.target_tsb)})**\n`;
        if (taper.weeks.length > 0) {
          for (const week of taper.weeks) {
            output += `${formatTaperWeek(week)}\n`;
          }
          const landing = taper.days[taper.days.length - 1]!;
          output += `  Lands ${landing.date}: CTL ${landing.ctl}, ATL ${landing.atl}, TSB ${signed(landing.tsb)}\n`;
          output += `  Total planned load ${taper.total_load}`;
          output +=
            taper.recent_daily_load > 0
              ? ` (recent average ${taper.recent_daily_load}/day)\n`
              : `\n`;
        }
        if (!taper.feasible) {
          output += `  ⚠️ ${taper.note}\n`;
        }
        output += `\n`;
      }

      const recent = displaySeries.slice(-14);
      if (recent.length > 0) {
        output += `**Last ${recent.length} days** (full series in structured output)\n`;
        for (const day of recent) {
          output += `${formatDay(day)}\n`;
        }
        output += `\n`;
      }

      for (const warning of warnings) {
        output += `Note: ${warning}\n`;
      }

      warnOnSchemaDrift(name, FitnessTrendOutputSchema, result);

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
              context: `compute fitness trend for ${days} days`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
