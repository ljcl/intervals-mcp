/**
 * The athlete's own zones and thresholds from intervals.icu sport settings,
 * and the LTHR and max HR checks against intervals.icu's HR curves (#79).
 * Pure: `get-athlete-zones` fetches, this maps. Zone ranges come from
 * `zoneRanges` (`activityZones.ts`), the rule every zone tool uses.
 */
import { isSwimming, speedDisplayForSport } from "@intervals-mcp/data";
import { zoneRanges } from "./activityZones";
import { round } from "./formatters";
import {
  type IntervalsAthleteHrCurves,
  type IntervalsSportSettings,
} from "./intervalsClient";
import { formatPaceSeconds, metersPerSecToPace } from "./utils/running";

// ---------- sport resolution ----------

/** Lower case, letters only: "Trail Run" and "trailrun" both give "trailrun". */
const normalise = (value: string) => value.toLowerCase().replace(/[^a-z]/g, "");

/**
 * Every activity type intervals.icu knows: the `SportSettings.types` enum in
 * docs/intervals-openapi.json. Only these types fall back to the Other
 * group. intervals.icu answers 404 for any other word, such as "Running"
 * (docs/api-notes.md).
 */
const INTERVALS_ACTIVITY_TYPES = [
  "Ride",
  "Run",
  "Swim",
  "WeightTraining",
  "Hike",
  "Walk",
  "AlpineSki",
  "BackcountrySki",
  "Badminton",
  "Canoeing",
  "Crossfit",
  "EBikeRide",
  "EMountainBikeRide",
  "Elliptical",
  "Golf",
  "GravelRide",
  "TrackRide",
  "Handcycle",
  "HighIntensityIntervalTraining",
  "Hockey",
  "IceSkate",
  "InlineSkate",
  "Kayaking",
  "Kitesurf",
  "MountainBikeRide",
  "Cyclocross",
  "NordicSki",
  "OpenWaterSwim",
  "Padel",
  "Pilates",
  "Pickleball",
  "Racquetball",
  "Rugby",
  "RockClimbing",
  "RollerSki",
  "Rowing",
  "Sail",
  "Skateboard",
  "Snowboard",
  "Snowshoe",
  "Soccer",
  "Squash",
  "StairStepper",
  "StandUpPaddling",
  "Surfing",
  "TableTennis",
  "Tennis",
  "TrailRun",
  "Transition",
  "Velomobile",
  "VirtualRide",
  "VirtualRow",
  "VirtualRun",
  "VirtualSki",
  "WaterSport",
  "Wheelchair",
  "Windsurf",
  "Workout",
  "Yoga",
  "Other",
] as const;

/** intervals.icu's own spelling of `value` as an activity type, ignoring
 * case and spaces ("rowing" gives "Rowing"), or null for a word that is not
 * an activity type. */
export function intervalsActivityType(value: string): string | null {
  const wanted = normalise(value);
  return (
    INTERVALS_ACTIVITY_TYPES.find((type) => normalise(type) === wanted) ?? null
  );
}

export interface ResolvedSportGroup {
  group: IntervalsSportSettings;
  /** The group's own spelling of the matched type, or intervals.icu's
   * spelling of the type when the default Other group applies. */
  sport: string;
  /** True when no group lists the sport and the `other: true` group applies. */
  defaultGroup: boolean;
}

/**
 * Picks the settings group for `sport`: the group whose `types` list it,
 * ignoring case and spaces. An intervals.icu activity type that no group
 * lists gets the group with `other: true`, as `GET /sport-settings/{type}`
 * does (docs/api-notes.md). Null when there is no such group, or when
 * `sport` is not an activity type at all: "Running" must not silently give
 * the Other group's zones.
 */
export function resolveSportGroup(
  groups: IntervalsSportSettings[],
  sport: string,
): ResolvedSportGroup | null {
  const wanted = normalise(sport);
  for (const group of groups) {
    const match = group.types?.find((type) => normalise(type) === wanted);
    if (match) return { group, sport: match, defaultGroup: false };
  }
  const type = intervalsActivityType(sport);
  const fallback = groups.find((group) => group.other === true);
  return type && fallback
    ? { group: fallback, sport: type, defaultGroup: true }
    : null;
}

/** The types of each group, for a reply that names the groups. */
export function groupTypes(groups: IntervalsSportSettings[]): string[][] {
  return groups.map((group) => group.types ?? []);
}

// ---------- zones and threshold pace ----------

/** intervals.icu's open top for pace (and power) zones: 999% of threshold. */
const OPEN_TOP_PCT = 999;

