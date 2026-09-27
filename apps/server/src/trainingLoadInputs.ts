/**
 * Shared fetch + classify for `get-training-load` and the training-load MCP
 * App: the whole-week window, activities for it (run-only or whole-body),
 * current CTL/ATL/TSB, and the activity types load was summed over. The one
 * home `get-training-load` and `get-training-load-data` build these inputs
 * through, so the two surfaces can never disagree on the window, runway, the
 * run filter, or how `current` was read (see AGENTS.md's "derived numbers
 * have exactly one home").
 */
import { getTimeZone } from "./config";
import {
  buildRunOnlyFitnessTrend,
  RUN_ONLY_RUNWAY_DAYS,
  RUN_TYPES,
} from "./fitnessTrend";
import { loadWellnessFitnessSeries } from "./fitnessTrendWellness";
import { type IntervalsActivity, listActivities } from "./intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "./progress";
import {
  type TrainingLoadWindow,
  trainingLoadWindow,
  typesWithLoad,
} from "./trainingLoad";
import { addDays, todayLocal } from "./utils/localDate";

export interface TrainingLoadInputs {
  /** The whole-week window read, from `trainingLoadWindow`. */
  lookback: TrainingLoadWindow;
  /** Run activities (Run/TrailRun/VirtualRun) inside `lookback`, for volume/warnings. */
  runs: IntervalsActivity[];
  /**
   * Runs from `lookback.baselineStartDate` up to the window: only the recent
   * average the first weeks' warnings compare with (#60), never reported.
   */
  baselineRuns: IntervalsActivity[];
  /**
   * Activities `icu_training_load` is summed over: the same runs (run-only)
   * or every window activity (whole-body).
   */
  loadActivities: IntervalsActivity[];
  /** Most recent CTL/ATL/TSB. */
  current: { date: string; ctl: number; atl: number; tsb: number } | null;
  source: "intervals.icu" | "computed";
  /** Activity types `loadActivities` was summed over. */
  activityTypesIncluded: string[];
}

/**
 * Fetches and classifies training-load inputs for `days` back from today,
 * rounded up to whole weeks plus the current week so far
 * (`trainingLoadWindow`). Both paths also read the runs of the 4 weeks
 * before the window (`baselineRuns`), the volume-spike baseline. Run-only
 * fetches a runway before the window (`RUN_ONLY_RUNWAY_DAYS`) so
 * `buildRunOnlyFitnessTrend`'s local CTL/ATL has settled, the same runway
 * `get-fitness-trend`'s run-only path uses; it covers those 4 weeks.
 * Whole-body reads CTL/ATL straight off intervals.icu wellness via
 * `loadWellnessFitnessSeries` instead.
 */
export async function loadTrainingLoadInputs(
  apiKey: string,
  options: { days: number; runOnly: boolean },
  progress: ReportProgress = NO_PROGRESS,
): Promise<TrainingLoadInputs> {
  const { days, runOnly } = options;
  const tz = getTimeZone();
  const lookback = trainingLoadWindow(days, todayLocal(tz));
  const { baselineStartDate, startDate: windowStart, endDate } = lookback;
  const localDay = (a: IntervalsActivity) => a.start_date_local.split("T")[0]!;
  const inWindow = (a: IntervalsActivity) =>
    localDay(a) >= windowStart && localDay(a) <= endDate;
  const inBaseline = (a: IntervalsActivity) =>
    localDay(a) >= baselineStartDate && localDay(a) < windowStart;
  const isRun = (a: IntervalsActivity) => RUN_TYPES.includes(a.type ?? "");

  if (runOnly) {
    // Counted back from today by the requested days, as get-fitness-trend
    // counts it, so `current` matches that tool's run-only value. The
    // window's first Monday is at most 13 days further back than `days`
    // reaches, so at least 137 runway days still come before it.
    const runwayDays = days + RUN_ONLY_RUNWAY_DAYS;
    const runwayStart = addDays(endDate, -(runwayDays - 1));

    progress(`Listing activities ${runwayStart} to ${endDate}…`, {
      important: true,
    });
    const activities = await listActivities(
      apiKey,
      { oldest: runwayStart, newest: endDate },
      progress,
    );
    const runActivities = activities.filter(isRun);
    const windowRuns = runActivities.filter(inWindow);

    const { trend } = buildRunOnlyFitnessTrend(runActivities, {
      endDate,
      days,
      runwayDays,
    });
    const current = trend.current
      ? {
          date: trend.current.date,
          ctl: trend.current.ctl,
          atl: trend.current.atl,
          tsb: trend.current.tsb,
        }
      : null;

    return {
      lookback,
      runs: windowRuns,
      baselineRuns: runActivities.filter(inBaseline),
      loadActivities: windowRuns,
      current,
      source: "computed",
      activityTypesIncluded: [...RUN_TYPES],
    };
  }

  // One listing from the baseline start, split by date: the baseline runs
  // only feed the warnings, the window's activities everything else. No
  // upper bound, as before: aggregateWeeks keeps a week after the current
  // one that only a time-zone mismatch can produce.
  progress(`Listing activities ${baselineStartDate} to ${endDate}…`, {
    important: true,
  });
  const listed = await listActivities(
    apiKey,
    { oldest: baselineStartDate, newest: endDate },
    progress,
  );
  const activities = listed.filter((a) => localDay(a) >= windowStart);
  const runs = activities.filter(isRun);

  progress(`Fetching wellness ${windowStart} to ${endDate}…`);
  const { series } = await loadWellnessFitnessSeries(apiKey, {
    oldest: windowStart,
    newest: endDate,
  });
  const last = series[series.length - 1];
  const current = last
    ? { date: last.date, ctl: last.ctl, atl: last.atl, tsb: last.tsb }
    : null;

  return {
    lookback,
    runs,
    baselineRuns: listed.filter((a) => isRun(a) && inBaseline(a)),
    loadActivities: activities,
    current,
    source: "intervals.icu",
    activityTypesIncluded: typesWithLoad(activities),
  };
}
