/**
 * Pure training-load aggregation shared by the `get-training-load` text tool
 * and the `get-training-load-data` MCP App feed. The week window, the weeks
 * the run-based rules read, and the volume-spike warning rule live here
 * once, so the chart's per-week flags can never drift from the text tool's
 * prose warnings.
 */
import { RUN_TYPES } from "./fitnessTrend";
import { addDays, daysBetween, startOfWeekMonday } from "./utils/localDate";

/** Complete weeks before a week that its recent (chronic) average reads. */
const CHRONIC_WEEKS = 4;
/** Fewest complete weeks a recent average needs: fewer is not a baseline. */
const MIN_CHRONIC_WEEKS = 3;
/** Acute:chronic ratio above which a week is a volume spike. */
const SPIKE_RATIO = 1.5;

/**
 * The window both training-load surfaces read: `days` rounded up to whole
 * Monday-to-Sunday weeks, to the week that holds `endDate` (today, or the
 * caller's `newest`). Only the last week can be partial, so the rules can
 * treat it apart instead of reading a few days as a full week (#43). When
 * the window ends today, the last week is the current week so far, and a
 * 28-day request reads 4 complete weeks plus this week on every weekday,
 * Sunday included, so the trend always has its 4 complete weeks. When it
 * ends on a past Sunday, the last week is complete and is one of the `days`
 * weeks, so `days: 84` reads exactly 12 weeks (#80). Any other past
 * `endDate` cuts its week off after that day, and that partial week is
 * read like the current week.
 */
export interface TrainingLoadWindow {
  /**
   * Monday 4 weeks before `startDate`. Runs from here to `startDate` are
   * only the recent average the first weeks of the window are compared
   * with (#60); they are not reported.
   */
  baselineStartDate: string;
  /** Monday of the first complete week. */
  startDate: string;
  /** The last day read: today, or the caller's `newest`. */
  endDate: string;
  /** False for a past window (`newest` before today). */
  endsToday: boolean;
  /** Monday of the last week read, the week holding `endDate`. The timeline runs to it. */
  lastWeekStart: string;
  /** Days of the last week read, `endDate` included: 1 on Monday, 7 on Sunday. */
  lastWeekDays: number;
  /**
   * Monday of the partial week, or null when every week read is complete.
   * The partial week is always the last one: in progress when the window
   * ends today (Sunday included, as today is not over), or cut off at a past
   * `endDate` that is not a Sunday.
   */
  partialWeekStart: string | null;
  /** Complete weeks read: `days` rounded up to whole weeks. */
  completeWeeks: number;
  /** Calendar days from `startDate` to `endDate`, both included. */
  spanDays: number;
}

