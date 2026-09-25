/**
 * Pure training-load aggregation shared by the `get-training-load` text tool
 * and the `get-training-load-data` MCP App feed. The injury-risk
 * warning rules live here once, so the chart's per-week flags can never
 * drift from the text tool's prose warnings.
 */
import { RUN_TYPES } from "./fitnessTrend";
import { addDays, startOfWeekMonday } from "./utils/localDate";

/**
 * Monday-start week key (YYYY-MM-DD) for a local calendar date. `localDate`
 * is a plain `YYYY-MM-DD` date, or an ISO datetime string whose date portion
 * is used (e.g. an intervals.icu `start_date_local`), never re-interpreted
 * through a `Date` object's own time zone, so the week boundary matches the
 * athlete's local calendar day exactly as intervals.icu reported it.
 */
export function getWeekStart(localDate: string): string {
  return startOfWeekMonday(localDate.split("T")[0]!);
}

export interface WeeklyVolume {
  week_starting: string;
  distance_km: number;
}

export interface WeekWarning {
  week_starting: string;
  reason: string;
}

/**
 * Injury-risk warnings per week: a >30% week-over-week volume increase, and
 * an unusually high week (>150% of the period average and over 30 km). One
 * week can trigger both rules. The text tool prefixes each reason with
 * "Week of <date>: "; the app feed attaches them to the week's row.
 */
export function computeWeekWarnings(weeks: WeeklyVolume[]): WeekWarning[] {
  const warnings: WeekWarning[] = [];

  if (weeks.length < 2) {
    return warnings;
  }

  // Check for sudden volume increases (>30% week over week)
  for (let i = 1; i < weeks.length; i += 1) {
    const prevDist = weeks[i - 1]!.distance_km;
    const currDist = weeks[i]!.distance_km;

    if (prevDist > 0 && currDist > prevDist * 1.3) {
      const increase = Math.round((currDist / prevDist - 1) * 100);
      warnings.push({
        week_starting: weeks[i]!.week_starting,
        reason: `Volume increased ${increase}% from previous week - consider injury risk`,
      });
    }
  }

  // Check for very high weeks compared to average
  const avgDistance =
    weeks.reduce((sum, w) => sum + w.distance_km, 0) / weeks.length;

  for (const week of weeks) {
    if (week.distance_km > avgDistance * 1.5 && week.distance_km > 30) {
      warnings.push({
        week_starting: week.week_starting,
        reason: `Unusually high volume (${week.distance_km} km vs ${Math.round(avgDistance)} km average)`,
      });
    }
  }

  return warnings;
}

/**
 * Centered rolling average over a weekly series. Zero weeks count toward the
 * average — a skipped week genuinely lowers the volume trend.
 */
export function rollingTrend(values: number[], window = 3): number[] {
  const half = Math.floor(window / 2);
  return values.map((_, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length - 1, i + half);
    let sum = 0;
    for (let j = lo; j <= hi; j += 1) sum += values[j]!;
    return sum / (hi - lo + 1);
  });
}

/** Minimal slice of an intervals.icu activity the aggregation needs. */
export interface TrainingLoadActivity {
  start_date_local: string;
  start_date?: string | null;
  distance?: number | null;
  moving_time?: number | null;
  total_elevation_gain?: number | null;
  type?: string | null;
  icu_training_load?: number | null;
}

/**
 * Distinct activity types carrying nonzero `icu_training_load`, sorted. The
 * one home `get-training-load`, the training-load app feed, and
 * `get-fitness-trend`'s whole-body path all classify "what load was summed
 * over" through, so the three surfaces can never list different types for
 * the same activities.
 */
export function typesWithLoad(
  activities: Pick<TrainingLoadActivity, "type" | "icu_training_load">[],
): string[] {
  return Array.from(
    new Set(
      activities
        .filter((a) => a.icu_training_load != null && a.icu_training_load !== 0)
        .map((a) => a.type ?? "Unknown"),
    ),
  ).sort();
}

