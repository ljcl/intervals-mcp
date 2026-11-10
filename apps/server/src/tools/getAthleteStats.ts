import { z } from "zod";
import { getTimeZone } from "../config";
import { formatDuration, round } from "../formatters";
import {
  type IntervalsActivity,
  listActivities as listActivitiesClient,
} from "../intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import {
  addDays,
  dateInputSchema,
  startOfWeekMonday,
  todayLocal,
  validateRange,
} from "../utils/localDate";
import { isPaceActivity, paceFromDistanceTime } from "../utils/running";
import { READ_ONLY } from "./_annotations";
import { prefixedErrorText, toolErrorText } from "./_errors";
import { RESPONSE_BUDGET_CHARS, responseSize } from "./_responseBudget";
import {
  type AthleteStatsOutput,
  AthleteStatsOutputSchema,
  warnOnSchemaDrift,
} from "./outputs";

const name = "get-athlete-stats";

const description = `
Returns training totals for this week, the last 4 weeks, this month, the
year to date and the same dates last year, plus any oldest/newest range (a
month, a year, a training block), in two sets. Run totals: run count,
distance, moving time, elevation gain, training load, average pace and the
longest run. All-sports totals: count, moving time, distance and load for
each activity type, and a total. The text prints the change against last
year to date. Use it for "how far did I run in March?", "what was my
longest run this year?" or "how many strength sessions this month?" instead
of adding up list-activities.

For weekly volume trends and volume-spike warnings, use get-training-load.
For fitness, fatigue and form (CTL/ATL/TSB), use get-fitness-trend.

Notes:
- Run totals count Run, TrailRun and VirtualRun only, and their load is
  run-only.
- All-sports totals count every activity except Strava stubs (below). Each
  type is keyed by its intervals.icu name, for example Run, TrailRun,
  WeightTraining or Swim.
- One sport can have several types, for example Swim and OpenWaterSwim, or
  Ride, VirtualRide and GravelRide. Add their rows for the sport's total.
- The all-sports load is whole-body: the type loads add up to it. Say which
  load a number is: run totals' load counts runs only, all_sports total.load
  counts every type.
- A type with no recorded distance (for example WeightTraining) has
  distance_km null.
- Activities synced from Strava are left out: intervals.icu gives no data
  for them through this API.
- Weeks start on Monday in the server's time zone; the month and year are
  local calendar periods.
- last_year_to_date is 1 January last year to today's date last year (29
  February counts as 28 February). Its all-sports set has the total only.
`;

const GetAthleteStatsInputSchema = z.object({
  oldest: dateInputSchema
    .optional()
    .describe(
      "First day (YYYY-MM-DD) of an extra range to total, such as a month, a year or a training block. Any length.",
    ),
  newest: dateInputSchema
    .optional()
    .describe(
      "Last day (YYYY-MM-DD) of that range. Defaults to today; needs oldest.",
    ),
});

type GetAthleteStatsInput = z.infer<typeof GetAthleteStatsInputSchema>;

export interface RunTotals {
  runs: number;
  distance_km: number;
  moving_time_s: number;
  moving_time: string;
  elevation_gain_m: number;
  load: number;
  average_pace_min_per_km: string | null;
  /** kcal over the runs that report calories; calories_missing counts the rest. */
  calories: number;
  calories_missing: number;
  /** The period's run with the most distance; null when no run has one. */
  longest_run: { id: string; date: string; distance_km: number } | null;
}

/** One activity type's totals in a period (`all_sports.<period>.by_type`). */
export interface SportTotals {
  count: number;
  moving_time_s: number;
  /** Null when no activity of this type in the period has a distance above 0. */
  distance_km: number | null;
  load: number;
  /** kcal; null when no activity of this type in the period reports calories. */
  calories: number | null;
}

/** Every activity type's totals in a period (`all_sports.<period>`). */
export interface AllSportsTotals {
  total: {
    count: number;
    moving_time_s: number;
    load: number;
    calories: number;
    calories_missing: number;
  };
  by_type: Record<string, SportTotals>;
}

/**
 * The key for an activity with no type. aggregateWeeks and typesWithLoad
 * (trainingLoad.ts) use the same key, so a type key here matches
 * get-training-load's load_by_type.
 */
const UNKNOWN_TYPE = "Unknown";