export function trainingLoadWindow(
  days: number,
  endDate: string,
  endsToday = true,
): TrainingLoadWindow {
  const completeWeeks = Math.ceil(days / 7);
  const lastWeekStart = startOfWeekMonday(endDate);
  const lastWeekDays = daysBetween(lastWeekStart, endDate) + 1;
  // A past week that reaches its Sunday is over, so it is one of the
  // complete weeks; today's week is still in progress even on a Sunday.
  const partial = endsToday || lastWeekDays < 7;
  const startDate = addDays(
    lastWeekStart,
    -7 * (partial ? completeWeeks : completeWeeks - 1),
  );
  return {
    baselineStartDate: addDays(startDate, -7 * CHRONIC_WEEKS),
    startDate,
    endDate,
    endsToday,
    lastWeekStart,
    lastWeekDays,
    partialWeekStart: partial ? lastWeekStart : null,
    completeWeeks,
    spanDays: 7 * completeWeeks + (partial ? lastWeekDays : 0),
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
  /** The partial last week: its volume is only the days read so far. */
  in_progress?: boolean;
}

export interface WeekWarning {
  week_starting: string;
  reason: string;
}

/**
 * Volume-spike warnings per week (#60): a week whose distance is over 1.5
 * times the average of the 4 complete weeks before it (the acute:chronic
 * ratio). The average needs at least 3 weeks, and one of 0 km gives no
 * ratio. It is the one rule: a rise on the previous week alone flagged a
 * normal week after a recovery or taper week, and a separate "high week"
 * rule flagged the same weeks twice. The average never looks ahead, so a
 * layoff after a normal week does not make that week look high. A week in
 * progress is never part of an average, because its volume is only the
 * days so far. It is flagged only when that partial volume is already a
 * spike, which the rest of the week cannot undo. The text tool prefixes each
 * reason with "Week of <date>: "; the app feed attaches them to the week's
 * row.
 */
export function computeWeekWarnings(weeks: WeeklyVolume[]): WeekWarning[] {
  const warnings: WeekWarning[] = [];

  weeks.forEach((week, i) => {
    const previous = weeks
      .slice(Math.max(0, i - CHRONIC_WEEKS), i)
      .filter((w) => !w.in_progress);
    if (previous.length < MIN_CHRONIC_WEEKS) return;

    const chronic =
      previous.reduce((sum, w) => sum + w.distance_km, 0) / previous.length;
    if (chronic <= 0) return;
    // Compared as shown, so the reason never reads "1.5 times".
    const ratio = Math.round((week.distance_km / chronic) * 100) / 100;
    if (ratio <= SPIKE_RATIO) return;

    const average = `${Math.round(chronic * 10) / 10} km average of the previous ${previous.length} weeks`;
    warnings.push({
      week_starting: week.week_starting,
      reason: week.in_progress
        ? `Volume spike so far: ${week.distance_km} km is already ${ratio} times the ${average}`
        : `Volume spike: ${week.distance_km} km is ${ratio} times the ${average}`,
    });
  });

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
  /**
   * The partial last week: in progress when the window ends today, else cut
   * off at `endDate`. Its volume is only the days read.
   */
  inProgress: boolean;
  warning: boolean;
  warningReasons: string[];
  /** Sum of `icu_training_load` over the included types this week. */
  load: number;
  /** `load` split by activity type. */
  loadByType: Record<string, number>;
}

export interface TrainingLoadAppData {
  /** Calendar days read: whole weeks plus the partial last week, if any. */
  days: number;
  /** First day read (a Monday) and the last (today, or newest). */
  startDate: string;
  endDate: string;
  /**
   * False for a past window (newest before today): a partial last week is
   * cut off at endDate, not in progress.
   */
  endsToday: boolean;
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

const emptyBucket = (weekStarting: string): WeekBucket => ({
  weekStarting,
  runs: 0,
  distanceM: 0,
  timeS: 0,
  elevationM: 0,
  load: 0,
  loadByType: {},
});

/**
 * Builds the weekly timeline both `get-training-load` and
 * `get-training-load-data` read from: a continuous Monday-to-Monday run,
 * from the earliest week that has either a run activity (`runs`) or a load
 * activity (`loadActivities`) to the window's last week (`lastWeekStart`,
 * from {@link trainingLoadWindow}). A load-only week (e.g. a strength-only
 * week, or a window with no runs at all) is not dropped, it just carries
 * zeroed run fields, and a run-only week carries zeroed load fields. Every
 * week after the earliest active one with neither is zero-filled too, up to
 * and including the last week, so a skipped week and a layoff that is
 * still going on are both visible. Weeks before the earliest active one are
 * left out: they may be missing data (a new account, say), and with no
 * activity at all the timeline is empty. The one home this timeline is
 * built through, so the text tool and the app feed can never disagree on a
 * week's load or volume (see AGENTS.md's "derived numbers have exactly one
 * home").
 */
export function aggregateWeeks(
  runs: TrainingLoadActivity[],
  loadActivities: TrainingLoadActivity[],
  lastWeekStart: string,
): WeekBucket[] {
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

  // A later active week than the last one only comes from a time-zone
  // mismatch; the timeline still reaches it rather than dropping activity.
  const latestActive = sortedKeys[sortedKeys.length - 1]!;
  const last = latestActive > lastWeekStart ? latestActive : lastWeekStart;
  const weekKeys: string[] = [];
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
 * True for the partial week, `partialWeekStart` from
 * {@link trainingLoadWindow} (or a later one, which only a time-zone
 * mismatch could produce): its volume is only the days read so far. Never
 * true when every week read is complete (`partialWeekStart` null).
 */
export function weekIsPartial(
  weekStarting: string,
  partialWeekStart: string | null,
): boolean {
  return partialWeekStart !== null && weekStarting >= partialWeekStart;
}

/** The weeks the run-based rules read; see {@link selectRunWeeks}. */
export interface RunWeeks {
  /** First week with a run to the end of the timeline, zero-run weeks kept. */
  span: WeekBucket[];
  /** `span` without the partial week. Averages and the trend read these. */
  complete: WeekBucket[];
  /** Volume-spike warnings over `span`. */
  warnings: WeekWarning[];
}

/**
 * The run weeks before the window that the first weeks' recent average
 * reads (#60): from the first run in `baselineRuns` (the runs from
 * `lookback.baselineStartDate` up to `lookback.startDate`) to the week before
 * the window, zero-run weeks kept. Weeks before that first run are left out,
 * as in {@link selectRunWeeks}. Without it, a 28-day request could compare
 * only its last complete week and the current one with an average.
 */
export function baselineWeeks(
  baselineRuns: TrainingLoadActivity[],
  lookback: Pick<TrainingLoadWindow, "startDate">,
): WeekBucket[] {
  return aggregateWeeks(baselineRuns, [], addDays(lookback.startDate, -7));
}

/**
 * Selects the weeks the run-based rules read, and computes the warnings over
 * them. The one home for this choice: `get-training-load` and the app feed
 * both call it, so their warnings can never differ (#43).
 *
 * The span runs from the first week with a run to the end of the timeline,
 * which {@link aggregateWeeks} carries to the window's last week. Zero-run weeks
 * in it are kept, those after the last run included: a layoff is a real gap
 * the averages, the trend and the warnings must see, whether or not it has
 * ended, and dropping it would compare two weeks that are not adjacent as if
 * they were. Weeks before the first run are left out: they may be missing
 * data, and in whole-body mode they can hold load only (for example a bike
 * week), so counting them would change the run numbers with `runOnly`.
 * Neither end depends on load-only activities. The week starting on or after
 * `partialWeekStart` is partial (in progress today, or cut off at a past
 * `newest`): it can be flagged, but only on the volume it already has (see
 * {@link computeWeekWarnings}), and it is left out of `complete`. With
 * `partialWeekStart` null (a window that ends on a past Sunday) every week
 * is complete.
 *
 * `before` ({@link baselineWeeks}) is only a baseline: the warnings compare
 * the span's first weeks with it, and the weeks from its end to the span's
 * first run count as zero weeks, but it adds no week to `span` and gets no
 * warning.
 */
export function selectRunWeeks(
  buckets: WeekBucket[],
  partialWeekStart: string | null,
  before: WeekBucket[] = [],
): RunWeeks {
  const first = buckets.findIndex((b) => b.runs > 0);
  const span = first === -1 ? [] : buckets.slice(first);
  const inProgress = (b: WeekBucket) =>
    weekIsPartial(b.weekStarting, partialWeekStart);

  return {
    span,
    complete: span.filter((b) => !inProgress(b)),
    warnings: spikeWarnings(span, before, inProgress),
  };
}

/** {@link computeWeekWarnings} over `span`, with `before` as the first weeks' baseline. */
function spikeWarnings(
  span: WeekBucket[],
  before: WeekBucket[],
  inProgress: (b: WeekBucket) => boolean,
): WeekWarning[] {
  const spanStart = span[0]?.weekStarting;
  if (spanStart === undefined) return [];

  const firstRun = before.findIndex((b) => b.runs > 0);
  const baseline = firstRun === -1 ? [] : before.slice(firstRun);
  const gap: WeekBucket[] = [];
  const lastBaseline = baseline[baseline.length - 1]?.weekStarting;
  if (lastBaseline !== undefined) {
    for (
      let key = addDays(lastBaseline, 7);
      key < spanStart;
      key = addDays(key, 7)
    ) {
      gap.push(emptyBucket(key));
    }
  }

  return computeWeekWarnings(
    [...baseline, ...gap, ...span].map((b) => ({
      week_starting: b.weekStarting,
      distance_km: weekDistanceKm(b),
      in_progress: inProgress(b),
    })),
  ).filter((w) => w.week_starting >= spanStart);
}

export interface VolumeTrend {
  /** The verdict ("stable", "increasing", ...) or why there is none. */
  label: string;
  /** Mondays of the weeks compared, oldest first: 2 earlier, then 2 recent. Empty with no verdict. */
  weeks: string[];
}

/**
 * Volume trend over complete weeks: the distance of the last 2 against the 2
 * before. Needs 4 complete weeks, so the partial week never counts.
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
  if (previous <= 0) {
    // A layoff of 4 weeks or more is an answer, not missing data.
    return none(
      recent <= 0
        ? "no running volume in the last 4 complete weeks"
        : "insufficient data",
    );
  }

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
  /**
   * Runs in the 4 weeks before the window, the recent average the first
   * weeks' warnings compare with; see {@link baselineWeeks}. Not reported.
   */
  baselineRuns?: TrainingLoadActivity[];
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

  const buckets = aggregateWeeks(runs, loadActivities, lookback.lastWeekStart);
  const { warnings } = selectRunWeeks(
    buckets,
    lookback.partialWeekStart,
    baselineWeeks(options.baselineRuns ?? [], lookback),
  );
  const inProgress = (b: WeekBucket) =>
    weekIsPartial(b.weekStarting, lookback.partialWeekStart);

  const reasonsByWeek = new Map<string, string[]>();
  for (const warning of warnings) {
    const reasons = reasonsByWeek.get(warning.week_starting) ?? [];
    reasons.push(warning.reason);
    reasonsByWeek.set(warning.week_starting, reasons);
  }

  const distances = buckets.map(weekDistanceKm);
  // The trend line smooths complete weeks only: a partial week would drag
  // it down at the right edge. Buckets are sorted and only the last one can
  // be partial, so trend[i] belongs to buckets[i] and the partial week gets
  // none.
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
    endsToday: lookback.endsToday,
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
