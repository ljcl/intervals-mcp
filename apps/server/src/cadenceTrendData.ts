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
  /** Run-type activities in the window with no recorded cadence, left out
   * of `activities` (see {@link buildCadenceTrendData}) rather than counted
   * toward it. */
  excludedNoCadence: number;
}

/**
 * Builds the cadence-trend feed from a window of activities already fetched
 * via `listActivities`: filters to run types (Run/TrailRun/VirtualRun),
 * doubles cadence through {@link activityCadenceSpm} (the one home for
 * strides-to-steps doubling), and derives pace from `average_speed`.
 * Activities without a run type are dropped. A run whose device recorded no
 * cadence is left out of `activities` too, rather than plotted at a
 * fabricated `averageCadence: 0`: a zero nobody ran would drag the trend
 * line and every average toward it; `excludedNoCadence` counts how many
 * were left out so the view/text summary can say so.
 */
export function buildCadenceTrendData(
  activities: IntervalsActivity[],
  options: { weeks: number },
): CadenceTrendData {
  const runs = activities.filter((a) => a.type && isPaceActivity(a.type));

  const summaries: RunSummary[] = [];
  let excludedNoCadence = 0;

  for (const a of runs) {
    const type = a.type ?? "Run";
    const averageCadence = activityCadenceSpm(a.average_cadence, type);
    if (averageCadence == null) {
      excludedNoCadence += 1;
      continue;
    }
    const avgSpeed = a.average_speed ?? 0;
    const avgPace = avgSpeed > 0 ? 1000 / avgSpeed / 60 : 0;
    summaries.push({
      id: a.id,
      name: a.name ?? type,
      date: a.start_date_local.split("T")[0]!,
      distance: Math.round(((a.distance ?? 0) / 1000) * 100) / 100,
      duration: a.moving_time ?? 0,
      averageCadence,
      averagePace: Math.round(avgPace * 100) / 100,
      type,
    });
  }

  return { weeks: options.weeks, activities: summaries, excludedNoCadence };
}
