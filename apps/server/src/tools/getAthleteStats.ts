import { z } from "zod";
import { getTimeZone } from "../config";
import { formatDuration } from "../formatters";
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
Run totals for the athlete: this week, the last 4 weeks, this month, and
year-to-date, aggregated from intervals.icu activities (Run, TrailRun,
VirtualRun). No inputs. Use it for a quick "how much have I been running"
check, or to answer weekly/monthly volume and pace questions without
aggregating list-activities results by hand.

Each bucket reports run count, distance, moving time, elevation gain,
training load, and average pace computed from total distance / total moving
time.

Notes:
- The week starts Monday in the server's configured time zone
- "This month" is the local calendar month; YTD is from 1 January local
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

/** Re-exported for backward compatibility; canonical home is `utils/localDate`. */
export { startOfWeekMonday };

/** First day of the local calendar month containing `ymd`. */
export function startOfMonth(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

/** 1 January of the local calendar year containing `ymd`. */
export function startOfYear(ymd: string): string {
  return `${ymd.slice(0, 4)}-01-01`;
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

  for (const activity of activities) {
    const type = activity.type ?? "";
    if (!isPaceActivity(type)) continue;
    // Strava stub entries carry no real distance/time/load data through
    // this API (see formatters.ts's STRAVA_STUB_NOTE); counting them would
    // silently understate pace and overstate run count.
    if (activity.source === "STRAVA") continue;
    const date =
      activity.start_date_local.split("T")[0] ?? activity.start_date_local;
    if (date < start || date > end) continue;

    runs += 1;
    distanceM += activity.distance ?? 0;
    movingTimeS += activity.moving_time ?? 0;
    elevationM += activity.total_elevation_gain ?? 0;
    if (activity.icu_training_load != null) load += activity.icu_training_load;
  }

  return {
    runs,
    distance_km: Math.round((distanceM / 1000) * 100) / 100,
    moving_time_s: movingTimeS,
    moving_time: formatDuration(movingTimeS),
    elevation_gain_m: Math.round(elevationM),
    load: Math.round(load),
    average_pace_min_per_km: paceFromDistanceTime(distanceM, movingTimeS),
  };
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

/** Builds the tool's text response. Exported for direct testing. */
export function formatAthleteStatsText(response: AthleteStatsOutput): string {
  return [
    "Run totals",
    formatBucketLine("This week", response.this_week),
    formatBucketLine("Last 4 weeks", response.last_4_weeks),
    formatBucketLine("This month", response.this_month),
    formatBucketLine("YTD", response.ytd),
  ].join("\n");
}

export const getAthleteStatsTool = {
  name,
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
      progress(`Fetching run activities ${fetchOldest} to ${today}`);
      const activities = await listActivitiesClient(apiKey, {
        oldest: fetchOldest,
        newest: today,
      });

      const response: AthleteStatsOutput = {
        this_week: aggregateRunTotals(activities, weekStart, today),
        last_4_weeks: aggregateRunTotals(activities, last4WeeksStart, today),
        this_month: aggregateRunTotals(activities, monthStart, today),
        ytd: aggregateRunTotals(activities, yearStart, today),
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
              context: `fetch run stats through ${today}`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
