/**
 * Pure cadence-trend aggregation shared by the `view-cadence-trends` text
 * summary and the `get-cadence-trend-data` MCP App feed. Filtering,
 * cadence-doubling, and date handling live here once, so the two surfaces
 * can never disagree.
 */

import {
  cadencePaceRegression,
  computeZoneStats,
  PACE_ZONES,
  type PaceZone,
  windowLabel,
} from "@intervals-mcp/data";
import { formatSigned, round } from "./formatters";
import { type IntervalsActivity } from "./intervalsClient";
import {
  activityCadenceSpm,
  formatPaceSeconds,
  isPaceActivity,
} from "./utils/running";

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
  /** `null` when the device recorded no speed: never a fabricated 0 min/km
   * (which would read as impossibly fast). The run still counts toward
   * cadence-based views; pace-based views exclude it, mirroring how
   * cadence-less runs are excluded from `activities` entirely. */
  averagePace: number | null;
  type: string;
}

/** Response shape for `get-cadence-trend-data`. */
export interface CadenceTrendData {
  /** Days of history the window covers, as requested. */
  days: number;
  activities: RunSummary[];
  /** Run-type activities in the window with no recorded cadence, left out
   * of `activities` (see {@link buildCadenceTrendData}) rather than counted
   * toward it. */
  excludedNoCadence: number;
  /** Runs included in `activities` (they have cadence) but with no recorded
   * speed, so `averagePace` is `null` there: counted here the same way
   * `excludedNoCadence` counts the cadence-less runs, so pace-based views
   * can say how many of the plotted runs they're leaving out. */
  noPaceCount: number;
}

/**
 * Builds the cadence-trend feed from a window of activities already fetched
 * via `listActivities`: filters to run types (Run/TrailRun/VirtualRun),
 * doubles cadence through {@link activityCadenceSpm} (the one home for
 * strides-to-steps doubling), and derives pace from distance over moving
 * time, the rule every other activity pace uses (docs/api-notes.md, "Moving
 * time"), else from `average_speed` when the run has no distance or moving
 * time. intervals.icu's `average_speed` is distance over the watch's own
 * timer, which can differ from its `moving_time` by half a minute an hour.
 * Activities without a run type are dropped. A run whose device recorded no
 * cadence is left out of `activities` too, rather than plotted at a
 * fabricated `averageCadence: 0`: a zero nobody ran would drag the trend
 * line and every average toward it; `excludedNoCadence` counts how many
 * were left out so the view/text summary can say so.
 */
export function buildCadenceTrendData(
  activities: IntervalsActivity[],
  options: { days: number },
): CadenceTrendData {
  const runs = activities.filter((a) => a.type && isPaceActivity(a.type));

  const summaries: RunSummary[] = [];
  let excludedNoCadence = 0;
  let noPaceCount = 0;

  for (const a of runs) {
    const type = a.type ?? "Run";
    const averageCadence = activityCadenceSpm(a.average_cadence, type);
    if (averageCadence == null) {
      excludedNoCadence += 1;
      continue;
    }
    const avgSpeed =
      a.distance && a.distance > 0 && a.moving_time && a.moving_time > 0
        ? a.distance / a.moving_time
        : (a.average_speed ?? 0);
    let averagePace: number | null = null;
    if (avgSpeed > 0) {
      averagePace = Math.round((1000 / avgSpeed / 60) * 100) / 100;
    } else {
      noPaceCount += 1;
    }
    summaries.push({
      id: a.id,
      name: a.name ?? type,
      date: a.start_date_local.split("T")[0]!,
      distance: Math.round(((a.distance ?? 0) / 1000) * 100) / 100,
      duration: a.moving_time ?? 0,
      averageCadence,
      averagePace,
      type,
    });
  }

  return {
    days: options.days,
    activities: summaries,
    excludedNoCadence,
    noPaceCount,
  };
}

/** Runs the view-cadence-trends text lists one by one; a longer window
 * names how many more there are. */
export const MAX_CADENCE_RUN_LINES = 60;

/** "faster than 4:00 /km", "4:00 to 4:30 /km", "slower than 5:30 /km". */
function zoneRangeText(zone: PaceZone, index: number): string {
  const pace = (minPerKm: number) => formatPaceSeconds(minPerKm * 60);
  if (index === 0) return `faster than ${pace(zone.maxPace)} /km`;
  if (index === PACE_ZONES.length - 1)
    return `slower than ${pace(zone.minPace)} /km`;
  return `${pace(zone.minPace)} to ${pace(zone.maxPace)} /km`;
}

const runsText = (count: number) => `${count} ${count === 1 ? "run" : "runs"}`;

/**
 * The view-cadence-trends text: each run's cadence, cadence by pace zone,
 * and the cadence-against-pace slope. The zones and the slope come from
 * `@intervals-mcp/data`, the functions the app's zone and scatter views
 * draw, so the text states the chart's numbers.
 */
export function cadenceTrendLines(data: CadenceTrendData): string[] {
  const runs = data.activities;
  const average =
    runs.length > 0
      ? Math.round(
          runs.reduce((sum, a) => sum + a.averageCadence, 0) / runs.length,
        )
      : 0;
  const lines = [
    `Cadence Trends (last ${windowLabel(data.days)})`,
    `Runs: ${runs.length}`,
    `Average cadence: ${average} spm`,
    ...(data.excludedNoCadence > 0
      ? [`Excluded (no cadence recorded): ${data.excludedNoCadence}`]
      : []),
    ...(data.noPaceCount > 0
      ? [`No pace recorded (cadence only): ${data.noPaceCount}`]
      : []),
  ];
  if (runs.length === 0) return lines;

  lines.push("", "Cadence by run (newest first):");
  for (const run of runs.slice(0, MAX_CADENCE_RUN_LINES)) {
    const pace =
      run.averagePace != null
        ? `${formatPaceSeconds(run.averagePace * 60)} /km`
        : "no pace";
    lines.push(
      `  ${run.date} ${run.name}: ${run.distance.toFixed(2)} km, ${pace}, ${run.averageCadence} spm`,
    );
  }
  const more = runs.length - MAX_CADENCE_RUN_LINES;
  if (more > 0)
    lines.push(`  (${runsText(more)} more; a shorter days window lists them)`);

  lines.push("", "Cadence by pace zone:");
  for (const [index, stat] of computeZoneStats(runs).entries()) {
    const label = `  ${stat.zone.label} (${zoneRangeText(stat.zone, index)})`;
    lines.push(
      stat.count > 0
        ? `${label}: ${runsText(stat.count)}, mean ${stat.mean} spm (${stat.min} to ${stat.max})`
        : `${label}: no runs`,
    );
  }

  const fit = cadencePaceRegression(runs);
  if (!fit) {
    lines.push(
      "",
      "Cadence against pace: no line, because fewer than 2 runs have both a pace and a cadence, or they all share one pace.",
    );
    return lines;
  }
  // The slope is spm per min/km. A faster pace is a smaller number, so
  // cadence changes by -slope for each minute per km faster.
  const perMinuteFaster = round(-fit.slope, 1);
  const reading =
    Math.abs(perMinuteFaster) < 1
      ? "cadence hardly changes with pace"
      : perMinuteFaster > 0
        ? `cadence rises ${perMinuteFaster} spm for each 1:00 /km faster`
        : `cadence falls ${-perMinuteFaster} spm for each 1:00 /km faster`;
  lines.push(
    "",
    `Cadence against pace: slope ${formatSigned(round(fit.slope, 1), 1)} spm per min/km over ${runsText(fit.runs)}: ${reading}.`,
  );
  return lines;
}
