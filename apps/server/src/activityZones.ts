/**
 * Pure mapping for the activity-zones MCP App feed. Turns one intervals.icu
 * activity's own recorded zone bounds and zone times into the chart-ready
 * payload that `get-activity-zones-data` returns, unit-tested in
 * `activityZones.test.ts`. The `get-activity-zones` text tool formats the
 * same fetch as prose; this feed carries per-bucket seconds and percentages
 * so the chart and the text can never disagree on the numbers.
 */
import { type ZoneSet } from "@intervals-mcp/data";
import { type IntervalsActivity } from "./intervalsClient";

export interface ActivityZonesData {
  activityId: string;
  name: string;
  /** Local start date, ISO. */
  date: string;
  type: string;
  zoneSets: ZoneSet[];
  /** Set when HR zones were dropped because bounds/times counts disagreed. */
  hrZoneWarning: string | null;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Builds one zone set from parallel bounds/times arrays. Bounds are the
 * zone's upper edge (intervals.icu sends a real number for the top zone,
 * never an open-ended sentinel); zone 1's lower edge is always 0. Returns
 * null whenever the data can't be trusted: no bounds, no times, a bounds/
 * times count mismatch (would mislabel recorded time under the wrong zone),
 * or nothing recorded.
 *
 * Exported so the sport-settings fallback in `tools/getActivity.ts` and
 * `tools/getRunningSummary.ts` can build a zone set from a fallback bounds
 * array with the same min/max/pct derivation as the activity's own zones,
 * rather than each re-deriving zone edges from a bounds array by hand.
 */
export function buildZoneSet(
  type: ZoneSet["type"],
  unit: ZoneSet["unit"],
  bounds: number[] | null | undefined,
  times: number[] | null | undefined,
): ZoneSet | null {
  if (!bounds || bounds.length === 0) return null;
  if (!times || times.length === 0) return null;
  if (bounds.length !== times.length) return null;

  const totalSeconds = times.reduce((sum, t) => sum + (t ?? 0), 0);
  if (totalSeconds <= 0) return null;

  return {
    type,
    unit,
    // intervals.icu doesn't flag whether these zone times came from a real
    // sensor; unlike Strava's response, there is nothing to read here.
    sensorBased: null,
    totalSeconds,
    buckets: bounds.map((max, i) => ({
      zone: i + 1,
      min: i === 0 ? 0 : (bounds[i - 1] ?? 0),
      max,
      seconds: times[i] ?? 0,
      pct: round1(((times[i] ?? 0) / totalSeconds) * 100),
    })),
  };
}

/**
 * Maps one intervals.icu activity to chart-ready zone sets: heart rate from
 * `icu_hr_zones` + `icu_hr_zone_times`, and power from `icu_power_zones` +
 * `icu_zone_times` when both are present. Pace zones are out of scope
 * (Phase 4). The one mapper both `get-activity-zones` and the
 * activity-zones MCP App data handler read, so they can't disagree.
 */
export function mapIntervalsZones(activity: IntervalsActivity): ZoneSet[] {
  const sets: ZoneSet[] = [];

  const hr = buildZoneSet(
    "heartrate",
    "bpm",
    activity.icu_hr_zones,
    activity.icu_hr_zone_times,
  );
  if (hr) sets.push(hr);

  const powerTimes =
    activity.icu_zone_times?.map((entry) => entry.secs ?? 0) ?? null;
  const power = buildZoneSet(
    "power",
    "W",
    activity.icu_power_zones,
    powerTimes,
  );
  if (power) sets.push(power);

  return sets;
}

/**
 * Explains why heart rate zones are missing from `mapIntervalsZones`'
 * output when the activity did record HR zone bounds and times but their
 * counts don't match: the one case worth surfacing to the model rather
 * than silently returning fewer zone sets, since it means the athlete's
 * settings changed between when the zones were recorded and now. Null
 * whenever HR zones are present, or absent for an unremarkable reason
 * (no bounds/times recorded at all).
 */
export function hrZoneMismatchWarning(
  activity: IntervalsActivity,
): string | null {
  const bounds = activity.icu_hr_zones;
  const times = activity.icu_hr_zone_times;
  if (!bounds || bounds.length === 0) return null;
  if (!times || times.length === 0) return null;
  if (bounds.length === times.length) return null;

  return `Heart rate zones omitted: recorded bounds (${bounds.length} zones) do not match the recorded zone times (${times.length} zones).`;
}