export interface AthleteHrZone {
  zone: number;
  name: string | null;
  min_bpm: number;
  max_bpm: number;
}

export function mapHrZones(group: IntervalsSportSettings): AthleteHrZone[] {
  return zoneRanges(group.hr_zones ?? []).map((range) => ({
    zone: range.zone,
    name: group.hr_zone_names?.[range.zone - 1] ?? null,
    min_bpm: range.min,
    max_bpm: range.max,
  }));
}

/** True when a group's types include Swim or OpenWaterSwim, so its paces
 * also read per 100 m. */
export function coversSwim(types: readonly string[] | undefined): boolean {
  return (types ?? []).some(isSwimming);
}

/** A usable speed in m/s, or null. */
function validSpeed(mps: number | null | undefined): number | null {
  return mps != null && Number.isFinite(mps) && mps > 0 ? mps : null;
}

/** Pace per 100 m as m:ss, through the MCP Apps' own swim conversion
 * (`speedDisplay`), so a speed too slow to be a pace there has none here. */
function pacePer100m(mps: number): string | null {
  const minutes = speedDisplayForSport("swim").fromMps(mps);
  return minutes === null ? null : formatPaceSeconds(minutes * 60);
}

export interface ThresholdPace {
  threshold_speed_mps: number | null;
  threshold_pace_min_per_km: string | null;
  threshold_pace_min_per_100m: string | null;
}

/**
 * intervals.icu's `threshold_pace` is a speed in m/s (docs/api-notes.md).
 * Pace per km for every group; pace per 100 m for a swim group only.
 */
export function mapThresholdPace(group: IntervalsSportSettings): ThresholdPace {
  const mps = validSpeed(group.threshold_pace);
  if (mps === null) {
    return {
      threshold_speed_mps: null,
      threshold_pace_min_per_km: null,
      threshold_pace_min_per_100m: null,
    };
  }
  return {
    threshold_speed_mps: round(mps, 3),
    threshold_pace_min_per_km: metersPerSecToPace(mps)?.minPerKm ?? null,
    threshold_pace_min_per_100m: coversSwim(group.types)
      ? pacePer100m(mps)
      : null,
  };
}

export interface AthletePaceZone {
  zone: number;
  name: string | null;
  min_pct: number;
  max_pct: number | null;
  slowest_min_per_km: string | null;
  fastest_min_per_km: string | null;
  slowest_min_per_100m: string | null;
  fastest_min_per_100m: string | null;
}

/**
 * Pace zones are percentages of threshold speed, not of pace
 * (docs/api-notes.md). A zone's slowest pace is at `min_pct` (none for zone
 * 1) and its fastest at `max_pct` (none for the open top zone). With no
 * threshold pace, only the percentages are known.
 */
export function mapPaceZones(group: IntervalsSportSettings): AthletePaceZone[] {
  const threshold = validSpeed(group.threshold_pace);
  const swim = coversSwim(group.types);
  const paceAt = (pct: number, unit: "km" | "100m"): string | null => {
    if (threshold === null) return null;
    const mps = (threshold * pct) / 100;
    return unit === "100m"
      ? pacePer100m(mps)
      : (metersPerSecToPace(mps)?.minPerKm ?? null);
  };
  return zoneRanges(group.pace_zones ?? []).map((range) => {
    const open = range.max >= OPEN_TOP_PCT;
    // Zone 1 has no slow limit, and the open top zone no fast limit.
    const slowest = range.min > 0;
    const fastest = !open;
    return {
      zone: range.zone,
      name: group.pace_zone_names?.[range.zone - 1] ?? null,
      min_pct: range.min,
      max_pct: open ? null : range.max,
      slowest_min_per_km: slowest ? paceAt(range.min, "km") : null,
      fastest_min_per_km: fastest ? paceAt(range.max, "km") : null,
      slowest_min_per_100m: swim && slowest ? paceAt(range.min, "100m") : null,
      fastest_min_per_100m: swim && fastest ? paceAt(range.max, "100m") : null,
    };
  });
}

// ---------- heart rate bests and threshold checks ----------

/** The HR curves `get-athlete-zones` reads, in one request. */
export const HR_CURVE_IDS = ["90d", "1y"] as const;
export type HrCurveId = (typeof HR_CURVE_IDS)[number];

interface CurvePoint {
  window: HrCurveId;
  durationS: number;
}

/** intervals.icu's LTHR rule reads a 20-minute and a 60-minute best of the
 * last 90 days (docs/api-notes.md). The 30-minute best is reported only. */
