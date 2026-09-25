/**
 * Shared fetch + solve for the CTL/ATL/TSB fitness trend, whole-body or
 * run-only. `get-fitness-trend` (the text tool) and the fitness-trend MCP
 * App's data handler (`view-fitness-trend`/`get-fitness-trend-data` in
 * `server.ts`) both build the series through this one function, so the two
 * surfaces can never disagree for the same inputs (see AGENTS.md's "derived
 * numbers have exactly one home").
 *
 * Whole-body reads CTL/ATL straight off intervals.icu's own wellness record
 * (`loadWellnessFitnessSeries`), never recomputed. Run-only has no per-sport
 * CTL/ATL from intervals.icu, so it is computed locally from Run/TrailRun/
 * VirtualRun training load (`buildRunOnlyFitnessTrend`), zero-seeded well
 * before the window so the 42-day CTL average has settled.
 */

import { getTimeZone } from "./config";
import {
  buildRunOnlyFitnessTrend,
  computeFlags,
  type FitnessTrendDay,
  type PlannedLoad,
  projectFromWellness,
  RUN_ONLY_RUNWAY_DAYS,
  RUN_TYPES,
  type TaperPlan,
  type TrendBand,
  trendBands,
} from "./fitnessTrend";
import { loadWellnessFitnessSeries } from "./fitnessTrendWellness";
import { listActivities } from "./intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "./progress";
import { typesWithLoad } from "./trainingLoad";
import { addDays, todayLocal } from "./utils/localDate";

/** Beyond this the solved plan is a training block, not a taper. */
const LONG_PLAN_DAYS = 28;

const localDay = (isoDateTime: string) => isoDateTime.split("T")[0]!;

export interface LoadFitnessTrendOptions {
  /** Days to look back and display. */
  days: number;
  /**
   * Compute CTL/ATL/TSB from run load only instead of intervals.icu's
   * whole-body wellness CTL/ATL. Default false.
   */
  runOnly?: boolean;
  /** Project this many days past today (zero load unless plannedLoads says otherwise). */
  projectDays?: number;
  /** Planned future load to project with instead of rest. */
  plannedLoads?: PlannedLoad[];
  /** Solve a load taper landing on a target TSB. */
  taper?: { targetDate: string; targetTsb: number };
}

export interface FitnessTrendLoadResult {
  endDate: string;
  windowStart: string;
  /** Where `current` CTL/ATL came from. */
  source: "intervals.icu" | "computed";
  /** Displayed daily series, oldest first, trimmed to `days`. */
  series: FitnessTrendDay[];
  current: FitnessTrendDay | null;
  projection: FitnessTrendDay[];
  tsbPositiveDate: string | null;
  taper: TaperPlan | null;
  /** Date `current` is known for; can trail `endDate` when wellness lags. */
  asOf: string | null;
  activityTypesIncluded: string[];
  activitiesIncluded: number;
  activitiesMissingLoad: number;
  warnings: string[];
  bands: TrendBand[];
  flags: string[];
}

/**
 * Fetches and solves the CTL/ATL/TSB trend for one scope (whole-body or
 * run-only). Both `get-fitness-trend` and the fitness-trend MCP App's data
 * handler call this and format its result their own way (text vs. camelCase
 * JSON); neither re-derives any of it.
 */
