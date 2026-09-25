import { z } from "zod";
import {
  addDays,
  buildFitnessTrend,
  type FitnessTrendDay,
  type FitnessTrendLoadDay,
  type TaperWeek,
} from "../fitnessTrend";
import { listingProgress, NO_PROGRESS, type ReportProgress } from "../progress";
import { getAllActivities } from "../stravaClient";
import { READ_ONLY } from "./_annotations";
import { FitnessTrendOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-fitness-trend";

const description = `
Computes the fitness/fatigue/form trend (CTL, ATL, TSB) from Strava relative effort.

This tool builds the classic performance-management chart from the relative
effort (suffer score) already present on the activity list — no per-activity
fetches:
- CTL ("fitness"): 42-day exponentially weighted average of daily load
- ATL ("fatigue"): 7-day exponentially weighted average of daily load
- TSB ("form"): CTL − ATL. Negative = carrying fatigue, positive = fresh

Use Cases:
- "When does my form (TSB) return positive, and does it align with my next quality day?"
- Judge whether a training block is digging too deep (sustained very negative TSB)
- Plan a taper: "my race is on 2026-09-13 — what should the next three weeks
  look like so I arrive at TSB +10 instead of overcooked or detrained?"
  (pass targetDate, and targetTsb if you want something other than +10)

Parameters:
- days (optional): lookback window (default 90, max 365). CTL starts from zero
  at the window start, so keep this ≥ 90 for settled values
- activityTypes (optional): activity types to include. Omit to include ALL
  activities — relative effort is HR-based and cross-sport, so whole-body load
  is usually what you want. Pass e.g. ["Run"] to isolate one sport
- projectDays (optional, default 0, max 60): also project TSB forward assuming
  zero load, answering "when do I return to fresh if I rest?"
- targetDate (optional, YYYY-MM-DD): solve a load taper landing on targetTsb on
  this date. Returns a week-by-week relative-effort plan (each week stepped down
  toward the date, and compared to what the athlete has recently been averaging)
  plus the daily CTL/ATL/TSB it produces. Reduced load, not rest
- targetTsb (optional, default 10): form to arrive at on targetDate. +5 to +15
  is the usual race window; higher means fresher but more fitness shed

Notes:
- A taper that even complete rest cannot reach in time is reported as such,
  with the form rest would actually land on — the tool does not invent a plan
- The taper plan is prescriptive load, not recorded load: it says how much
  relative effort to spend, not which sessions to spend it in
- Values are directionally consistent with TRIMP-based CTL/ATL from other
  platforms but not absolutely comparable (relative effort ≠ TRIMP)
- Activities without a relative effort (no HR recorded) contribute zero load
  and are counted in the response so the gap is visible
- Each value is stamped with the local calendar date it was computed for
`;

const inputSchema = z.object({
  days: z
    .number()
    .int()
    .positive()
    .max(365)
    .default(90)
    .describe(
      "Days to look back (default 90; CTL needs ~90 days of runway, max 365)",
    ),
  activityTypes: z
    .array(z.string())
    .optional()
    .describe(
      "Activity types to include (e.g. ['Run', 'TrailRun']). Omit for all types — cross-sport load is usually what TSB should reflect.",
    ),
  projectDays: z
    .number()
    .int()
    .min(0)
    .max(60)
    .default(0)
    .describe(
      "Project TSB this many days forward assuming zero load (default 0 = no projection)",
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

/** Minimal slice of a Strava activity the load mapping needs. */
interface StravaLoadActivity {
  start_date: string;
  start_date_local?: string;
  suffer_score?: number | null;
}

/**
 * Temporary Strava-to-input mapping: sums relative effort per local day and
 * feeds it to both the CTL and ATL load series, since Strava's suffer_score
 * has no source split the way intervals.icu's ctlLoad/atlLoad do. Ported to
 * the real split in Task 3.
 */
function stravaLoadDays(
  activities: StravaLoadActivity[],
  endDate: string,
  days: number,
): FitnessTrendLoadDay[] {
  const loads = new Map<string, number>();
  for (const activity of activities) {
    const day = (activity.start_date_local || activity.start_date).split(
      "T",
    )[0]!;
    loads.set(day, (loads.get(day) ?? 0) + (activity.suffer_score ?? 0));
  }
  const start = addDays(endDate, -(days - 1));
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(start, i);
    const load = loads.get(date) ?? 0;
    return { date, ctlLoad: load, atlLoad: load };
  });
}

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

export const getFitnessTrendTool = {
  name,
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: FitnessTrendOutputSchema,
  execute: async (
    {
      days,
      activityTypes,
      projectDays,
      targetDate,
      targetTsb,
    }: GetFitnessTrendInput,
    token: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    try {
      console.error(`Fetching fitness trend for last ${days} days...`);

      const endDate = new Date();
      const startDate = new Date(
        endDate.getTime() - days * 24 * 60 * 60 * 1000,
      );

      progress("Listing activities…", { important: true });
      const allActivities = await getAllActivities(token, {
        after: Math.floor(startDate.getTime() / 1000),
        before: Math.floor(endDate.getTime() / 1000),
        onProgress: listingProgress(progress),
      });

      const activities =
        activityTypes && activityTypes.length > 0
          ? allActivities.filter((a) =>
              activityTypes.includes(a.type ?? a.sport_type ?? ""),
            )
          : allActivities;

      const missingLoad = activities.filter(
        (a) => a.suffer_score == null,
      ).length;

      const endDay = endDate.toISOString().split("T")[0]!;
      const trend = buildFitnessTrend(
        { days: stravaLoadDays(activities, endDay, days) },
        {
          projectDays,
          taper: targetDate ? { targetDate, targetTsb } : undefined,
        },
      );

      const warnings: string[] = [];
      if (activities.length === 0) {
        warnings.push(
          "No matching activities in the window — the trend is all zeros.",
        );
      } else if (missingLoad > 0) {
        warnings.push(
          `${missingLoad} of ${activities.length} activities have no relative effort (no heart rate?) and contributed zero load.`,
        );
      }
      if (days < 90) {
        warnings.push(
          `A ${days}-day window gives CTL little runway (it starts from zero); values early in the window under-read true fitness.`,
        );
      }
      // The taper's own note prints with the plan below rather than in the
      // warning list, so it reads next to the numbers it qualifies.
      if (trend.taper) {
        if (trend.taper.days.length > LONG_PLAN_DAYS) {
          warnings.push(
            `${trend.taper.days.length} days is a training block rather than a taper — the plan still steps down each week, so treat its early weeks as maintenance load.`,
          );
        }
      }

      // 7-day deltas for a quick direction read.
      const series = trend.days;
      const weekAgo = series.length >= 8 ? series[series.length - 8]! : null;
      const current = trend.current;
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
          start_date: series[0]?.date ?? "",
          end_date: current?.date ?? "",
        },
        current: current
          ? {
              date: current.date,
              ctl: current.ctl,
              atl: current.atl,
              tsb: current.tsb,
            }
          : null,
        trend: trendSummary,
        flags: trend.flags,
        bands: trend.bands,
        warnings,
        daily: series,
        projection: trend.projection,
        tsb_positive_date: trend.tsbPositiveDate,
        taper: trend.taper,
        activities_included: activities.length,
        activities_missing_load: missingLoad,
      };

      let output = `📈 **Fitness Trend (CTL/ATL/TSB)**\n`;
      output += `📅 ${result.period.start_date} to ${result.period.end_date} (${days} days, ${activities.length} activities)\n\n`;

      if (current) {
        output += `**Current (${current.date})**\n`;
        output += `  Fitness (CTL): ${current.ctl}\n`;
        output += `  Fatigue (ATL): ${current.atl}\n`;
        output += `  Form (TSB): ${signed(current.tsb)}\n\n`;
      }

      if (trendSummary) {
        output += `**Last 7 days**: CTL ${signed(trendSummary.ctl_7d_delta)}, TSB ${signed(trendSummary.tsb_7d_delta)}\n\n`;
      }

      if (trend.flags.length > 0) {
        output += `**⚠️ Flags**\n`;
        for (const flag of trend.flags) {
          output += `  - ${flag}\n`;
        }
        output += `\n`;
      }

      if (projectDays > 0) {
        output += `**Rest projection (${projectDays} days, zero load)**\n`;
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

      const recent = series.slice(-14);
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
      output += `Note: relative-effort CTL/ATL is directionally consistent with TRIMP-based values, not absolutely comparable.\n`;

      console.error(`Successfully generated fitness trend for ${days} days`);

      warnOnSchemaDrift(name, FitnessTrendOutputSchema, result);

      return {
        content: [{ type: "text" as const, text: output }],
        structuredContent: result,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`Error fetching fitness trend: ${errorMessage}`);

      return {
        content: [
          {
            type: "text" as const,
            text: `❌ An unexpected error occurred while computing the fitness trend. Details: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  },
};