const LTHR_20_MIN: CurvePoint = { window: "90d", durationS: 1200 };
const LTHR_30_MIN: CurvePoint = { window: "90d", durationS: 1800 };
const LTHR_60_MIN: CurvePoint = { window: "90d", durationS: 3600 };
/** Max HR: the best 60-s HR of the last year. 60 s, because optical
 * sensor spikes inflate 1-5 s peaks; a year, because max HR falls with age. */
const MAX_HR_POINT: CurvePoint = { window: "1y", durationS: 60 };
/** Reported bests, in output order. */
const HR_BEST_POINTS: CurvePoint[] = [
  LTHR_20_MIN,
  LTHR_30_MIN,
  LTHR_60_MIN,
  MAX_HR_POINT,
];

/** intervals.icu takes 98% of a 20-minute best as LTHR: its LTHR_UP
 * achievements read "98% of 20m at N bpm" (docs/api-notes.md). */
const TWENTY_MIN_LTHR_FACTOR = 0.98;

/** A 20- or 60-minute best below this share of max HR is too low to show a
 * threshold. Heart rate sensor dropouts (sent as 0) averaged into a curve
 * give such bests: a ride curve can fall below 60 bpm (docs/api-notes.md). */
const DROPOUT_SHARE_OF_MAX_HR = 0.5;

export interface HrBest {
  window: HrCurveId;
  duration_s: number;
  bpm: number;
  activity_id: string | null;
  /** Local start date of that activity, YYYY-MM-DD. */
  date: string | null;
}

/** The best at one exact grid point, or null: an empty window omits its
 * curve, and a curve stops at the longest activity in its window. */
function bestAt(
  curves: IntervalsAthleteHrCurves,
  { window, durationS }: CurvePoint,
): HrBest | null {
  const curve = curves.list.find((c) => c.id === window);
  if (!curve) return null;
  const index = curve.secs.indexOf(durationS);
  if (index < 0) return null;
  const bpm = curve.values[index];
  if (bpm == null || bpm <= 0) return null;
  const activityId = curve.activity_id[index] ?? null;
  const start = activityId
    ? curves.activities[activityId]?.start_date_local
    : null;
  return {
    window,
    duration_s: durationS,
    bpm,
    activity_id: activityId,
    date: start ? start.slice(0, 10) : null,
  };
}

/** The 20-, 30- and 60-minute bests of the last 90 days and the 60-s best
 * of the last year, each when the curves have it. */
export function hrBests(curves: IntervalsAthleteHrCurves): HrBest[] {
  return HR_BEST_POINTS.map((point) => bestAt(curves, point)).filter(
    (best): best is HrBest => best !== null,
  );
}

export interface LthrEstimate {
  bpm: number;
  /** The curve point behind the estimate. */
  basis: HrBest;
}

/**
 * intervals.icu's own LTHR rule: the higher of the best 60-minute heart rate
 * and 98% of the best 20-minute heart rate (rounded), both of the last 90
 * days. Its LTHR_UP achievements match it on every probed case
 * (docs/api-notes.md). A missing point drops out; on a tie the 60-minute
 * best wins, because it needs no factor. Null when both are missing.
 */
export function lthrEstimate(
  curves: IntervalsAthleteHrCurves,
): LthrEstimate | null {
  const hour = bestAt(curves, LTHR_60_MIN);
  const twenty = bestAt(curves, LTHR_20_MIN);
  const fromHour = hour ? { bpm: hour.bpm, basis: hour } : null;
  const fromTwenty = twenty
    ? { bpm: Math.round(TWENTY_MIN_LTHR_FACTOR * twenty.bpm), basis: twenty }
    : null;
  if (fromHour && fromTwenty) {
    return fromTwenty.bpm > fromHour.bpm ? fromTwenty : fromHour;
  }
  return fromHour ?? fromTwenty;
}

/** What happened to the HR curve read. */
export type HrCurveRead =
  | { status: "read"; curves: IntervalsAthleteHrCurves }
  /** The Other group: intervals.icu answers with the Run curve for its
   * types (docs/api-notes.md), so the tool does not read it. */
  | { status: "skipped_other_group" }
  /** `reason` is a clause from `unavailableReason`. */
  | { status: "failed"; reason: string };

export interface ThresholdCheck {
  status: "above" | "not_above" | "unknown";
  setting_bpm: number | null;
  estimate_bpm: number | null;
  basis: HrBest | null;
  message: string;
}

const NOT_CHECKED_OTHER =
  "Not checked: intervals.icu has no heart rate curve for the Other group.";
const NOT_CHECKED_FAILED =
  "Not checked: the heart rate curves could not be read.";

