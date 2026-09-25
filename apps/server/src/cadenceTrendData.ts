/**
 * Pure cadence-trend aggregation shared by the `view-cadence-trends` text
 * summary and the `get-cadence-trend-data` MCP App feed. Filtering,
 * cadence-doubling, and date handling live here once, so the two surfaces
 * can never disagree.
 */

import { type IntervalsActivity } from "./intervalsClient";
import { activityCadenceSpm, isPaceActivity } from "./utils/running";

/** Summary data for a single run, returned by get-cadence-trend-data. */
export interface RunSummary {
  id: string;
  name: string;
  /** Local calendar date (`YYYY-MM-DD`), from `start_date_local`'s date
   * portion, never re-interpreted through a `Date` object's own time zone
   * (a late-evening run stays on the day it was run). */
  date: string;
  distance: number;
  duration: number;
  averageCadence: number;
  averagePace: number;
  type: string;
}

/** Response shape for `get-cadence-trend-data`. */
export interface CadenceTrendData {
  weeks: number;
  activities: RunSummary[];
}

/**
 * Builds the cadence-trend feed from a window of activities already fetched
 * via `listActivities`: filters to run types (Run/TrailRun/VirtualRun),
 * doubles cadence through {@link activityCadenceSpm} (the one home for
 * strides-to-steps doubling), and derives pace from `average_speed`.
 * Activities without the run types are dropped; a run with no recorded
 * cadence gets `averageCadence: 0` rather than being dropped, matching the
 * Strava-era behaviour this replaces.
 */
export function buildCadenceTrendData(
  activities: IntervalsActivity[],
  options: { weeks: number },
): CadenceTrendData {
  const runs = activities.filter((a) => a.type && isPaceActivity(a.type));

  const summaries: RunSummary[] = runs.map((a) => {
    const type = a.type ?? "Run";
    const avgSpeed = a.average_speed ?? 0;
    const avgPace = avgSpeed > 0 ? 1000 / avgSpeed / 60 : 0;
    return {
      id: a.id,
      name: a.name ?? type,
      date: a.start_date_local.split("T")[0]!,
      distance: Math.round(((a.distance ?? 0) / 1000) * 100) / 100,
      duration: a.moving_time ?? 0,
      averageCadence: activityCadenceSpm(a.average_cadence, type) ?? 0,
      averagePace: Math.round(avgPace * 100) / 100,
      type,
    };
  });

  return { weeks: options.weeks, activities: summaries };
}