export interface TrainingLoadWeek {
  weekStarting: string;
  runs: number;
  distanceKm: number;
  timeHours: number;
  elevationM: number;
  /** Rolling-average volume for the trend line, in km. */
  trendKm: number;
  warning: boolean;
  warningReasons: string[];
  /** Sum of `icu_training_load` over the included types this week. */
  load: number;
  /** `load` split by activity type. */
  loadByType: Record<string, number>;
}

export interface TrainingLoadAppData {
  days: number;
  totals: {
    runs: number;
    distanceKm: number;
    timeHours: number;
    elevationM: number;
    load: number;
  };
  weeks: TrainingLoadWeek[];
  /** Activity types `load`/`loadByType` are summed over. */
  activityTypesIncluded: string[];
  /** True when load is run-only rather than whole-body. */
  runOnly: boolean;
  /** Most recent CTL/ATL/TSB, when supplied by the caller. */
  current: { date: string; ctl: number; atl: number; tsb: number } | null;
  /** Where `current` came from: intervals.icu wellness, or computed locally (run-only). */
  source: "intervals.icu" | "computed" | null;
}

/** One week's raw (unrounded) totals, keyed by Monday-start date. */
export interface WeekBucket {
  weekStarting: string;
  runs: number;
  distanceM: number;
  timeS: number;
  elevationM: number;
  load: number;
  loadByType: Record<string, number>;
}

/**
 * Builds the weekly timeline both `get-training-load` and
 * `get-training-load-data` read from: a continuous Monday-to-Monday run,
 * spanning from the earliest to the latest week that has either a run
 * activity (`runs`) or a load activity (`loadActivities`); a load-only
 * week (e.g. a strength-only week, or a window with no runs at all) is not
 * dropped, it just carries zeroed run fields, and a run-only week carries
 * zeroed load fields. Any week between the earliest and latest active week
 * with neither is zero-filled too, so the series is gap-visible. The one
 * home this timeline is built through, so the text tool and the app feed
 * can never disagree on a week's load or volume (see AGENTS.md's "derived
 * numbers have exactly one home").
 */
export function aggregateWeeks(
  runs: TrainingLoadActivity[],
  loadActivities: TrainingLoadActivity[],
): WeekBucket[] {
  const emptyBucket = (weekStarting: string): WeekBucket => ({
    weekStarting,
    runs: 0,
    distanceM: 0,
    timeS: 0,
    elevationM: 0,
    load: 0,
    loadByType: {},
  });

  const buckets = new Map<string, WeekBucket>();

  for (const activity of runs) {
    const weekKey = getWeekStart(activity.start_date_local);
    const bucket = buckets.get(weekKey) ?? emptyBucket(weekKey);
    bucket.runs += 1;
    bucket.distanceM += activity.distance || 0;
    bucket.timeS += activity.moving_time || 0;
    bucket.elevationM += activity.total_elevation_gain || 0;
    buckets.set(weekKey, bucket);
  }

  for (const activity of loadActivities) {
    const weekKey = getWeekStart(activity.start_date_local);
    const bucket = buckets.get(weekKey) ?? emptyBucket(weekKey);
    const load = activity.icu_training_load ?? 0;
    const type = activity.type ?? "Unknown";
    bucket.load += load;
    bucket.loadByType[type] = (bucket.loadByType[type] ?? 0) + load;
    buckets.set(weekKey, bucket);
  }

  const sortedKeys = [...buckets.keys()].sort();
  if (sortedKeys.length === 0) return [];

  const weekKeys: string[] = [];
  const last = sortedKeys[sortedKeys.length - 1]!;
  for (let key = sortedKeys[0]!; key <= last; key = addDays(key, 7)) {
    weekKeys.push(key);
  }

  return weekKeys.map((key) => buckets.get(key) ?? emptyBucket(key));
}