/** " (2026-08-30, i300000002)", leaving out what is unknown. */
function where(best: HrBest): string {
  const parts = [best.date, best.activity_id].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** "LTHR estimate 174 bpm: 98% of your best 20-minute heart rate ...".
 * Only for a check that is `above`: a lower number is not an estimate of
 * LTHR, only of what the efforts in the window held. */
function lthrEstimateSentence(estimate: LthrEstimate): string {
  const { basis } = estimate;
  const details = [`${basis.bpm} bpm`, basis.date, basis.activity_id]
    .filter((part): part is string => part !== null)
    .join(", ");
  const source =
    basis.duration_s === LTHR_20_MIN.durationS
      ? "98% of your best 20-minute heart rate in the last 90 days"
      : "your best 60-minute heart rate in the last 90 days";
  return `LTHR estimate ${estimate.bpm} bpm: ${source} (${details}).`;
}

/** How intervals.icu's rule got its number: "98% of your best 20-minute
 * heart rate (178 bpm, ...) is 174 bpm", or "your best 60-minute heart rate
 * is 171 bpm (...)". */
function lthrRuleClause(estimate: LthrEstimate): string {
  const { basis } = estimate;
  if (basis.duration_s === LTHR_20_MIN.durationS) {
    const details = [`${basis.bpm} bpm`, basis.date, basis.activity_id]
      .filter((part): part is string => part !== null)
      .join(", ");
    return `98% of your best 20-minute heart rate (${details}) is ${estimate.bpm} bpm`;
  }
  return `your best 60-minute heart rate is ${basis.bpm} bpm${where(basis)}`;
}

/** Why a best below the dropout floor is not used. */
function dropoutClause(best: HrBest): string {
  return `your best ${best.duration_s / 60}-minute heart rate in the last 90 days is ${best.bpm} bpm${where(best)}, less than half of your max heart rate. That is too low to show a threshold; heart rate sensor dropouts can cause it.`;
}

function maxHrBestSentence(best: HrBest): string {
  return `Your best 60-second heart rate in the last year is ${best.bpm} bpm${where(best)}.`;
}

/**
 * The lowest heart rate an LTHR estimate can be and still come from an
 * effort: {@link DROPOUT_SHARE_OF_MAX_HR} of the higher of the max HR
 * setting and the best 60-s heart rate of the last year. 0 when neither is
 * known, so nothing is left out.
 */
function dropoutFloor(
  maxHr: number | null,
  curves: IntervalsAthleteHrCurves,
): number {
  const peak = Math.max(maxHr ?? 0, bestAt(curves, MAX_HR_POINT)?.bpm ?? 0);
  return peak * DROPOUT_SHARE_OF_MAX_HR;
}

/**
 * The LTHR check, from intervals.icu's own rule ({@link lthrEstimate}). Only
 * `above` calls the number an LTHR estimate. An estimate below the dropout
 * floor ({@link dropoutFloor}, from `maxHr`) is not used: the check is
 * `unknown` and the message names the best.
 */
export function checkLthr(
  lthr: number | null,
  hrCurve: HrCurveRead,
  maxHr: number | null,
): ThresholdCheck {
  const raw = hrCurve.status === "read" ? lthrEstimate(hrCurve.curves) : null;
  const dropout =
    raw !== null &&
    hrCurve.status === "read" &&
    raw.bpm < dropoutFloor(maxHr, hrCurve.curves);
  const estimate = dropout ? null : raw;
  const known = {
    setting_bpm: lthr,
    estimate_bpm: estimate?.bpm ?? null,
    basis: estimate?.basis ?? null,
  };
  if (lthr === null) {
    let tail = "";
    if (estimate) {
      tail = ` By intervals.icu's rule, your heart rate bests in the last 90 days put LTHR at ${estimate.bpm} bpm or higher: ${lthrRuleClause(estimate)}.`;
    } else if (dropout && raw) {
      tail = ` The heart rate bests were not used: ${dropoutClause(raw.basis)}`;
    }
    return {
      status: "unknown",
      ...known,
      message: `No LTHR is set for this sport.${tail}`,
    };
  }
  if (hrCurve.status === "skipped_other_group") {
    return { status: "unknown", ...known, message: NOT_CHECKED_OTHER };
  }
  if (hrCurve.status === "failed") {
    return { status: "unknown", ...known, message: NOT_CHECKED_FAILED };
  }
  if (dropout && raw) {
    return {
      status: "unknown",
      ...known,
      message: `Not checked: ${dropoutClause(raw.basis)}`,
    };
  }
  if (!estimate) {
    return {
      status: "unknown",
      ...known,
      message:
        "Not checked: no 20-minute or 60-minute heart rate best in the last 90 days.",
    };
  }
  if (estimate.bpm > lthr) {
    return {
      status: "above",
      ...known,
      message: `${lthrEstimateSentence(estimate)} This is above your LTHR of ${lthr} bpm. Your LTHR may be out of date: do a threshold test, or update LTHR in intervals.icu. First, check the heart rate of that activity for sensor errors.`,
    };
  }
  return {
    status: "not_above",
    ...known,
    message: `No heart rate best in the last 90 days points above your LTHR of ${lthr} bpm: ${lthrRuleClause(estimate)}.`,
  };
}

/** The max HR check: the best 60-s heart rate of the last year. */
export function checkMaxHr(
  maxHr: number | null,
  hrCurve: HrCurveRead,
): ThresholdCheck {
  const best =
    hrCurve.status === "read" ? bestAt(hrCurve.curves, MAX_HR_POINT) : null;
  const known = {
    setting_bpm: maxHr,
    estimate_bpm: best?.bpm ?? null,
    basis: best,
  };
  if (maxHr === null) {
    const tail = best ? ` ${maxHrBestSentence(best)}` : "";
    return {
      status: "unknown",
      ...known,
      message: `No max HR is set for this sport.${tail}`,
    };
  }
  if (hrCurve.status === "skipped_other_group") {
    return { status: "unknown", ...known, message: NOT_CHECKED_OTHER };
  }
  if (hrCurve.status === "failed") {
    return { status: "unknown", ...known, message: NOT_CHECKED_FAILED };
  }
  if (!best) {
    return {
      status: "unknown",
      ...known,
      message: "Not checked: no 60-second heart rate best in the last year.",
    };
  }
  if (best.bpm > maxHr) {
    return {
      status: "above",
      ...known,
      message: `${maxHrBestSentence(best)} This is above your max HR of ${maxHr} bpm. Your max HR may be set too low. First, check the heart rate of that activity for spikes.`,
    };
  }
  return {
    status: "not_above",
    ...known,
    message: `${maxHrBestSentence(best)} This is not above your max HR of ${maxHr} bpm.`,
  };
}

// ---------- the payload ----------

export interface AthleteZonesResponse extends ThresholdPace {
  sport: string;
  settings_types: string[];
  default_group: boolean;
  lthr_bpm: number | null;
  max_hr_bpm: number | null;
  hr_zones: AthleteHrZone[];
  pace_units: string | null;
  pace_zones: AthletePaceZone[];
  ftp_watts: number | null;
  hr_bests: HrBest[];
  threshold_checks: { lthr: ThresholdCheck; max_hr: ThresholdCheck };
  other_groups: string[][];
  warnings: string[];
  units: {
    hr: "bpm";
    time: "s";
    pace: "min/km";
    swim_pace: "min/100m";
    power: "W";
    pace_zones: "% of threshold speed";
  };
}

/** `get-athlete-zones`' structured payload, from the groups it read, the
 * resolved group and the HR curve read. */
export function buildAthleteZones(
  groups: IntervalsSportSettings[],
  resolved: ResolvedSportGroup,
  hrCurve: HrCurveRead,
): AthleteZonesResponse {
  const { group } = resolved;
  const lthr = group.lthr ?? null;
  const maxHr = group.max_hr ?? null;

  const warnings: string[] = [];
  if (resolved.defaultGroup) {
    warnings.push(
      `No settings group lists ${resolved.sport}, so these are intervals.icu's default Other settings.`,
    );
  }
  if (hrCurve.status === "failed") {
    warnings.push(
      `Heart rate curves not read: ${hrCurve.reason}. LTHR and max HR were not checked.`,
    );
  }

  return {
    sport: resolved.sport,
    settings_types: group.types ?? [],
    default_group: resolved.defaultGroup,
    lthr_bpm: lthr,
    max_hr_bpm: maxHr,
    hr_zones: mapHrZones(group),
    ...mapThresholdPace(group),
    pace_units: group.pace_units ?? null,
    pace_zones: mapPaceZones(group),
    ftp_watts: group.ftp ?? null,
    hr_bests: hrCurve.status === "read" ? hrBests(hrCurve.curves) : [],
    threshold_checks: {
      lthr: checkLthr(lthr, hrCurve, maxHr),
      max_hr: checkMaxHr(maxHr, hrCurve),
    },
    other_groups: groupTypes(groups.filter((g) => g !== group)),
    warnings,
    units: {
      hr: "bpm",
      time: "s",
      pace: "min/km",
      swim_pace: "min/100m",
      power: "W",
      pace_zones: "% of threshold speed",
    },
  };
}
