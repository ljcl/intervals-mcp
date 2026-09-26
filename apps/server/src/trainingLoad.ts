/**
 * Pure training-load aggregation shared by the `get-training-load` text tool
 * and the `get-training-load-data` MCP App feed. The week window, the weeks
 * the run-based rules read, and the injury-risk warning rules live here
 * once, so the chart's per-week flags can never drift from the text tool's
 * prose warnings.
 */
import { RUN_TYPES } from "./fitnessTrend";
import { addDays, daysBetween, startOfWeekMonday } from "./utils/localDate";

/**
 * The window both training-load surfaces read: `days` rounded up to whole
 * Monday-to-Sunday weeks, plus the current week so far. Only the current
 * week can be partial, and it is always the last one, so the rules can
 * treat it apart instead of reading a few days as a full week (#43). A
 * 28-day request reads 4 complete weeks plus this week on every weekday,
 * Sunday included, so the trend always has its 4 complete weeks.
 */
export interface TrainingLoadWindow {
  /** Monday of the first complete week. */
  startDate: string;
  /** Today in the athlete's time zone: the last day read. */
  endDate: string;
  /** Monday of the current week, which is still in progress. */
  currentWeekStart: string;
  /** Complete weeks before the current week: `days` rounded up to whole weeks. */
  completeWeeks: number;
  /** Days of the current week so far, today included: 1 on Monday, 7 on Sunday. */
  currentWeekDays: number;
  /** Calendar days from `startDate` to `endDate`, both included. */
  spanDays: number;
}

export function trainingLoadWindow(
  days: number,
  endDate: string,
): TrainingLoadWindow {
  const completeWeeks = Math.ceil(days / 7);
  const currentWeekStart = startOfWeekMonday(endDate);
  const currentWeekDays = daysBetween(currentWeekStart, endDate) + 1;
  return {
    startDate: addDays(currentWeekStart, -7 * completeWeeks),
    endDate,
    currentWeekStart,
    completeWeeks,
    currentWeekDays,
    spanDays: 7 * completeWeeks + currentWeekDays,
  };
}

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
  /** The current week: its volume is only the days so far. */
  in_progress?: boolean;
}

export interface WeekWarning {
  week_starting: string;
  reason: string;
}

/**
 * Injury-risk warnings per week: a >30% week-over-week volume increase, and
 * an unusually high week (>150% of the complete-week average and over 30
 * km). One week can trigger both rules. A week in progress is never the
 * baseline for a rise or part of the average, because its volume is only the
 * days so far. It is flagged only when that partial volume already breaks a
 * rule, which the rest of the week cannot undo. The text tool prefixes each
 * reason with "Week of <date>: "; the app feed attaches them to the week's
 * row.
 */
