import { z } from "zod";
import { getTimeZone } from "../config";
import {
  type FitnessTrendDay,
  type PlannedLoad,
  type TaperWeek,
} from "../fitnessTrend";
import { loadFitnessTrend } from "../loadFitnessTrend";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import {
  addDays,
  dateInputSchema,
  daysBetween,
  todayLocal,
} from "../utils/localDate";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { FitnessTrendOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-fitness-trend";

const description = `
Returns fitness (CTL, a 42-day load average), fatigue (ATL, 7-day) and form
(TSB, CTL minus ATL: negative is carrying fatigue, positive is fresh) day by
day, and can project them forward or solve a taper. Use it for "am I fresh
for Saturday?", "when does my form turn positive?", taper planning, or
whether a block is digging too deep.

get-wellness and get-training-load also report CTL/ATL/TSB, but only as
recorded values, with no projection or taper. Use view-fitness-trend to show
this as a chart.

Notes:
- By default CTL/ATL come straight from intervals.icu's daily wellness
  record, matching its fitness page, and cover every activity type (some
  may count toward fatigue only, per the athlete's settings; the response
  notes this). A day with no record is a gap, not a zero-load day.
- runOnly computes CTL/ATL locally from Run, TrailRun and VirtualRun load
  only. It is labelled "computed" and will not match the whole-body numbers.
- targetDate returns a week-by-week training-load plan (reduced load, not
  rest) that lands on targetTsb, plus the daily CTL/ATL/TSB it produces. It
  says how much load to spend, not which sessions. If even complete rest
  cannot reach the target in time, the response says so and gives the form
  rest would reach instead of inventing a plan.
- Projections assume rest unless plannedLoads is given. plannedLoads entries
  on or before today, or past the projection, are ignored with a warning.
- as_of is the latest date CTL/ATL is known for; on the default path it can
  lag today until wellness syncs.
`;

const plannedLoadEntrySchema = z.object({
  date: dateInputSchema,
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

const signed = (value: number) => `${value >= 0 ? "+" : ""}${value}`;

function formatDay(day: FitnessTrendDay): string {
  return `  ${day.date}: load ${day.load}, CTL ${day.ctl}, ATL ${day.atl}, TSB ${signed(day.tsb)}`;
}

/** One line per planned week: what to spend, and how that compares to recent. */
function formatTaperWeek(week: TaperWeek): string {
  const span =
    week.days === 1
      ? week.start_date
      : `${week.start_date} to ${week.end_date}`;
  const recent =
    week.pct_of_recent === null
      ? ""
      : `, ${week.pct_of_recent}% of recent weekly load`;
  return `  Week ${week.week} (${span}): ${week.daily_load}/day, ${week.week_load} total${recent}`;
}

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

      const loaded = await loadFitnessTrend(
        apiKey,
        {
          days,
          runOnly,
          projectDays: resolvedProjectDays,
          plannedLoads: typedPlannedLoads,
          taper: targetDate ? { targetDate, targetTsb } : undefined,
        },
        progress,
      );

      const {
        source,
        series: displaySeries,
        current,
        projection,
        tsbPositiveDate,
        taper,
        activityTypesIncluded,
        activitiesIncluded,
        activitiesMissingLoad,
        bands,
        flags,
      } = loaded;

      const warnings: string[] = [
        ...plannedLoadWarnings(typedPlannedLoads, endDate, resolvedProjectDays),
        ...loaded.warnings,
      ];

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
          load: "intervals.icu training load",
        },
      };

      let output = `**Fitness Trend (CTL/ATL/TSB)**\n`;
      output += `${result.period.start_date} to ${result.period.end_date} (${days} days, source: ${source})\n\n`;

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
        output += `**Flags**\n`;
        for (const flag of flags) {
          output += `  - ${flag}\n`;
        }
        output += `\n`;
      }

      if (resolvedProjectDays > 0 && projection.length > 0) {
        output += `**Projection (${resolvedProjectDays} days${typedPlannedLoads ? ", planned load" : ", zero load"})**\n`;
        if (tsbPositiveDate === endDate) {
          output += `  TSB is already positive today (${endDate})\n`;
        } else if (tsbPositiveDate) {
          output += `  TSB returns positive on ${tsbPositiveDate}\n`;
        } else {
          output += `  TSB stays negative for the whole projection\n`;
        }
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
          output += `  Note: ${taper.note}\n`;
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