export interface BuildTrainingLoadDataOptions {
  /**
   * Activities to sum `icu_training_load` over, per week: all fetched
   * activity types for whole-body load, or the same run activities for
   * run-only load. Defaults to `runs` (run-only), so an omitted option is a
   * run-only call. A week outside the run timeline (e.g. a load-only
   * cross-training week) still appears; see `aggregateWeeks`.
   */
  loadActivities?: TrainingLoadActivity[];
  /** True when `loadActivities` is a run-only set rather than whole-body. */
  runOnly?: boolean;
  /** Most recent CTL/ATL/TSB, computed by the caller (async, off wellness or a run-only fitness trend). */
  current?: { date: string; ctl: number; atl: number; tsb: number } | null;
  source?: "intervals.icu" | "computed";
}

/**
 * Aggregate activities into the chart-ready weekly payload: per-week volume
 * and load from {@link aggregateWeeks} (gap weeks and load-only weeks
 * zero-filled either way, so the timeline is continuous and a skipped week
 * is visible), a rolling-average trend value per week, and the warning
 * flags. Warnings are computed on the weeks that actually had a run, exactly
 * like the text tool, so both surfaces always agree. `runs` drives volume
 * and the warning rules always (they are run-based regardless of
 * `options.runOnly`); `options.loadActivities` (default `runs`) drives
 * `load`/`loadByType`.
 */
export function buildTrainingLoadData(
  runs: TrainingLoadActivity[],
  days: number,
  options: BuildTrainingLoadDataOptions = {},
): TrainingLoadAppData {
  const loadActivities = options.loadActivities ?? runs;
  const runOnly = options.runOnly ?? true;

  const buckets = aggregateWeeks(runs, loadActivities);

  const nonEmptyRunWeeks: WeeklyVolume[] = buckets
    .filter((b) => b.runs > 0)
    .map((b) => ({
      week_starting: b.weekStarting,
      distance_km: Math.round(b.distanceM / 10) / 100,
    }));

  const reasonsByWeek = new Map<string, string[]>();
  for (const warning of computeWeekWarnings(nonEmptyRunWeeks)) {
    const reasons = reasonsByWeek.get(warning.week_starting) ?? [];
    reasons.push(warning.reason);
    reasonsByWeek.set(warning.week_starting, reasons);
  }

  const distances = buckets.map((b) => Math.round(b.distanceM / 10) / 100);
  const trend = rollingTrend(distances);

  const activityTypesIncluded = runOnly
    ? [...RUN_TYPES]
    : typesWithLoad(loadActivities);

  const weeks: TrainingLoadWeek[] = buckets.map((bucket, i) => {
    const warningReasons = reasonsByWeek.get(bucket.weekStarting) ?? [];
    return {
      weekStarting: bucket.weekStarting,
      runs: bucket.runs,
      distanceKm: distances[i]!,
      timeHours: Math.round((bucket.timeS / 3600) * 100) / 100,
      elevationM: Math.round(bucket.elevationM),
      trendKm: Math.round(trend[i]! * 100) / 100,
      warning: warningReasons.length > 0,
      warningReasons,
      load: Math.round(bucket.load),
      loadByType: Object.fromEntries(
        Object.entries(bucket.loadByType).map(([type, load]) => [
          type,
          Math.round(load),
        ]),
      ),
    };
  });

  return {
    days,
    activityTypesIncluded,
    runOnly,
    current: options.current ?? null,
    source: options.source ?? null,
    totals: {
      load: Math.round(weeks.reduce((sum, w) => sum + w.load, 0)),
      runs: weeks.reduce((sum, w) => sum + w.runs, 0),
      distanceKm:
        Math.round(weeks.reduce((sum, w) => sum + w.distanceKm, 0) * 100) / 100,
      timeHours:
        Math.round(weeks.reduce((sum, w) => sum + w.timeHours, 0) * 100) / 100,
      elevationM: weeks.reduce((sum, w) => sum + w.elevationM, 0),
    },
    weeks,
  };
}
