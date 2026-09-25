import { z } from "zod";
import { getTimeZone } from "../config";
import {
  buildRunOnlyFitnessTrend,
  computeFlags,
  daysBetween,
  type FitnessTrendDay,
  type PlannedLoad,
  projectFromWellness,
  RUN_ONLY_RUNWAY_DAYS,
  RUN_TYPES,
  type TaperPlan,
  type TaperWeek,
  trendBands,
} from "../fitnessTrend";
import { loadWellnessFitnessSeries } from "../fitnessTrendWellness";
import { listActivities } from "../intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import { addDays, todayLocal } from "../utils/localDate";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { FitnessTrendOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-fitness-trend";

const description = `
Computes the fitness/fatigue/form trend (CTL, ATL, TSB) from intervals.icu.

Two ways to compute it:
- Whole-body (default): reads CTL/ATL straight from intervals.icu's own daily
  wellness record, the same numbers the intervals.icu fitness page shows,
  never recomputed locally (a custom CTL/ATL time constant configured on the
  account is honoured automatically this way). Training load per day is
  whatever intervals.icu itself counted across all logged activity types
  (pace/HR/power load blended per its sport settings). Some activity types
  may count toward fatigue (ATL) only, not fitness (CTL), depending on this
  athlete's intervals.icu settings; see the response note. A day with no
  recorded CTL/ATL is a gap, not a zero-load day, and is reported as such.
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
  do I return to fresh if I rest?" (default: 0, or when plannedLoads is given
  and this is omitted, the number of days out to its latest date, capped at 60)
- plannedLoads (optional): future training load to project with instead of
  assuming rest. Array of { date: YYYY-MM-DD, load }, dates after today;
  any date inside the projection window that is not listed counts as rest
  (zero load); an entry on or before today, or beyond the projection, is
  ignored and named in a warning
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
- Each value is stamped with the local calendar date it was computed for;
  as_of names the most recent date CTL/ATL is actually known for, which for
  the whole-body path can be a day or more behind today if wellness has not
  synced yet
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
      "Project TSB this many days past today (default 0, or when " +
        "plannedLoads is given, the days out to its latest date, capped at 60)",
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
 * `projectDays` when not given explicitly: 0, unless `plannedLoads` is
 * present, in which case the span from `today` out to its latest date
 * (capped at 60, floored at 0 so an all-past plan doesn't go negative).
 */
function resolveProjectDays(
  projectDays: number | undefined,
  plannedLoads: PlannedLoad[] | undefined,
  today: string,
): number {
  if (projectDays !== undefined) return projectDays;
  if (!plannedLoads || plannedLoads.length === 0) return 0;
  const lastDate = plannedLoads.reduce(
    (max, p) => (p.date > max ? p.date : max),
    plannedLoads[0]!.date,
  );
  return Math.min(Math.max(daysBetween(today, lastDate), 0), 60);
}

/** Warns about plannedLoads entries the projection will silently ignore. */
function plannedLoadWarnings(
  plannedLoads: PlannedLoad[] | undefined,
  today: string,
  projectDays: number,
): string[] {
  if (!plannedLoads || plannedLoads.length === 0) return [];
  const warnings: string[] = [];

  const stale = plannedLoads.filter((p) => p.date <= today);
  if (stale.length > 0) {
    warnings.push(
      `plannedLoads has ${stale.length} ${stale.length === 1 ? "entry" : "entries"} on or before today (${today}); only dates after today count toward the projection.`,
    );
  }

  const lastProjected = addDays(today, projectDays);
  const beyond = plannedLoads.filter((p) => p.date > lastProjected);
  if (beyond.length > 0) {
    warnings.push(
      `plannedLoads has ${beyond.length} ${beyond.length === 1 ? "entry" : "entries"} beyond the ${projectDays}-day projection (after ${lastProjected}); they will not be applied.`,
    );
  }

  return warnings;
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
    const typedPlannedLoads = plannedLoads as PlannedLoad[] | undefined;

    try {
      const tz = getTimeZone();
      const endDate = todayLocal(tz);
      const windowStart = addDays(endDate, -(days - 1));
      const resolvedProjectDays = resolveProjectDays(
        projectDays,
        typedPlannedLoads,
        endDate,
      );

      let source: "intervals.icu" | "computed";
      let displaySeries: FitnessTrendDay[];
      let current: FitnessTrendDay | null;
      let projection: FitnessTrendDay[];
      let tsbPositiveDate: string | null;
      let taper: TaperPlan | null;
      let activityTypesIncluded: string[];
      let activitiesIncluded: number;
      let activitiesMissingLoad: number;
      const warnings: string[] = [
        ...plannedLoadWarnings(typedPlannedLoads, endDate, resolvedProjectDays),
      ];

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

        const { trend } = buildRunOnlyFitnessTrend(runActivities, {
          endDate,
          days,
          runwayDays,
          fitnessOptions: {
            projectDays: resolvedProjectDays,
            plannedLoads: typedPlannedLoads,
            taper: targetDate ? { targetDate, targetTsb } : undefined,
          },
        });

        // The runway settles CTL; trim the display (and the bands/flags read
        // off it) back to the requested window.
        displaySeries = trend.days.slice(-days);
        current = trend.current;
        projection = trend.projection;
        tsbPositiveDate = trend.tsbPositiveDate;
        taper = trend.taper;

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
        progress(`Fetching wellness ${windowStart} to ${endDate}…`, {
          important: true,
        });
        const { series, seed, asOfDate, gapDates } =
          await loadWellnessFitnessSeries(apiKey, {
            oldest: windowStart,
            newest: endDate,
          });

        displaySeries = series;
        current =
          series.length > 0
            ? {
                date: series[series.length - 1]!.date,
                load: series[series.length - 1]!.load,
                ctl: series[series.length - 1]!.ctl,
                atl: series[series.length - 1]!.atl,
                tsb: series[series.length - 1]!.tsb,
              }
            : null;

        // Days between the most recent day with recorded CTL/ATL and today:
        // wellness that has not synced yet, not a zero-load day. Always the
        // trailing slice of `gapDates` below, so it is folded into that one
        // warning rather than reported a second time.
        const projected = projectFromWellness(
          { series, seed, asOfDate, endDate },
          {
            projectDays: resolvedProjectDays,
            plannedLoads: typedPlannedLoads,
            taper: targetDate ? { targetDate, targetTsb } : undefined,
          },
        );
        projection = projected.projection;
        tsbPositiveDate = projected.tsbPositiveDate;
        taper = projected.taper;
        warnings.push(...projected.warnings);
        const unsyncedDays = projected.unsyncedDays;

        if (!seed || !asOfDate) {
          if (targetDate || resolvedProjectDays > 0) {
            warnings.push(
              "No wellness CTL/ATL is available in the window, so there is nothing to project or solve a taper from.",
            );
          }
        }

        source = "intervals.icu";
        if (gapDates.length > 0) {
          const plural = gapDates.length !== 1;
          const willProject = resolvedProjectDays > 0 && !targetDate;
          const trailingClause =
            unsyncedDays > 0
              ? ` The most recent ${unsyncedDays} ${unsyncedDays === 1 ? "day" : "days"} ` +
                `(${addDays(asOfDate!, 1)} to ${endDate}) ${unsyncedDays === 1 ? "has" : "have"} not ` +
                `synced yet${willProject ? `; the projection assumes rest for ${unsyncedDays === 1 ? "it" : "them"} before continuing forward` : ""}.`
              : "";
          warnings.push(
            `${gapDates.length} of ${days} day${plural ? "s" : ""} in the window ` +
              `have no wellness CTL/ATL recorded; ${plural ? "those are gaps" : "that is a gap"}, ` +
              `not zero load, and ${plural ? "are" : "is"} left out of the series.` +
              trailingClause,
          );
        }

        progress(`Listing activities ${windowStart} to ${endDate}…`);
        const activities = await listActivities(apiKey, {
          oldest: windowStart,
          newest: endDate,
        });
        const typesWithLoad = new Set(
          activities
            .filter(
              (a) => a.icu_training_load != null && a.icu_training_load !== 0,
            )
            .map((a) => a.type ?? "Unknown"),
        );
        activityTypesIncluded = Array.from(typesWithLoad).sort();
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

      const bands = trendBands(displaySeries);
      const flags = computeFlags(displaySeries);

      if (activitiesIncluded === 0) {
        warnings.push(
          runOnly
            ? "No matching run activities in the window."
            : "No activities in the window.",
        );
      }
      if (taper && taper.days.length > LONG_PLAN_DAYS) {
        warnings.push(
          `${taper.days.length} days is a training block rather than a taper; the plan still steps down each week, so treat its early weeks as maintenance load.`,
        );
      }

      // 7-day delta by date, not array index, since a gappy whole-body
      // series is not necessarily contiguous.
      const byDate = new Map(displaySeries.map((d) => [d.date, d]));
      const weekAgo = current
        ? (byDate.get(addDays(current.date, -7)) ?? null)
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
          start_date: windowStart,
          end_date: endDate,
        },
        source,
        as_of: current?.date ?? null,
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
        projection,
        tsb_positive_date: tsbPositiveDate,
        taper,
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
        output += `**Current (as of ${current.date})**\n`;
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

      if (resolvedProjectDays > 0 && projection.length > 0) {
        output += `**Projection (${resolvedProjectDays} days${typedPlannedLoads ? ", planned load" : ", zero load"})**\n`;
        output += tsbPositiveDate
          ? `  TSB returns positive on ${tsbPositiveDate}\n`
          : `  TSB stays negative for the whole projection\n`;
        const last = projection[projection.length - 1];
        if (last) {
          output += `  End of projection (${last.date}): CTL ${last.ctl}, TSB ${signed(last.tsb)}\n`;
        }
        output += `\n`;
      }

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
