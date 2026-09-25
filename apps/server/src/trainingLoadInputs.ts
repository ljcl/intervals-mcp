/**
 * Shared fetch + classify for `get-training-load` and the training-load MCP
 * App: activities for the window (run-only or whole-body), current CTL/ATL/
 * TSB, and the activity types load was summed over. The one home
 * `get-training-load` and `get-training-load-data` build these inputs
 * through, so the two surfaces can never disagree on runway, the run
 * filter, or how `current` was read (see AGENTS.md's "derived numbers have
 * exactly one home").
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
import { typesWithLoad } from "./trainingLoad";
import { addDays, todayLocal } from "./utils/localDate";

export interface TrainingLoadInputs {
  /** Run activities (Run/TrailRun/VirtualRun) inside `days`, for volume/warnings. */
  runs: IntervalsActivity[];
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
 * Fetches and classifies training-load inputs for `days` back from today.
 * Run-only fetches a runway before the window (`RUN_ONLY_RUNWAY_DAYS`) so
 * `buildRunOnlyFitnessTrend`'s local CTL/ATL has settled by the window
 * start, the same runway `get-fitness-trend`'s run-only path uses.
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
  const endDate = todayLocal(tz);
  const windowStart = addDays(endDate, -(days - 1));

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
    const windowRuns = runActivities.filter((a) => {
      const date = a.start_date_local.split("T")[0]!;
      return date >= windowStart && date <= endDate;
    });

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
      runs: windowRuns,
      loadActivities: windowRuns,
      current,
      source: "computed",
      activityTypesIncluded: [...RUN_TYPES],
    };
  }

  progress(`Listing activities ${windowStart} to ${endDate}…`, {
    important: true,
  });
  const activities = await listActivities(apiKey, {
    oldest: windowStart,
    newest: endDate,
  });
  const runs = activities.filter((a) => RUN_TYPES.includes(a.type ?? ""));

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
    runs,
    loadActivities: activities,
    current,
    source: "intervals.icu",
    activityTypesIncluded: typesWithLoad(activities),
  };
}
