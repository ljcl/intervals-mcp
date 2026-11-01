/**
 * Zone-distribution wire types shared by the server's activity-zones feed
 * and the activity-zones MCP App, plus the one derivation both surfaces
 * print. Living here keeps the `get-activity-zones` text tool and the chart
 * agreeing on the same dominant zone for the same activity.
 */

import { type SpeedDisplay } from "./speed";

/** One zone bucket, as returned by get-activity-zones-data. */
export interface ZoneBucket {
  /** 1-based zone number (Z1 = 1). */
  zone: number;
  /** Lower bound in the set's unit (bpm, W or m/s). */
  min: number;
  /** Upper bound. HR zones always have a real number; a pace set's open
   * top zone (intervals.icu's 999 percent) is null, the fast end. */
  max: number | null;
  seconds: number;
  /** Share of the set's total time, 0–100 with one decimal. */
  pct: number;
}

/**
 * Which zone times a pace set holds: grade-adjusted (`gap`) or plain
 * (`pace`). intervals.icu picks one per activity (`use_gap_zone_times`), and
 * both surfaces say which.
 */
export type PaceBasis = "gap" | "pace";

/** One zone distribution (heart rate, power or pace). A pace set's bounds
 * are speeds in m/s: a zone's slow limit is `min`, its fast limit `max`. */
export interface ZoneSet {
  type: "heartrate" | "power" | "pace";
  unit: "bpm" | "W" | "m/s";
  /** Pace sets only: whether the seconds are grade-adjusted. */
  basis?: PaceBasis;
  /** Whether the zones came from a real sensor (null when Strava omits it). */
  sensorBased: boolean | null;
  totalSeconds: number;
  buckets: ZoneBucket[];
}

/**
 * The one home for an HR zone's range as text, used by every text tool that
 * prints HR zones and by the activity-zones app. Heart rate is whole bpm, and
 * an upper bound is inclusive (docs/api-notes.md), so the previous zone's
 * bound belongs to the zone below: zone 2 of [142, 154] reads "143-154", and
 * zone 1 reads "up to 142". A zone whose upper bound is not above the
 * previous one holds no heart rate and reads "empty". `unit` (for example
 * " bpm") follows each number range.
 */
export function hrZoneRangeText(
  { min, max }: { min: number; max: number },
  unit = "",
): string {
  if (min <= 0) return `up to ${max}${unit}`;
  const from = min + 1;
  if (from > max) return "empty";
  return from === max ? `${max}${unit}` : `${from}-${max}${unit}`;
}

/** The bucket with the most time in a set (first wins ties). */
export function dominantBucket(set: ZoneSet): ZoneBucket {
  return set.buckets.reduce((top, bucket) =>
    bucket.seconds > top.seconds ? bucket : top,
  );
}

/** Share of time at easy, moderate and hard intensity, 0-100 with one decimal. */
export interface IntensitySplit {
  easyPct: number;
  moderatePct: number;
  hardPct: number;
}

/**
 * The one home for the easy/moderate/hard rule: zones 1-2 are easy, zone 3
 * moderate, zone 4 and above hard. Follows the usual intensity distribution
 * convention for 5-zone HR and degrades
 * sensibly for the 6+-zone power sets. `secondsByZone` is seconds per zone,
 * zone 1 first; with no time at all every share is 0, so a caller that must
 * tell "no data" apart from 0% checks the total itself.
 */
export function intensitySplit(secondsByZone: number[]): IntensitySplit {
  let easy = 0;
  let moderate = 0;
  let hard = 0;
  secondsByZone.forEach((seconds, i) => {
    if (i < 2) easy += seconds;
    else if (i === 2) moderate += seconds;
    else hard += seconds;
  });
  const total = easy + moderate + hard || 1;
  const pct = (v: number) => Math.round((v / total) * 1000) / 10;
  return { easyPct: pct(easy), moderatePct: pct(moderate), hardPct: pct(hard) };
}

/** A pace set's basis in a word: "GAP" or "pace". */
export function paceBasisLabel(basis: PaceBasis): string {
  return basis === "gap" ? "GAP" : "pace";
}

/** What a pace set's seconds measure, in the words both surfaces print. */
export function paceBasisNote(basis: PaceBasis): string {
  return basis === "gap"
    ? "time by grade-adjusted pace (GAP)"
    : "time by pace, not grade-adjusted";
}

/**
 * The one home for a pace zone's range as text. A pace zone's bounds are
 * speeds (see {@link ZoneSet}); `display` turns them into pace or speed, so
 * a pace reads fastest limit first: "4'52\"-5'08\" /km". The slowest zone
 * has no slow limit ("slower than 5'30\""), and the open top zone no fast
 * limit ("faster than 3'40\""). A speed sport reads the other way round.
 * `format` defaults to the app's 5'30" style; the text tools pass m:ss.
 */
export function paceZoneRangeText(
  { min, max }: { min: number; max: number | null },
  display: SpeedDisplay,
  format: (value: number) => string = display.format,
): string {
  const at = (mps: number) => {
    const value = display.fromMps(mps);
    return value === null ? "?" : format(value);
  };
  const suffix = ` ${display.unit === "min/km" ? "/km" : display.unit}`;
  const slow = min > 0 ? at(min) : null;
  const fast = max === null ? null : at(max);
  if (display.reversed) {
    if (slow === null) return `slower than ${fast}${suffix}`;
    if (fast === null) return `faster than ${slow}${suffix}`;
    return `${fast}-${slow}${suffix}`;
  }
  if (slow === null) return `up to ${fast}${suffix}`;
  if (fast === null) return `${slow}+${suffix}`;
  return `${slow}-${fast}${suffix}`;
}
