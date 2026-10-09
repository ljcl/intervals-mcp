import { z } from "zod";
import { getTimeZone } from "../config";
import { formatDuration, round } from "../formatters";
import {
  type IntervalsActivity,
  listActivities as listActivitiesClient,
} from "../intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import { addDays, startOfWeekMonday, todayLocal } from "../utils/localDate";
import { isPaceActivity, paceFromDistanceTime } from "../utils/running";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import {
  type AthleteStatsOutput,
  AthleteStatsOutputSchema,
  warnOnSchemaDrift,
} from "./outputs";

const name = "get-athlete-stats";

const description = `
Returns training totals for this week, the last 4 weeks, this month and the
year to date, in two sets. Run totals: run count, distance, moving time,
elevation gain, training load and average pace. All-sports totals: count,
moving time, distance and training load for each activity type, and a
total for all types together. No inputs. Use it for "how much have I been
running?", "how many strength sessions did I do this month?" or "how far
have I swum this year?" instead of adding up list-activities.

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
`;

const GetAthleteStatsInputSchema = z.object({});

type GetAthleteStatsInput = z.infer<typeof GetAthleteStatsInputSchema>;

export interface RunTotals {
  runs: number;
  distance_km: number;
  moving_time_s: number;
  moving_time: string;
  elevation_gain_m: number;
  load: number;
  average_pace_min_per_km: string | null;
}

/** One activity type's totals in a period (`all_sports.<period>.by_type`). */
export interface SportTotals {
  count: number;
  moving_time_s: number;
  /** Null when no activity of this type in the period has a distance above 0. */
  distance_km: number | null;
  load: number;
}

/** Every activity type's totals in a period (`all_sports.<period>`). */
export interface AllSportsTotals {
  total: { count: number; moving_time_s: number; load: number };
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

/**
 * The activities a period counts: local date in `[start, end]` (both
 * inclusive), Strava stubs left out. aggregateRunTotals and
 * aggregateSportTotals both read through it, so the run rows' count, moving
 * time and load add up to the run totals. Loads and times are whole numbers,
 * as the spec types them; distance can differ by rounding.
 */
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
    const date =
      activity.start_date_local.split("T")[0] ?? activity.start_date_local;
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

  for (const activity of activitiesInPeriod(activities, start, end)) {
    if (!isPaceActivity(activity.type ?? "")) continue;

    runs += 1;
    distanceM += activity.distance ?? 0;
    movingTimeS += activity.moving_time ?? 0;
    elevationM += activity.total_elevation_gain ?? 0;
    if (activity.icu_training_load != null) load += activity.icu_training_load;
  }

  return {
    runs,
    distance_km: round(distanceM / 1000, 2),
    moving_time_s: movingTimeS,
    moving_time: formatDuration(movingTimeS),
    elevation_gain_m: Math.round(elevationM),
    load: Math.round(load),
    average_pace_min_per_km: paceFromDistanceTime(distanceM, movingTimeS),
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
    { count: number; movingTimeS: number; distanceM: number; load: number }
  >();
  for (const activity of activitiesInPeriod(activities, start, end)) {
    const type = activity.type ?? UNKNOWN_TYPE;
    const sum = sums.get(type) ?? {
      count: 0,
      movingTimeS: 0,
      distanceM: 0,
      load: 0,
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
    sums.set(type, sum);
  }

  const rows: [string, SportTotals][] = [...sums].map(([type, sum]) => [
    type,
    {
      count: sum.count,
      moving_time_s: Math.round(sum.movingTimeS),
      distance_km: sum.distanceM > 0 ? round(sum.distanceM / 1000, 2) : null,
      load: Math.round(sum.load),
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
  const total = { count: 0, moving_time_s: 0, load: 0 };
  for (const [, row] of rows) {
    total.count += row.count;
    total.moving_time_s += row.moving_time_s;
    total.load += row.load;
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
  parts.push(`load ${totals.load}`);
  return `${label}: ${parts.join(", ")}`;
}

function activityCount(count: number): string {
  return `${count} ${count === 1 ? "activity" : "activities"}`;
}

/** One line for the period, then one indented line per type, in `by_type` order. */
function formatSportLines(label: string, totals: AllSportsTotals): string[] {
  const lines = [
    `${label}: ${activityCount(totals.total.count)}, ${formatDuration(totals.total.moving_time_s)}, load ${totals.total.load}`,
  ];
  for (const [type, row] of Object.entries(totals.by_type)) {
    const parts = [activityCount(row.count)];
    if (row.distance_km != null) {
      parts.push(`${row.distance_km.toFixed(2)} km`);
    }
    parts.push(formatDuration(row.moving_time_s), `load ${row.load}`);
    lines.push(`  ${type}: ${parts.join(", ")}`);
  }
  return lines;
}

/** Builds the tool's text response. Exported for direct testing. */
export function formatAthleteStatsText(response: AthleteStatsOutput): string {
  return [
    "Run totals (run-only load)",
    formatBucketLine("This week", response.this_week),
    formatBucketLine("Last 4 weeks", response.last_4_weeks),
    formatBucketLine("This month", response.this_month),
    formatBucketLine("YTD", response.ytd),
    "",
    "All sports (whole-body load)",
    ...formatSportLines("This week", response.all_sports.this_week),
    ...formatSportLines("Last 4 weeks", response.all_sports.last_4_weeks),
    ...formatSportLines("This month", response.all_sports.this_month),
    ...formatSportLines("YTD", response.all_sports.ytd),
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
    _input: GetAthleteStatsInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    const tz = getTimeZone();
    const today = todayLocal(tz);
    const weekStart = startOfWeekMonday(today);
    const last4WeeksStart = addDays(today, -27);
    const monthStart = startOfMonth(today);
    const yearStart = startOfYear(today);
    // The fetch window must cover every bucket. YTD needs 1 January; early
    // January's rolling 28-day bucket needs further back than that.
    const fetchOldest =
      yearStart < last4WeeksStart ? yearStart : last4WeeksStart;

    try {
      progress(`Fetching activities ${fetchOldest} to ${today}`);
      const activities = await listActivitiesClient(
        apiKey,
        { oldest: fetchOldest, newest: today },
        progress,
      );

      const response: AthleteStatsOutput = {
        this_week: aggregateRunTotals(activities, weekStart, today),
        last_4_weeks: aggregateRunTotals(activities, last4WeeksStart, today),
        this_month: aggregateRunTotals(activities, monthStart, today),
        ytd: aggregateRunTotals(activities, yearStart, today),
        all_sports: {
          this_week: aggregateSportTotals(activities, weekStart, today),
          last_4_weeks: aggregateSportTotals(
            activities,
            last4WeeksStart,
            today,
          ),
          this_month: aggregateSportTotals(activities, monthStart, today),
          ytd: aggregateSportTotals(activities, yearStart, today),
        },
        units: { distance: "km", pace: "min/km", time: "s", elevation: "m" },
      };

      warnOnSchemaDrift(name, AthleteStatsOutputSchema, response);

      return {
        content: [
          { type: "text" as const, text: formatAthleteStatsText(response) },
        ],
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