/** First day of the local calendar month containing `ymd`. */
export function startOfMonth(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

/** 1 January of the local calendar year containing `ymd`. */
export function startOfYear(ymd: string): string {
  return `${ymd.slice(0, 4)}-01-01`;
}

/** The same month and day one year earlier; 29 February becomes 28 February. */
export function sameDateLastYear(ymd: string): string {
  const monthDay = ymd.slice(5);
  return `${Number(ymd.slice(0, 4)) - 1}-${monthDay === "02-29" ? "02-28" : monthDay}`;
}

/**
 * The activities a period counts: local date in `[start, end]` (both
 * inclusive), Strava stubs left out. aggregateRunTotals and
 * aggregateSportTotals both read through it, so the run rows' count, moving
 * time and load add up to the run totals. Loads and times are whole numbers,
 * as the spec types them; distance can differ by rounding.
 */
function localDate(activity: IntervalsActivity): string {
  return activity.start_date_local.split("T")[0] ?? activity.start_date_local;
}

function activitiesInPeriod(
  activities: IntervalsActivity[],
  start: string,
  end: string,
): IntervalsActivity[] {
  return activities.filter((activity) => {
    // Strava stub entries carry no real distance/time/load data through
    // this API (see formatters.ts's STRAVA_STUB_NOTE); counting them would
    // silently understate pace and overstate counts.
    if (activity.source === "STRAVA") return false;
    const date = localDate(activity);
    return date >= start && date <= end;
  });
}

/**
 * Sums Run/TrailRun/VirtualRun activities whose local date falls in
 * `[start, end]` (both inclusive) into one totals bucket. Exported for direct
 * testing. Average pace comes from total distance / total moving time, not
 * an average of per-activity paces: a bucket's headline pace should reflect
 * its aggregate effort, not be skewed by a handful of short, fast reps.
 */
export function aggregateRunTotals(
  activities: IntervalsActivity[],
  start: string,
  end: string,
): RunTotals {
  let runs = 0;
  let distanceM = 0;
  let movingTimeS = 0;
  let elevationM = 0;
  let load = 0;
  let calories = 0;
  let caloriesMissing = 0;
  let longest: IntervalsActivity | undefined;

  for (const activity of activitiesInPeriod(activities, start, end)) {
    if (!isPaceActivity(activity.type ?? "")) continue;
    if ((activity.distance ?? 0) > (longest?.distance ?? 0)) longest = activity;

    runs += 1;
    distanceM += activity.distance ?? 0;
    movingTimeS += activity.moving_time ?? 0;
    elevationM += activity.total_elevation_gain ?? 0;
    if (activity.icu_training_load != null) load += activity.icu_training_load;
    if (activity.calories != null) calories += activity.calories;
    else caloriesMissing += 1;
  }

  return {
    runs,
    distance_km: round(distanceM / 1000, 2),
    moving_time_s: movingTimeS,
    moving_time: formatDuration(movingTimeS),
    elevation_gain_m: Math.round(elevationM),
    load: Math.round(load),
    average_pace_min_per_km: paceFromDistanceTime(distanceM, movingTimeS),
    calories: Math.round(calories),
    calories_missing: caloriesMissing,
    longest_run: longest
      ? {
          id: longest.id,
          date: localDate(longest),
          distance_km: round((longest.distance ?? 0) / 1000, 2),
        }
      : null,
  };
}

/**
 * Sums every activity whose local date falls in `[start, end]` (both
 * inclusive) by its intervals.icu type. Exported for direct testing. Types
 * are ordered by load (highest first), then moving time, then name; the
 * text lists them in the same order. Each `total` field is the sum of the
 * `by_type` rows, so the type loads always add up to the whole-body load.
 */
export function aggregateSportTotals(
  activities: IntervalsActivity[],
  start: string,
  end: string,
): AllSportsTotals {
  const sums = new Map<
    string,
    {
      count: number;
      movingTimeS: number;
      distanceM: number;
      load: number;
      calories: number | null;
    }
  >();
  // Counted for the total only: per-type counts would crowd the budget.
  let caloriesMissing = 0;
  for (const activity of activitiesInPeriod(activities, start, end)) {
    const type = activity.type ?? UNKNOWN_TYPE;
    const sum = sums.get(type) ?? {
      count: 0,
      movingTimeS: 0,
      distanceM: 0,
      load: 0,
      calories: null,
    };
    sum.count += 1;
    sum.movingTimeS += activity.moving_time ?? 0;
    // A distance of 0 counts as no distance: intervals.icu sends null for a
    // strength session, and another device may send 0.
    if (activity.distance != null && activity.distance > 0) {
      sum.distanceM += activity.distance;
    }
    if (activity.icu_training_load != null) {
      sum.load += activity.icu_training_load;
    }
    if (activity.calories != null) {
      sum.calories = (sum.calories ?? 0) + activity.calories;
    } else caloriesMissing += 1;
    sums.set(type, sum);
  }

  const rows: [string, SportTotals][] = [...sums].map(([type, sum]) => [
    type,
    {
      count: sum.count,
      moving_time_s: Math.round(sum.movingTimeS),
      distance_km: sum.distanceM > 0 ? round(sum.distanceM / 1000, 2) : null,
      load: Math.round(sum.load),
      calories: sum.calories == null ? null : Math.round(sum.calories),
    },
  ]);
  rows.sort(
    ([typeA, a], [typeB, b]) =>
      b.load - a.load ||
      b.moving_time_s - a.moving_time_s ||
      (typeA < typeB ? -1 : typeA > typeB ? 1 : 0),
  );

  // Sum the rounded rows, not the raw values, so the rows always add up to
  // the total.
  const total = {
    count: 0,
    moving_time_s: 0,
    load: 0,
    calories: 0,
    calories_missing: caloriesMissing,
  };
  for (const [, row] of rows) {
    total.count += row.count;
    total.moving_time_s += row.moving_time_s;
    total.load += row.load;
    total.calories += row.calories ?? 0;
  }
  return { total, by_type: Object.fromEntries(rows) };
}

function formatBucketLine(label: string, totals: RunTotals): string {
  const parts = [
    `${totals.runs} runs`,
    `${totals.distance_km.toFixed(2)} km`,
    totals.moving_time,
  ];
  if (totals.average_pace_min_per_km) {
    parts.push(`${totals.average_pace_min_per_km} /km avg`);
  }
  parts.push(`+${totals.elevation_gain_m} m`);
  parts.push(`load ${totals.load}`, caloriesText(totals, totals.runs));
  const longest = totals.longest_run;
  if (longest) {
    parts.push(
      `longest ${longest.distance_km.toFixed(2)} km on ${longest.date} [${longest.id}]`,
    );
  }
  return `${label}: ${parts.join(", ")}`;
}

/** "576 kcal", plus how many activities lacked calories when any did. */
function caloriesText(
  t: { calories: number; calories_missing: number },
  count: number,
) {
  if (count > 0 && t.calories_missing === count) return "no calories";
  const missing =
    t.calories_missing > 0 ? ` (${t.calories_missing} missing)` : "";
  return `${t.calories} kcal${missing}`;
}

function activityCount(count: number): string {
  return `${count} ${count === 1 ? "activity" : "activities"}`;
}

/** One line for the period, then one indented line per type, in `by_type` order. */
function formatSportLines(label: string, totals: AllSportsTotals): string[] {
  const lines = [
    `${label}: ${activityCount(totals.total.count)}, ${formatDuration(totals.total.moving_time_s)}, load ${totals.total.load}, ${caloriesText(totals.total, totals.total.count)}`,
  ];
  for (const [type, row] of Object.entries(totals.by_type)) {
    const parts = [activityCount(row.count)];
    if (row.distance_km != null) {
      parts.push(`${row.distance_km.toFixed(2)} km`);
    }
    parts.push(formatDuration(row.moving_time_s), `load ${row.load}`);
    if (row.calories != null) parts.push(`${row.calories} kcal`);
    lines.push(`  ${type}: ${parts.join(", ")}`);
  }
  return lines;
}

function signed(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? "-" : ""}${Math.abs(n)}`;
}

/** This year's YTD against last year's: the change in each total. */
function formatChangeLine(
  label: string,
  now: { count: number; distanceKm?: number; timeS: number; load: number },
  before: { count: number; distanceKm?: number; timeS: number; load: number },
): string {
  const parts = [`${label} ${signed(now.count - before.count)}`];
  if (now.distanceKm != null && before.distanceKm != null) {
    const km = round(now.distanceKm - before.distanceKm, 2);
    const pct =
      before.distanceKm > 0
        ? ` (${signed(Math.round((km / before.distanceKm) * 100))}%)`
        : "";
    parts.push(`distance ${signed(km)} km${pct}`);
  }
  const dt = now.timeS - before.timeS;
  parts.push(
    `time ${dt < 0 ? "-" : "+"}${formatDuration(Math.abs(dt))}`,
    `load ${signed(now.load - before.load)}`,
  );
  return `YTD change on last year to date: ${parts.join(", ")}`;
}

const PERIOD_LABELS = {
  this_week: "This week",
  last_4_weeks: "Last 4 weeks",
  this_month: "This month",
  ytd: "YTD",
} as const;

/**
 * Builds the tool's text response. Exported for direct testing. Without
 * `fixedTypes`, only the range lists its types, so a range fits the budget.
 */
export function formatAthleteStatsText(
  response: AthleteStatsOutput,
  fixedTypes = true,
): string {
  const run = (t: RunTotals) => ({
    count: t.runs,
    distanceKm: t.distance_km,
    timeS: t.moving_time_s,
    load: t.load,
  });
  const sports = (t: AllSportsTotals["total"]) => ({
    count: t.count,
    timeS: t.moving_time_s,
    load: t.load,
  });
  const range = response.range;
  const rangeLabel = range && `${range.oldest} to ${range.newest}`;
  return [
    "Run totals (run-only load)",
    ...(range && rangeLabel ? [formatBucketLine(rangeLabel, range.runs)] : []),
    formatBucketLine("This week", response.this_week),
    formatBucketLine("Last 4 weeks", response.last_4_weeks),
    formatBucketLine("This month", response.this_month),
    formatBucketLine("YTD", response.ytd),
    formatBucketLine("Last year to date", response.last_year_to_date),
    formatChangeLine(
      "runs",
      run(response.ytd),
      run(response.last_year_to_date),
    ),
    "",
    "All sports (whole-body load)",
    ...(range && rangeLabel
      ? formatSportLines(rangeLabel, range.all_sports)
      : []),
    ...(["this_week", "last_4_weeks", "this_month", "ytd"] as const).flatMap(
      (period) =>
        formatSportLines(PERIOD_LABELS[period], {
          ...response.all_sports[period],
          by_type: fixedTypes ? response.all_sports[period].by_type : {},
        }),
    ),
    ...formatSportLines("Last year to date", {
      ...response.all_sports.last_year_to_date,
      by_type: {},
    }),
    formatChangeLine(
      "activities",
      sports(response.all_sports.ytd.total),
      sports(response.all_sports.last_year_to_date.total),
    ),
  ].join("\n");
}

export const getAthleteStatsTool = {
  name,
  title: "Training totals",
  description,
  inputSchema: GetAthleteStatsInputSchema,
  outputSchema: AthleteStatsOutputSchema,
  annotations: READ_ONLY,
  execute: async (
    input: GetAthleteStatsInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    const tz = getTimeZone();
    const today = todayLocal(tz);
    const weekStart = startOfWeekMonday(today);
    const last4WeeksStart = addDays(today, -27);
    const monthStart = startOfMonth(today);
    const yearStart = startOfYear(today);
    const lastYearEnd = sameDateLastYear(today);
    const lastYearStart = startOfYear(lastYearEnd);
    // The fetch window must cover every bucket. Last year's 1 January is
    // earlier than every other bucket's start, including early January's
    // rolling 28 days.
    const fetchOldest = lastYearStart;

    if (input.newest && !input.oldest) {
      return {
        content: [
          {
            type: "text" as const,
            text: prefixedErrorText(
              "newest needs oldest: give the range's first day too.",
            ),
          },
        ],
        isError: true,
      };
    }
    const range = input.oldest
      ? { oldest: input.oldest, newest: input.newest ?? today }
      : undefined;
    // No length cap: a long range is read in 366-day windows.
    const rangeError =
      range &&
      validateRange(range.oldest, range.newest, Number.POSITIVE_INFINITY);
    if (rangeError) {
      return {
        content: [
          {
            type: "text" as const,
            text: prefixedErrorText(rangeError.message),
          },
        ],
        isError: true,
      };
    }

    try {
      progress(`Fetching activities ${fetchOldest} to ${today}`);
      const activities = await listActivitiesClient(
        apiKey,
        { oldest: fetchOldest, newest: today },
        progress,
      );
      // A range inside the fixed periods' read reuses its rows.
      const rangeActivities =
        range && (range.oldest < fetchOldest || range.newest > today)
          ? await listActivitiesClient(apiKey, range, progress)
          : activities;

      const response: AthleteStatsOutput = {
        this_week: aggregateRunTotals(activities, weekStart, today),
        last_4_weeks: aggregateRunTotals(activities, last4WeeksStart, today),
        this_month: aggregateRunTotals(activities, monthStart, today),
        ytd: aggregateRunTotals(activities, yearStart, today),
        last_year_to_date: aggregateRunTotals(
          activities,
          lastYearStart,
          lastYearEnd,
        ),
        all_sports: {
          this_week: aggregateSportTotals(activities, weekStart, today),
          last_4_weeks: aggregateSportTotals(
            activities,
            last4WeeksStart,
            today,
          ),
          this_month: aggregateSportTotals(activities, monthStart, today),
          ytd: aggregateSportTotals(activities, yearStart, today),
          // Total only: a fifth period of by_type rows would crowd the budget.
          last_year_to_date: {
            total: aggregateSportTotals(activities, lastYearStart, lastYearEnd)
              .total,
          },
        },
        units: { distance: "km", pace: "min/km", time: "s", elevation: "m" },
      };
      if (range) {
        response.range = {
          ...range,
          runs: aggregateRunTotals(rangeActivities, range.oldest, range.newest),
          all_sports: aggregateSportTotals(
            rangeActivities,
            range.oldest,
            range.newest,
          ),
        };
      }

      warnOnSchemaDrift(name, AthleteStatsOutputSchema, response);
      let text = formatAthleteStatsText(response);
      if (responseSize(text, response) > RESPONSE_BUDGET_CHARS) {
        text = `${formatAthleteStatsText(response, false)}\nType rows for the other periods are left out of this text to fit the response size; structuredContent has them.`;
      }

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: response,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: toolErrorText(error, {
              context: `fetch activity totals through ${today}`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