export async function loadFitnessTrend(
  apiKey: string,
  options: LoadFitnessTrendOptions,
  progress: ReportProgress = NO_PROGRESS,
): Promise<FitnessTrendLoadResult> {
  const {
    days,
    runOnly = false,
    projectDays = 0,
    plannedLoads,
    taper,
  } = options;

  const tz = getTimeZone();
  const endDate = todayLocal(tz);
  const windowStart = addDays(endDate, -(days - 1));

  let source: "intervals.icu" | "computed";
  let displaySeries: FitnessTrendDay[];
  let current: FitnessTrendDay | null;
  let projection: FitnessTrendDay[];
  let tsbPositiveDate: string | null;
  let taperPlan: TaperPlan | null;
  let activityTypesIncluded: string[];
  let activitiesIncluded: number;
  let activitiesMissingLoad: number;
  const warnings: string[] = [];

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

    const { trend } = buildRunOnlyFitnessTrend(runActivities, {
      endDate,
      days,
      runwayDays,
      fitnessOptions: {
        projectDays,
        plannedLoads,
        taper,
      },
    });

    // The runway settles CTL; trim the display (and the bands/flags read
    // off it) back to the requested window.
    displaySeries = trend.days.slice(-days);
    current = trend.current;
    projection = trend.projection;
    tsbPositiveDate = trend.tsbPositiveDate;
    taperPlan = trend.taper;

    source = "computed";
    activityTypesIncluded = [...RUN_TYPES];
    const inWindow = runActivities.filter((a) => {
      const date = localDay(a.start_date_local);
      return date >= windowStart && date <= endDate;
    });
    activitiesIncluded = inWindow.length;
    activitiesMissingLoad = inWindow.filter(
      (a) => a.icu_training_load == null,
    ).length;

    warnings.push(
      `Run-only CTL/ATL is computed locally from Run/TrailRun/VirtualRun ` +
        `training load, zero-seeded ${RUN_ONLY_RUNWAY_DAYS} days before ` +
        `the window (from ${runwayStart}) so the 42-day CTL average has ` +
        `settled by ${windowStart}; it will not exactly match intervals.icu's ` +
        `own (whole-body) fitness page.`,
    );
  } else {
    progress(`Fetching wellness ${windowStart} to ${endDate}…`, {
      important: true,
    });
    const { series, seed, asOfDate, gapDates } =
      await loadWellnessFitnessSeries(apiKey, {
        oldest: windowStart,
        newest: endDate,
      });

    displaySeries = series;
    current =
      series.length > 0
        ? {
            date: series[series.length - 1]!.date,
            load: series[series.length - 1]!.load,
            ctl: series[series.length - 1]!.ctl,
            atl: series[series.length - 1]!.atl,
            tsb: series[series.length - 1]!.tsb,
          }
        : null;

    // Days between the most recent day with recorded CTL/ATL and today:
    // wellness that has not synced yet, not a zero-load day. Always the
    // trailing slice of `gapDates` below, so it is folded into that one
    // warning rather than reported a second time.
    const projected = projectFromWellness(
      { series, seed, asOfDate, endDate },
      {
        projectDays,
        plannedLoads,
        taper,
      },
    );
    projection = projected.projection;
    tsbPositiveDate = projected.tsbPositiveDate;
    taperPlan = projected.taper;
    warnings.push(...projected.warnings);
    const unsyncedDays = projected.unsyncedDays;

    if (!seed || !asOfDate) {
      if (taper || projectDays > 0) {
        warnings.push(
          "No wellness CTL/ATL is available in the window, so there is nothing to project or solve a taper from.",
        );
      }
    }

    source = "intervals.icu";
    if (gapDates.length > 0) {
      const plural = gapDates.length !== 1;
      const willProject = projectDays > 0 && !taper;
      const trailingClause =
        unsyncedDays > 0
          ? ` The most recent ${unsyncedDays} ${unsyncedDays === 1 ? "day" : "days"} ` +
            `(${addDays(asOfDate!, 1)} to ${endDate}) ${unsyncedDays === 1 ? "has" : "have"} not ` +
            `synced yet${willProject ? `; the projection assumes rest for ${unsyncedDays === 1 ? "it" : "them"} before continuing forward` : ""}.`
          : "";
      warnings.push(
        `${gapDates.length} of ${days} day${plural ? "s" : ""} in the window ` +
          `have no wellness CTL/ATL recorded; ${plural ? "those are gaps" : "that is a gap"}, ` +
          `not zero load, and ${plural ? "are" : "is"} left out of the series.` +
          trailingClause,
      );
    }

    progress(`Listing activities ${windowStart} to ${endDate}…`);
    const activities = await listActivities(apiKey, {
      oldest: windowStart,
      newest: endDate,
    });
    activityTypesIncluded = typesWithLoad(activities);
    activitiesIncluded = activities.length;
    activitiesMissingLoad = activities.filter(
      (a) => a.icu_training_load == null,
    ).length;

    warnings.push(
      "Some activity types (e.g. strength/weight training) may count " +
        "toward fatigue (ATL) only, not fitness (CTL), depending on this " +
        "athlete's intervals.icu settings.",
    );
    if (activitiesMissingLoad > 0) {
      warnings.push(
        `${activitiesMissingLoad} of ${activitiesIncluded} activities in ` +
          "the window have no training load recorded (informational only, " +
          "since whole-body CTL/ATL comes from intervals.icu's own " +
          "wellness data, not summed here).",
      );
    }
  }

  if (activitiesIncluded === 0) {
    warnings.push(
      runOnly
        ? "No matching run activities in the window."
        : "No activities in the window.",
    );
  }
  if (taperPlan && taperPlan.days.length > LONG_PLAN_DAYS) {
    warnings.push(
      `${taperPlan.days.length} days is a training block rather than a taper; the plan still steps down each week, so treat its early weeks as maintenance load.`,
    );
  }

  return {
    endDate,
    windowStart,
    source,
    series: displaySeries,
    current,
    projection,
    tsbPositiveDate,
    taper: taperPlan,
    asOf: current?.date ?? null,
    activityTypesIncluded,
    activitiesIncluded,
    activitiesMissingLoad,
    warnings,
    bands: trendBands(displaySeries),
    flags: computeFlags(displaySeries),
  };
}
