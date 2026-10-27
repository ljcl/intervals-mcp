/**
 * Zone-distribution wire types shared by the server's activity-zones feed
 * and the activity-zones MCP App, plus the one derivation both surfaces
 * print. Living here keeps the `get-activity-zones` text tool and the chart
 * agreeing on the same dominant zone for the same activity.
 */

/** One zone bucket, as returned by get-activity-zones-data. */
export interface ZoneBucket {
  /** 1-based zone number (Z1 = 1). */
  zone: number;
  /** Lower bound in the set's unit (bpm or W). */
  min: number;
  /** Upper bound; intervals.icu always sends a real number, even for the
   * top zone, so this is never null in practice today. */
  max: number | null;
  seconds: number;
  /** Share of the set's total time, 0–100 with one decimal. */
  pct: number;
}

/** One zone distribution (heart rate or power). */
export interface ZoneSet {
  type: "heartrate" | "power";
  unit: "bpm" | "W";
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
