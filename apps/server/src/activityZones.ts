/**
 * Pure mapping for the activity-zones MCP App feed. Turns one intervals.icu
 * activity's own recorded zone bounds and zone times into the chart-ready
 * payload that `get-activity-zones-data` returns, unit-tested in
 * `activityZones.test.ts`. The `get-activity-zones` text tool formats the
 * same fetch as prose; this feed carries per-bucket seconds and percentages
 * so the chart and the text can never disagree on the numbers.
 */
import { type PaceBasis, type ZoneSet } from "@intervals-mcp/data";
import { round } from "./formatters";
import {
  type IntervalsActivity,
  type IntervalsSportSettings,
} from "./intervalsClient";

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

/** One zone's range, from ascending upper bounds. */
export interface ZoneRange {
  /** 1-based zone number. */
  zone: number;
  /** The previous zone's upper bound; the zone starts above it. 0 for zone 1. */
  min: number;
  /** This zone's upper bound, inclusive (docs/api-notes.md). */
  max: number;
}

/** intervals.icu's open top for pace (and power) zones: 999% of threshold. */
export const OPEN_TOP_PCT = 999;

/**
 * The one home for turning ascending zone upper bounds into ranges: zone 1
 * starts at 0, and each later zone starts at the previous zone's upper
 * bound. {@link buildZoneSet} (an activity's zone time) and
 * `athleteZones.ts` (the athlete's settings: HR and pace zones) both call
 * it, so the two cannot disagree on where a zone starts.
 */
export function zoneRanges(bounds: readonly number[]): ZoneRange[] {
  return bounds.map((max, i) => ({
    zone: i + 1,
    min: i === 0 ? 0 : (bounds[i - 1] ?? 0),
    max,
  }));
}

/** HR zone range text; its one home is `packages/data` (the app prints it too). */
export { hrZoneRangeText } from "@intervals-mcp/data";

/**
 * Builds one zone set from parallel bounds/times arrays. Bounds are the
 * zone's upper edge (intervals.icu sends a real number for the top zone,
 * never an open-ended sentinel); the ranges come from {@link zoneRanges}, so
 * zone 1's lower edge is always 0. Returns
 * null whenever the data can't be trusted: no bounds, no times, a bounds/
 * times count mismatch (would mislabel recorded time under the wrong zone),
 * or nothing recorded.
 *
 * The sport-settings fallback in {@link resolveHrZones} builds its zone set
 * here too, with the same min/max/pct derivation as the activity's own
 * zones.
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
    buckets: zoneRanges(bounds).map((range, i) => ({
      ...range,
      seconds: times[i] ?? 0,
      pct: round(((times[i] ?? 0) / totalSeconds) * 100, 1),
    })),
  };
}

/**
 * The activity's pace zone time as a zone set, or null. The bounds are the
 * activity's own `pace_zones` (percent of its `threshold_pace`, docs/api-
 * notes.md) as speeds in m/s, through {@link buildZoneSet}; the open top
 * zone (999%) keeps no fast limit. Seconds come from `gap_zone_times` when
 * the activity's `use_gap_zone_times` is set and it recorded them, else from
 * `pace_zone_times`, and `basis` says which.
 */
function buildPaceZoneSet(activity: IntervalsActivity): ZoneSet | null {
  const threshold = activity.threshold_pace;
  const percents = activity.pace_zones;
  if (!threshold || threshold <= 0 || !percents || percents.length === 0) {
    return null;
  }
  const basis: PaceBasis =
    activity.use_gap_zone_times && activity.gap_zone_times?.length
      ? "gap"
      : "pace";
  const set = buildZoneSet(
    "pace",
    "m/s",
    percents.map((pct) => round((threshold * pct) / 100, 3)),
    basis === "gap" ? activity.gap_zone_times : activity.pace_zone_times,
  );
  if (!set) return null;
  return {
    ...set,
    basis,
    buckets: set.buckets.map((bucket, i) =>
      (percents[i] ?? 0) >= OPEN_TOP_PCT ? { ...bucket, max: null } : bucket,
    ),
  };
}

/**
 * Maps one intervals.icu activity to chart-ready zone sets: heart rate from
 * `icu_hr_zones` + `icu_hr_zone_times`, then pace ({@link buildPaceZoneSet}).
 * Power zones are dropped for now (see docs/api-notes.md: they are likely
 * percent-of-FTP with an extra SS time entry, unverifiable on this account)
 * rather than shipped unverified. The one mapper both `get-activity-zones`
 * and the activity-zones MCP App data handler read, so they can't disagree.
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

  const pace = buildPaceZoneSet(activity);
  if (pace) sets.push(pace);

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

/** HR zone bounds for one activity's recorded zone times, and where they came from. */
export type ResolvedHrZones =
  | { set: ZoneSet; source: "activity" | "sport_settings"; note: null }
  /** `note` says why there is no set; null when there were no zone times. */
  | { set: null; source: null; note: string | null };

/**
 * The one home for HR zone bound resolution, shared by `get-activity`
 * (`hr_zones`) and `get-running-summary` (`hr_zone_summary`). The
 * activity's own recorded `icu_hr_zones` come first, through
 * `mapIntervalsZones`, the same source `get-activity-zones` reads: they are
 * the right settings group for any type and survive a later edit of the
 * athlete's zones. `sportSettings` (the Run group) is a fallback only when
 * the activity has no bounds of its own and the group's `types` names this
 * activity's type: a Walk or Hike is a different group with its own bounds
 * and zone count. Returns no set, with a note, rather than label recorded
 * zone times under bounds that do not match them.
 */
export function resolveHrZones(
  activity: IntervalsActivity,
  sportSettings: IntervalsSportSettings | null,
  type: string,
): ResolvedHrZones {
  const times = activity.icu_hr_zone_times;
  if (!times || times.length === 0) {
    return { set: null, source: null, note: null };
  }

  const own = mapIntervalsZones(activity).find(
    (set) => set.type === "heartrate",
  );
  if (own) return { set: own, source: "activity", note: null };

  // The activity has bounds, but `mapIntervalsZones` dropped them (a
  // bounds/times count mismatch, or no time recorded): sport settings
  // cannot safely paper over that.
  if (activity.icu_hr_zones && activity.icu_hr_zones.length > 0) {
    return {
      set: null,
      source: null,
      note: hrZoneMismatchWarning(activity) ?? "No time recorded in HR zones.",
    };
  }

  const bounds =
    sportSettings?.types?.includes(type) &&
    sportSettings.hr_zones &&
    sportSettings.hr_zones.length > 0
      ? sportSettings.hr_zones
      : null;
  if (!bounds) {
    return {
      set: null,
      source: null,
      note: "HR zone bounds are unavailable; recorded zone times could not be labelled.",
    };
  }
  if (bounds.length !== times.length) {
    return {
      set: null,
      source: null,
      note: `HR zone bounds (${bounds.length} zones) do not match the recorded zone times (${times.length} zones); omitted.`,
    };
  }

  const fallback = buildZoneSet("heartrate", "bpm", bounds, times);
  return fallback
    ? { set: fallback, source: "sport_settings", note: null }
    : { set: null, source: null, note: "No time recorded in HR zones." };
}