export function computeWeekWarnings(weeks: WeeklyVolume[]): WeekWarning[] {
  const warnings: WeekWarning[] = [];

  if (weeks.length < 2) {
    return warnings;
  }

  // Check for sudden volume increases (>30% week over week)
  for (let i = 1; i < weeks.length; i += 1) {
    const prev = weeks[i - 1]!;
    const curr = weeks[i]!;
    if (prev.in_progress) continue;

    if (prev.distance_km > 0 && curr.distance_km > prev.distance_km * 1.3) {
      const increase = Math.round(
        (curr.distance_km / prev.distance_km - 1) * 100,
      );
      warnings.push({
        week_starting: curr.week_starting,
        reason: curr.in_progress
          ? `Volume so far is already ${increase}% above the previous week - consider injury risk`
          : `Volume increased ${increase}% from previous week - consider injury risk`,
      });
    }
  }

  // Check for very high weeks compared to the complete-week average
  const complete = weeks.filter((w) => !w.in_progress);
  if (complete.length === 0) {
    return warnings;
  }
  const avgDistance =
    complete.reduce((sum, w) => sum + w.distance_km, 0) / complete.length;

  for (const week of weeks) {
    if (week.distance_km > avgDistance * 1.5 && week.distance_km > 30) {
      const volume = week.in_progress ? "volume so far" : "volume";
      warnings.push({
        week_starting: week.week_starting,
        reason: `Unusually high ${volume} (${week.distance_km} km vs ${Math.round(avgDistance)} km average)`,
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
  /**
   * Rolling-average volume for the trend line, in km, over complete weeks.
   * Null for the week in progress, so the line ends at the last complete
   * week instead of dipping on a partial one.
   */
  trendKm: number | null;
  /** The current week: its volume is only the days so far. */
  inProgress: boolean;
  warning: boolean;
  warningReasons: string[];
  /** Sum of `icu_training_load` over the included types this week. */
  load: number;
  /** `load` split by activity type. */
  loadByType: Record<string, number>;
}

export interface TrainingLoadAppData {
  /** Calendar days read: whole weeks plus the current week so far. */
  days: number;
  /** First day read (a Monday) and the last (today). */
  startDate: string;
  endDate: string;
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

/** A week's run distance in km, rounded to 10 m: the one rounding every weekly figure uses. */
export function weekDistanceKm(bucket: WeekBucket): number {
  return Math.round(bucket.distanceM / 10) / 100;
}

/**
 * True for the current week (or a later one, which only a time-zone mismatch
 * could produce): its volume is only the days so far.
 */
export function weekInProgress(
  weekStarting: string,
  currentWeekStart: string,
): boolean {
  return weekStarting >= currentWeekStart;
}

/** The weeks the run-based rules read; see {@link selectRunWeeks}. */
export interface RunWeeks {
  /** First to last week with a run, zero-run weeks inside kept. */
  span: WeekBucket[];
  /** `span` without the week in progress. Averages and the trend read these. */
  complete: WeekBucket[];
  /** Injury-risk warnings over `span`. */
  warnings: WeekWarning[];
}

/**
 * Selects the weeks the run-based rules read, and computes the warnings over
 * them. The one home for this choice: `get-training-load` and the app feed
 * both call it, so their warnings can never differ (#43).
 *
 * The span runs from the first to the last week with a run. Zero-run weeks
 * inside it are kept: a layoff is a real gap the averages, the trend and the
 * warnings must see, and dropping it would compare two weeks that are not
 * adjacent as if they were. Weeks outside it hold load only (for example a
 * bike week before the first run, which the whole-body timeline also
 * holds), so counting them would change the run numbers with `runOnly`. The
 * week starting on or after `currentWeekStart` is in progress: it can be
 * flagged, but only on the volume it already has (see
 * {@link computeWeekWarnings}), and it is left out of `complete`.
 */
export function selectRunWeeks(
  buckets: WeekBucket[],
  currentWeekStart: string,
): RunWeeks {
  const first = buckets.findIndex((b) => b.runs > 0);
  const last = buckets.findLastIndex((b) => b.runs > 0);
  const span = first === -1 ? [] : buckets.slice(first, last + 1);
  const inProgress = (b: WeekBucket) =>
    weekInProgress(b.weekStarting, currentWeekStart);

  return {
    span,
    complete: span.filter((b) => !inProgress(b)),
    warnings: computeWeekWarnings(
      span.map((b) => ({
        week_starting: b.weekStarting,
        distance_km: weekDistanceKm(b),
        in_progress: inProgress(b),
      })),
    ),
  };
}

export interface VolumeTrend {
  /** The verdict ("stable", "increasing", ...) or why there is none. */
  label: string;
  /** Mondays of the weeks compared, oldest first: 2 earlier, then 2 recent. Empty with no verdict. */
  weeks: string[];
}

/**
 * Volume trend over complete weeks: the distance of the last 2 against the 2
 * before. Needs 4 complete weeks, so the week in progress never counts.
 */
export function volumeTrend(complete: WeekBucket[]): VolumeTrend {
  const none = (label: string): VolumeTrend => ({ label, weeks: [] });
  if (complete.length < 2) return none("insufficient data");
  if (complete.length < 4) {
    return none("limited data - need 4+ complete weeks for trend");
  }

  const compared = complete.slice(-4);
  const km = compared.map(weekDistanceKm);
  const previous = km[0]! + km[1]!;
  const recent = km[2]! + km[3]!;
  if (previous <= 0) return none("insufficient data");

  return {
    label: trendLabel(((recent - previous) / previous) * 100),
    weeks: compared.map((b) => b.weekStarting),
  };
}

function trendLabel(changePct: number): string {
  if (changePct > 15) return "increasing significantly";
  if (changePct > 5) return "increasing";
  if (changePct < -15) return "decreasing significantly";
  if (changePct < -5) return "decreasing";
  return "stable";
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
 * Aggregate activities into the chart-ready weekly payload for `lookback`
 * (from {@link trainingLoadWindow}): per-week volume and load from
 * {@link aggregateWeeks} (gap weeks and load-only weeks zero-filled either
 * way, so the timeline is continuous and a skipped week is visible), a
 * rolling-average trend value per complete week, and the warning flags.
 * Warnings come from {@link selectRunWeeks}, the same call the text tool
 * makes, so both surfaces always agree. `runs` drives volume and the
 * warning rules always (they are run-based regardless of
 * `options.runOnly`); `options.loadActivities` (default `runs`) drives
 * `load`/`loadByType`.
 */
export function buildTrainingLoadData(
  runs: TrainingLoadActivity[],
  lookback: TrainingLoadWindow,
  options: BuildTrainingLoadDataOptions = {},
): TrainingLoadAppData {
  const loadActivities = options.loadActivities ?? runs;
  const runOnly = options.runOnly ?? true;

  const buckets = aggregateWeeks(runs, loadActivities);
  const { warnings } = selectRunWeeks(buckets, lookback.currentWeekStart);
  const inProgress = (b: WeekBucket) =>
    weekInProgress(b.weekStarting, lookback.currentWeekStart);

  const reasonsByWeek = new Map<string, string[]>();
  for (const warning of warnings) {
    const reasons = reasonsByWeek.get(warning.week_starting) ?? [];
    reasons.push(warning.reason);
    reasonsByWeek.set(warning.week_starting, reasons);
  }

  const distances = buckets.map(weekDistanceKm);
  // The trend line smooths complete weeks only: a partial week would drag
  // it down at the right edge. Buckets are sorted and only the last one can
  // be in progress, so trend[i] belongs to buckets[i] and the week in
  // progress gets none.
  const trend = rollingTrend(
    buckets.filter((b) => !inProgress(b)).map(weekDistanceKm),
  );

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
      trendKm: i < trend.length ? Math.round(trend[i]! * 100) / 100 : null,
      inProgress: inProgress(bucket),
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
    days: lookback.spanDays,
    startDate: lookback.startDate,
    endDate: lookback.endDate,
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
